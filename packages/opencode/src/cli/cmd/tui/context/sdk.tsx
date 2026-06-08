import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import { createOpencodeWsClient, createWsFetch, WsClient } from "@opencode-ai/sdk/v2/ws"
import { createSimpleContext } from "./helper"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { Flag } from "@opencode-ai/core/flag/flag"
import { batch, onCleanup, onMount } from "solid-js"

export type EventSource = {
  subscribe: (handler: (event: GlobalEvent) => void) => Promise<() => void>
}

export const { use: useSDK, provider: SDKProvider } = createSimpleContext({
  name: "SDK",
  init: (props: {
    url: string
    directory?: string
    fetch?: typeof fetch
    headers?: RequestInit["headers"]
    events?: EventSource
  }) => {
    const abort = new AbortController()
    let sse: AbortController | undefined
    let ws: WsClient | null = null

    // Mirror createOpencodeClient's default fetch (disables Bun's request
    // timeout) so the WS fallback path behaves exactly like the flag-off path.
    const defaultFetch: any = (req: any) => {
      req.timeout = false
      return fetch(req)
    }
    const restFetch = props.fetch ?? defaultFetch

    function createSDK() {
      const requestFetch: typeof fetch | undefined = Flag.OPENCODE_EXPERIMENTAL_WS_REQUESTS
        ? (createWsFetch({
            getClient: () => ws,
            fallback: (req) => restFetch(req),
            enabled: () => true,
          }) as unknown as typeof fetch)
        : props.fetch
      return createOpencodeClient({
        baseUrl: props.url,
        signal: abort.signal,
        directory: props.directory,
        fetch: requestFetch,
        headers: props.headers,
      })
    }

    let sdk = createSDK()

    const emitter = createGlobalEmitter<{
      event: GlobalEvent
    }>()

    let queue: GlobalEvent[] = []
    let timer: Timer | undefined
    let last = 0
    const retryDelay = 1000
    const maxRetryDelay = 30000

    const flush = () => {
      if (queue.length === 0) return
      const events = queue
      queue = []
      timer = undefined
      last = Date.now()
      batch(() => {
        for (const event of events) {
          emitter.emit("event", event)
        }
      })
    }

    const handleEvent = (event: GlobalEvent) => {
      queue.push(event)
      const elapsed = Date.now() - last
      if (timer) return
      if (elapsed < 16) {
        timer = setTimeout(flush, 16)
        return
      }
      flush()
    }

    function startSSE() {
      sse?.abort()
      const ctrl = new AbortController()
      sse = ctrl
      ;(async () => {
        let attempt = 0
        while (true) {
          if (abort.signal.aborted || ctrl.signal.aborted) break

          const events = await sdk.global.event({
            signal: ctrl.signal,
            sseMaxRetryAttempts: 0,
          })

          if (Flag.OPENCODE_EXPERIMENTAL_WORKSPACES) {
            await sdk.sync.start().catch(() => {})
          }

          for await (const event of events.stream) {
            if (ctrl.signal.aborted) break
            handleEvent(event)
          }

          if (timer) clearTimeout(timer)
          if (queue.length > 0) flush()
          attempt += 1
          if (abort.signal.aborted || ctrl.signal.aborted) break

          const backoff = Math.min(retryDelay * 2 ** (attempt - 1), maxRetryDelay)
          await new Promise((resolve) => setTimeout(resolve, backoff))
        }
      })().catch(() => {})
    }

    async function startWS() {
      try {
        const password = Flag.OPENCODE_SERVER_PASSWORD ?? ""
        const wsUrl = props.url.replace(/^http/, "ws")
        const authUrl = new URL(wsUrl)
        authUrl.searchParams.set("auth_token", btoa(`opencode:${password}`))

        ws = await createOpencodeWsClient({
          url: authUrl.toString(),
          authToken: btoa(`opencode:${password}`),
        })

        ws.onEvent((event) => {
          handleEvent(event as unknown as GlobalEvent)
        })

        ws.onStateChange((state) => {
          // WsClient only reports "disconnected" after exhausting its own
          // reconnect attempts. Treat that as WS being dead and fall back to SSE
          // so the TUI keeps receiving live updates (parity with the web path).
          if (state !== "disconnected") return
          if (abort.signal.aborted) return
          if (sse && !sse.signal.aborted) return
          ws = null
          startSSE()
        })

        // Hydrate workspaces once the socket is connected (parity with the SSE path)
        if (Flag.OPENCODE_EXPERIMENTAL_WORKSPACES) {
          await sdk.sync.start().catch(() => {})
        }
      } catch {
        // WS connect failed — fall back to SSE
        ws = null
        startSSE()
      }
    }

    onMount(async () => {
      if (props.events) {
        const unsub = await props.events.subscribe(handleEvent)
        onCleanup(unsub)
        if (Flag.OPENCODE_EXPERIMENTAL_WORKSPACES) {
          await sdk.sync.start().catch(() => {})
        }
        return
      }
      // Networked source: prefer WS for events, fall back to SSE on failure
      await startWS()
    })

    onCleanup(() => {
      abort.abort()
      sse?.abort()
      ws?.close()
      if (timer) clearTimeout(timer)
    })

    return {
      get client() {
        return sdk
      },
      get ws() {
        return ws
      },
      directory: props.directory,
      event: emitter,
      fetch: props.fetch ?? fetch,
      url: props.url,
    }
  },
})
