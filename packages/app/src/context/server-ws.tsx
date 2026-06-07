import { createOpencodeWsClient, WsClient } from "@opencode-ai/sdk/v2/ws"
import type { WsSnapshot, WsPushEvent, WsPushMeta, WsPushStatic, SessionMeta } from "@opencode-ai/sdk/v2/ws"
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
  const subscribedSessions = new Set<string>()

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
          // Page 1 replaces session list; subsequent pages append
          if (snapshot.page === 1) {
            setStore("sessions", snapshot.sessions)
          } else {
            setStore("sessions", (prev) => [...prev, ...snapshot.sessions])
          }
        })
      })

      // ---- Event batching (ported from server-sdk.tsx) ----
      const FLUSH_FRAME_MS = 16
      let eventQueue: WsPushEvent[] = []
      let eventTimer: ReturnType<typeof setTimeout> | undefined
      let eventLast = 0

      const eventKey = (event: WsPushEvent): string | undefined => {
        const dir = event.directory ?? "global"
        const props = event.payload.properties as Record<string, unknown>
        if (event.payload.type === "session.status")
          return `session.status:${dir}:${props.sessionID}`
        if (event.payload.type === "lsp.updated")
          return `lsp.updated:${dir}`
        if (event.payload.type === "message.part.updated") {
          const part = props.part as { messageID: string; id: string }
          return `message.part.updated:${dir}:${part.messageID}:${part.id}`
        }
        return undefined
      }

      const eventFlush = () => {
        if (eventTimer) clearTimeout(eventTimer)
        eventTimer = undefined
        if (eventQueue.length === 0) return

        const events = eventQueue
        eventQueue = []
        eventLast = Date.now()

        batch(() => {
          for (const event of events) {
            const directory = event.directory ?? "global"
            emitter.emit(directory, event)
          }
        })
      }

      const eventSchedule = () => {
        if (eventTimer) return
        const elapsed = Date.now() - eventLast
        eventTimer = setTimeout(eventFlush, Math.max(0, FLUSH_FRAME_MS - elapsed))
      }

      ws.onEvent((event: WsPushEvent) => {
        // Coalesce: same-key events replace previous in queue
        const key = eventKey(event)
        if (key !== undefined) {
          const idx = eventQueue.findIndex((e) => eventKey(e) === key)
          if (idx !== -1) {
            eventQueue[idx] = event
            eventSchedule()
            return
          }
        }
        eventQueue.push(event)
        eventSchedule()
      })

      ws.onMeta((meta: WsPushMeta) => {
        batch(() => {
          for (const [id, patch] of Object.entries(meta.sessions)) {
            if (patch === null) continue
            if (patch._deleted) {
              setStore("sessions", (prev) => prev.filter((s) => s.id !== id))
              continue
            }
            const idx = store.sessions.findIndex((s) => s.id === id)
            if (idx === -1) {
              // New session -- must have enough fields to be a valid SessionMeta
              if (patch.id || patch.title) {
                setStore("sessions", (prev) => [...prev, patch as unknown as SessionMeta])
              }
            } else {
              // Patch existing session
              setStore("sessions", idx, patch as never)
            }
          }
        })
      })

      ws.onStatic((data: WsPushStatic) => {
        batch(() => {
          setStore({
            config: data.config ?? store.config,
            mcp: data.mcp ?? store.mcp,
            providers: data.providers ?? store.providers,
            projects: data.projects ?? store.projects,
            ready: true,
          })
        })
      })

      ws.onStateChange((state) => {
        if (state === "connected") {
          // Subscribe to running sessions for pre-fetch
          const running = store.sessions
            .filter((s) => s.status === "busy")
            .map((s) => s.id)
          if (running.length > 0) {
            ws!.subscribe(running).catch(() => {})
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
     * Load messages for a session. Auto-subscribes to events for this session.
     * Returns cached if available, otherwise fetches via WS.
     */
    async loadMessages(sessionID: string): Promise<unknown> {
      if (!ws) throw new Error("WS not connected")
      if (!subscribedSessions.has(sessionID)) {
        subscribedSessions.add(sessionID)
        ws.subscribe([sessionID]).catch(() => {})
      }
      return ws.request("session.messages", { sessionID, limit: 100 })
    },
    /**
     * Activate a session tab — subscribes and unsubscribes from the previous.
     * Call this when the user switches to a different session.
     */
    activate(sessionID: string | null): void {
      if (!ws) return
      // Unsubscribe from all currently subscribed sessions
      const toRemove = [...subscribedSessions]
      if (sessionID) {
        // Keep only the active session
        const idx = toRemove.indexOf(sessionID)
        if (idx >= 0) toRemove.splice(idx, 1)
        if (!subscribedSessions.has(sessionID)) {
          subscribedSessions.add(sessionID)
          ws.subscribe([sessionID]).catch(() => {})
        }
      }
      if (toRemove.length > 0) {
        for (const id of toRemove) subscribedSessions.delete(id)
        ws.unsubscribe(toRemove).catch(() => {})
      }
    },
    /**
     * Subscribe to a session for pre-fetch of live events.
     */
    subscribe(sessionIDs: string[]): void {
      for (const id of sessionIDs) subscribedSessions.add(id)
      ws?.subscribe(sessionIDs).catch(() => {})
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
