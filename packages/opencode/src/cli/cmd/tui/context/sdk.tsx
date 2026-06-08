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
    let ws: WsClient | null = null

    // Mirror createOpencodeClient's default fetch (disables Bun's request
    // timeout) so the WS fallback path behaves exactly like the flag-off path.
    const defaultFetch: any = (req: any) => {
      req.timeout = false
      return fetch(req)
    }
    const restFetch = props.fetch ?? defaultFetch

    function createSDK() {
      // Route REST calls over the shared event WsClient when connected.
      // Falls back to REST transparently when WS is unavailable or the
      // route is unmapped (ws-fetch.ts handles every edge case internally).
      const requestFetch = (createWsFetch({
        getClient: () => ws,
        fallback: (req) => restFetch(req),
      }) as unknown as typeof fetch)
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

    async function startWS() {
      try {
        const password = Flag.OPENCODE_SERVER_PASSWORD ?? ""
        ws = await createOpencodeWsClient({
          url: props.url,
          authToken: btoa(`opencode:${password}`),
        })

        ws.onEvent((event) => {
          handleEvent(event as unknown as GlobalEvent)
        })

        ws.onStateChange((state) => {
          if (state !== "disconnected") return
          ws = null
        })

        // Hydrate workspaces once the socket is connected (parity with the SSE path)
        if (Flag.OPENCODE_EXPERIMENTAL_WORKSPACES) {
          await sdk.sync.start().catch(() => {})
        }
      } catch {
        ws = null
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
      // Networked source: WS for events with Socket.IO transport and native fallback
      await startWS()
    })

    onCleanup(() => {
      abort.abort()
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
