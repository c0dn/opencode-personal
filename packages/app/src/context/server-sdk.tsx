import type { Event } from "@opencode-ai/sdk/v2/client"
import { type ConnectionState, createWsFetch, WsClient } from "@opencode-ai/sdk/v2/ws"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { batch, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
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
  const [state, setState] = createStore({
    connectionState: "disconnected" as ConnectionState,
    serverVersion: undefined as string | undefined,
  })

  const emitter = createGlobalEmitter<{
    [key: string]: Event
  }>()

  type Queued = { directory: string; payload: Event }
  const FLUSH_FRAME_MS = 16

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
        if (!event) continue
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

  let run: Promise<void> | undefined
  let started = false
  let client: WsClient | null = null
  let ws: WsClient | null = null

  // Coalesce events by key, push onto the flush queue, and schedule a frame.
  const enqueue = (directory: string, payload: Event) => {
    const k = key(directory, payload)
    if (k) {
      const i = coalesced.get(k)
      if (i !== undefined) {
        queue[i] = null as any
        if (payload.type === "message.part.updated") {
          const part = payload.properties.part
          staleDeltas.add(deltaKey(directory, part.messageID, part.id))
        }
      }
      coalesced.set(k, queue.length)
    }
    queue.push({ directory, payload })
    schedule()
  }

  // WS-first event source. Socket.IO handles transport fallback (WS → polling),
  // reconnection, and heartbeat natively. We do NOT call ws.subscribe(...) — the
  // web needs every event, and an empty subscription set streams them all.
  const startWs = async () => {
    client?.close()
    const token = authTokenFromCredentials({
      username: server.http.username,
      password: server.http.password ?? "",
    })
    const nextClient = new WsClient({
      url: server.http.url,
      authToken: token,
    })
    client = nextClient
    let initialConnection = true

    nextClient.onEvent((e) => {
      if (e.payload.type === "sync") return
      enqueue(e.directory ?? "global", e.payload as unknown as Event)
    })
    nextClient.onHello((hello) => {
      setState("serverVersion", hello.serverVersion)
    })
    nextClient.onStateChange((connectionState) => {
      setState("connectionState", connectionState)
      if (connectionState === "disconnected") {
        ws = null
        return
      }
      if (connectionState === "connected") {
        if (initialConnection) {
          initialConnection = false
          return
        }
        for (const handler of reconnectHandlers) {
          try { handler() } catch { /* ignore */ }
        }
      }
    })

    const connected = await nextClient.connect().then(() => nextClient).catch((error) => {
      if (!isAbortError(error)) {
        console.error("[global-sdk] ws connect failed", {
          url: server.http.url,
          error,
        })
      }
      return null
    })

    // stop()/cleanup happened while connecting — discard the socket.
    if (!started || abort.signal.aborted) {
      if (client === nextClient) client = null
      nextClient.close()
      return
    }

    if (!connected) {
      return
    }

    ws = connected
  }

  const start = () => {
    if (run) return run
    if (started && ws) return Promise.resolve()
    started = true
    run = startWs().finally(() => {
      run = undefined
    })
    return run
  }

  const stop = () => {
    started = false
    client?.close()
    client = null
    ws = null
  }

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

  const reconnectHandlers: (() => void)[] = []

  return {
    url: server.http.url,
    get connectionState() {
      return state.connectionState
    },
    get serverVersion() {
      return state.serverVersion
    },
    client: sdk,
    event: {
      on: emitter.on.bind(emitter),
      listen: emitter.listen.bind(emitter),
      start,
      onReconnect(handler: () => void) {
        reconnectHandlers.push(handler)
        return () => {
          const idx = reconnectHandlers.indexOf(handler)
          if (idx >= 0) reconnectHandlers.splice(idx, 1)
        }
      },
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
