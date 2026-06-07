import { createOpencodeWsClient, WsClient } from "@opencode-ai/sdk/v2/ws"
import type { WsSnapshot, WsPushEvent, SessionMeta } from "@opencode-ai/sdk/v2/ws"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { batch, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { useServer } from "./server"
import type { ServerConnection } from "./server"
import { authTokenFromCredentials } from "@/utils/server"

export function createServerWsContext(server: ServerConnection.Any) {
  const emitter = createGlobalEmitter<{
    [key: string]: WsPushEvent
  }>()

  // Session metadata store — populated by push.snapshot, updated by push.event
  const [store, setStore] = createStore<{
    sessions: SessionMeta[]
    config: unknown
    mcp: unknown
    providers: unknown
    projects: unknown
    ready: boolean
  }>({
    sessions: [],
    config: {},
    mcp: {},
    providers: {},
    projects: [],
    ready: false,
  })

  let ws: WsClient | null = null
  let started = false

  const start = async () => {
    if (started) return
    started = true

    const token = authTokenFromCredentials({
      username: server.http.username,
      password: server.http.password ?? "",
    })

    try {
      ws = await createOpencodeWsClient({
        url: server.http.url.replace(/^http/, "ws"),
        authToken: token,
      })

      ws.onSnapshot((snapshot: WsSnapshot) => {
        batch(() => {
          // Page 1 carries non-session data
          if (snapshot.page === 1) {
            setStore({
              sessions: snapshot.sessions,
              config: snapshot.config ?? store.config,
              mcp: snapshot.mcp ?? store.mcp,
              providers: snapshot.providers ?? store.providers,
              projects: snapshot.projects ?? store.projects,
              ready: true,
            })
          } else {
            setStore("sessions", (prev) => [...prev, ...snapshot.sessions])
          }
        })
      })

      ws.onEvent((event: WsPushEvent) => {
        // Route through existing event emitter — same shape as SSE
        const directory = event.directory ?? "global"
        emitter.emit(directory, event)
      })

      ws.onStateChange((state) => {
        if (state === "connected") {
          // Subscribe to running sessions for pre-fetch
          const running = store.sessions
            .filter((s) => s.status === "busy")
            .map((s) => s.id)
          if (running.length > 0) {
            ws!.send("session.subscribe", { sessionIDs: running }).catch(() => {})
          }
        }
      })
    } catch (error) {
      console.error("[server-ws] Failed to connect", error)
      started = false
    }
  }

  onCleanup(() => {
    ws?.close()
    ws = null
    started = false
  })

  return {
    get url() {
      return server.http.url
    },
    get client() {
      return ws
    },
    event: {
      on: emitter.on.bind(emitter),
      listen: emitter.listen.bind(emitter),
      start,
    },
    store,
    /**
     * Load messages for a session. Returns cached if available, otherwise fetches via WS.
     */
    async loadMessages(sessionID: string): Promise<unknown> {
      if (!ws) throw new Error("WS not connected")
      return ws.request("session.messages", { sessionID, limit: 100 })
    },
    /**
     * Subscribe to a session for pre-fetch of live events.
     */
    subscribe(sessionIDs: string[]): void {
      ws?.send("session.subscribe", { sessionIDs }).catch(() => {})
    },
    /**
     * Unsubscribe from session pre-fetch.
     */
    unsubscribe(sessionIDs: string[]): void {
      ws?.send("session.unsubscribe", { sessionIDs }).catch(() => {})
    },
    /**
     * Send a command/prompt to a session.
     */
    async prompt(sessionID: string, text: string): Promise<unknown> {
      if (!ws) throw new Error("WS not connected")
      return ws.request("session.prompt", {
        sessionID,
        parts: [{ type: "text", text }],
        idempotencyID: crypto.randomUUID(),
      })
    },
    async command(sessionID: string, command: string): Promise<unknown> {
      if (!ws) throw new Error("WS not connected")
      return ws.request("session.command", {
        sessionID,
        command,
        idempotencyID: crypto.randomUUID(),
      })
    },
  }
}

export type ServerWs = ReturnType<typeof createServerWsContext>

export const { use: useServerWs, provider: ServerWsProvider } = createSimpleContext({
  name: "ServerWs",
  init: () => {
    const server = useServer()
    const conn = server.current
    if (!conn) throw new Error("No server available")
    return createServerWsContext(conn)
  },
})
