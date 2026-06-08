import type { Event } from "@opencode-ai/sdk/v2/client"
import { createOpencodeWsClient, createWsFetch, WsClient } from "@opencode-ai/sdk/v2/ws"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { makeEventListener } from "@solid-primitives/event-listener"
import { batch, onCleanup, onMount } from "solid-js"
import { authTokenFromCredentials, createSdkForServer } from "@/utils/server"
import { useLanguage } from "./language"
import { usePlatform } from "./platform"
import { ServerConnection, useServer } from "./server"
import { createRefCountMap } from "@/utils/refcount"
import { useGlobal } from "./global"

const isAbortError = (error: unknown) =>
  error !== null && typeof error === "object" && "name" in error && error.name === "AbortError"

export function createServerSdkContext(server: ServerConnection.Any) {
  const platform = usePlatform()
  const abort = new AbortController()

  const eventFetch = (() => {
    if (!platform.fetch || !server) return
    try {
      const url = new URL(server.http.url)
      const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1"
      if (url.protocol === "http:" && !loopback) return platform.fetch
    } catch {
      return
    }
  })()

  const eventSdk = createSdkForServer({
    signal: abort.signal,
    fetch: eventFetch,
    server: server.http,
  })
  const emitter = createGlobalEmitter<{
    [key: string]: Event
  }>()

  type Queued = { directory: string; payload: Event }
  const FLUSH_FRAME_MS = 16
  const STREAM_YIELD_MS = 8
  const RECONNECT_DELAY_MS = 250

  let queue: Queued[] = []
  let buffer: Queued[] = []
  const coalesced = new Map<string, number>()
  const staleDeltas = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let last = 0

  const deltaKey = (directory: string, messageID: string, partID: string) => `${directory}:${messageID}:${partID}`

  const key = (directory: string, payload: Event) => {
    if (payload.type === "session.status") return `session.status:${directory}:${payload.properties.sessionID}`
    if (payload.type === "lsp.updated") return `lsp.updated:${directory}`
    if (payload.type === "message.part.updated") {
      const part = payload.properties.part
      return `message.part.updated:${directory}:${part.messageID}:${part.id}`
    }
  }

  const flush = () => {
    if (timer) clearTimeout(timer)
    timer = undefined

    if (queue.length === 0) return

    const events = queue
    const skip = staleDeltas.size > 0 ? new Set(staleDeltas) : undefined
    queue = buffer
    buffer = events
    queue.length = 0
    coalesced.clear()
    staleDeltas.clear()

    last = Date.now()
    batch(() => {
      for (const event of events) {
        if (skip && event.payload.type === "message.part.delta") {
          const props = event.payload.properties
          if (skip.has(deltaKey(event.directory, props.messageID, props.partID))) continue
        }
        emitter.emit(event.directory, event.payload)
      }
    })

    buffer.length = 0
  }

  const schedule = () => {
    if (timer) return
    const elapsed = Date.now() - last
    timer = setTimeout(flush, Math.max(0, FLUSH_FRAME_MS - elapsed))
  }

  let streamErrorLogged = false
  const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
  const aborted = isAbortError

  let attempt: AbortController | undefined
  let run: Promise<void> | undefined
  let started = false
  let ws: WsClient | null = null
  let sse: Promise<void> | undefined
  const HEARTBEAT_TIMEOUT_MS = 15_000
  let lastEventAt = Date.now()
  let heartbeat: ReturnType<typeof setTimeout> | undefined
  const resetHeartbeat = () => {
    lastEventAt = Date.now()
    if (heartbeat) clearTimeout(heartbeat)
    heartbeat = setTimeout(() => {
      attempt?.abort()
    }, HEARTBEAT_TIMEOUT_MS)
  }
  const clearHeartbeat = () => {
    if (!heartbeat) return
    clearTimeout(heartbeat)
    heartbeat = undefined
  }

  // Shared per-event handling for both transports: coalesce by key, push onto
  // the flush queue, and schedule a frame. This is the single source of the
  // coalescing logic so the WS and SSE paths can never drift apart.
  const enqueue = (directory: string, payload: Event) => {
    const k = key(directory, payload)
    if (k) {
      const i = coalesced.get(k)
      if (i !== undefined) {
        queue[i] = { directory, payload }
        if (payload.type === "message.part.updated") {
          const part = payload.properties.part
          staleDeltas.add(deltaKey(directory, part.messageID, part.id))
        }
        return
      }
      coalesced.set(k, queue.length)
    }
    queue.push({ directory, payload })
    schedule()
  }

  // SSE fallback loop (the original transport). Idempotent via the `sse` guard so
  // a WS failure can only ever spin up a single SSE loop.
  const startSse = () => {
    if (sse) return sse
    sse = (async () => {
      // oxlint-disable-next-line no-unmodified-loop-condition -- `started` is set to false by stop() which also aborts; both flags are checked to allow graceful exit
      while (!abort.signal.aborted && started) {
        attempt = new AbortController()
        lastEventAt = Date.now()
        const onAbort = () => {
          attempt?.abort()
        }
        abort.signal.addEventListener("abort", onAbort)
        try {
          const events = await eventSdk.global.event({
            signal: attempt.signal,
            onSseError: (error) => {
              if (aborted(error)) return
              if (streamErrorLogged) return
              streamErrorLogged = true
              console.error("[global-sdk] event stream error", {
                url: server.http.url,
                fetch: eventFetch ? "platform" : "webview",
                error,
              })
            },
          })
          let yielded = Date.now()
          resetHeartbeat()
          for await (const event of events.stream) {
            resetHeartbeat()
            streamErrorLogged = false
            const directory = event.directory ?? "global"
            if (event.payload.type === "sync") continue
            enqueue(directory, event.payload as Event)

            if (Date.now() - yielded < STREAM_YIELD_MS) continue
            yielded = Date.now()
            await wait(0)
          }
        } catch (error) {
          if (!aborted(error) && !streamErrorLogged) {
            streamErrorLogged = true
            console.error("[global-sdk] event stream failed", {
              url: server.http.url,
              fetch: eventFetch ? "platform" : "webview",
              error,
            })
          }
        } finally {
          abort.signal.removeEventListener("abort", onAbort)
          attempt = undefined
          clearHeartbeat()
        }

        if (abort.signal.aborted || !started) return
        await wait(RECONNECT_DELAY_MS)
      }
    })().finally(() => {
      sse = undefined
      flush()
    })
    return sse
  }

  // WS-first event source. The WsClient owns its own heartbeat + reconnect, so
  // the SSE heartbeat stays idle while WS is active. Fall back to SSE if the
  // socket fails to open or the client permanently gives up reconnecting. We do
  // NOT call ws.subscribe(...) — the web needs every event, and an empty
  // subscription set streams them all.
  const startWs = async () => {
    const token = authTokenFromCredentials({
      username: server.http.username,
      password: server.http.password ?? "",
    })
    const client = await createOpencodeWsClient({
      url: server.http.url.replace(/^http/, "ws"),
      authToken: token,
    }).catch((error) => {
      if (!aborted(error)) {
        console.error("[global-sdk] ws connect failed, falling back to sse", {
          url: server.http.url,
          error,
        })
      }
      return null
    })

    // stop()/cleanup happened while connecting — discard the socket.
    if (!started || abort.signal.aborted) {
      client?.close()
      return
    }

    if (!client) {
      await startSse()
      return
    }

    ws = client
    client.onEvent((e) => {
      if (e.payload.type === "sync") return
      enqueue(e.directory ?? "global", e.payload as unknown as Event)
    })
    client.onStateChange((state) => {
      // The WsClient only reports "disconnected" after exhausting its own
      // reconnect attempts (or when we close it during stop). A self-initiated
      // disconnect while still started means WS is dead → fall back to SSE.
      if (state !== "disconnected") return
      if (!started || abort.signal.aborted) return
      ws = null
      void startSse()
    })
  }

  const start = () => {
    if (started) return run
    started = true
    run = startWs().finally(() => {
      run = undefined
    })
    return run
  }

  const stop = () => {
    started = false
    attempt?.abort()
    clearHeartbeat()
    ws?.close()
    ws = null
  }

  onMount(() => {
    makeEventListener(document, "visibilitychange", () => {
      if (document.visibilityState !== "visible") return
      if (!started) return
      if (Date.now() - lastEventAt < HEARTBEAT_TIMEOUT_MS) return
      attempt?.abort()
    })
  })

  onCleanup(() => {
    stop()
    abort.abort()
    flush()
  })

  // Route REST calls over the shared event WsClient when connected.
  // Falls back to REST transparently when WS is unavailable or the
  // route is unmapped (ws-fetch.ts handles every edge case internally).
  const wsRequestFetch = (createWsFetch({
    getClient: () => ws,
    fallback: (req) => {
      if (platform.fetch) return platform.fetch(req)
      ;(req as any).timeout = false
      return fetch(req)
    },
  }) as unknown as typeof fetch)

  const sdk = createSdkForServer({
    server: server.http,
    fetch: wsRequestFetch,
    throwOnError: true,
  })

  return {
    url: server.http.url,
    client: sdk,
    event: {
      on: emitter.on.bind(emitter),
      listen: emitter.listen.bind(emitter),
      start,
    },
    createClient(opts: Omit<Parameters<typeof createSdkForServer>[0], "server" | "fetch">) {
      return createSdkForServer({
        server: server.http,
        fetch: platform.fetch,
        ...opts,
      })
    },
  }
}

export type ServerSDK = ReturnType<typeof createServerSdkContext>

export const { use: useServerSDK, provider: ServerSDKProvider } = createSimpleContext({
  name: "ServerSDK",
  init: (props: { server?: ServerConnection.Any }) => {
    const global = useGlobal()
    const language = useLanguage()
    const server = useServer()

    const conn = props.server ?? server.current
    if (!conn) throw new Error(language.t("error.serverSDK.noServerAvailable"))

    const ctx = global.createServerCtx(conn)
    return Object.assign(ctx.sdk, {
      createDirSdkContext: createRefCountMap((dir) => createDirSdkContext(dir, ctx.sdk)),
    })
  },
})

type SDKEventMap = {
  [key in Event["type"]]: Extract<Event, { type: key }>
}

function createDirSdkContext(directory: string, serverSDK: ServerSDK) {
  const client = serverSDK.createClient({
    directory,
    throwOnError: true,
  })

  const emitter = createGlobalEmitter<SDKEventMap>()

  const unsub = serverSDK.event.on(directory, (event) => {
    emitter.emit(event.type, event)
  })
  onCleanup(unsub)

  return {
    directory,
    client,
    event: emitter,
    get url() {
      return serverSDK.url
    },
    createClient(opts: Parameters<typeof serverSDK.createClient>[0]) {
      return serverSDK.createClient(opts)
    },
  }
}
