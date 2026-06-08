/// <reference path="./socket.io-msgpack-parser.d.ts" />
import type { WsMessage, WsResponse, ConnectionState, ReconnectState, WsPushEvent, WsSnapshot, SessionMeta, WsHello, WsPushBatch, WsPushMeta, WsPushStatic } from "./types.js"

export type { WsMessage, WsResponse, ConnectionState, ReconnectState, WsPushEvent, WsSnapshot, SessionMeta, WsHello, WsPushBatch, WsPushMeta, WsPushStatic }

export { createWsFetch, type WsFetchOptions } from "./ws-fetch.js"
export { WS_FETCH_MAPPINGS } from "./ws-fetch-mappings.js"

import { io, Socket } from "socket.io-client"
import msgpackParser from "socket.io-msgpack-parser"

type EventHandler = (event: WsPushEvent) => void
type SnapshotHandler = (snapshot: WsSnapshot) => void
type StateChangeHandler = (state: ConnectionState) => void
type HelloHandler = (protocolVersion: number) => void

/**
 * WebSocket binary protocol client using Socket.IO transport.
 */
export class WsClient {
  private socket: Socket | null = null
  private state: ConnectionState = "disconnected"
  private eventHandlers: EventHandler[] = []
  private snapshotHandlers: SnapshotHandler[] = []
  private stateHandlers: StateChangeHandler[] = []
  private helloHandlers: HelloHandler[] = []
  private metaHandlers: ((meta: WsPushMeta) => void)[] = []
  private staticHandlers: ((data: WsPushStatic) => void)[] = []
  private reconnectState: ReconnectState = { cursors: new Map(), trackedSessions: new Set() }
  private url: string
  private authToken: string

  constructor(config: { url: string; authToken: string }) {
    this.url = config.url
    this.authToken = config.authToken
  }

  get connectionState(): ConnectionState {
    return this.state
  }

  /** Sessions this client is subscribed to for event pre-fetch. */
  get subscribed(): Set<string> {
    return this.reconnectState.trackedSessions
  }

  /** Connect to the WS server. */
  async connect(): Promise<void> {
    if (this.socket?.connected) return
    this.setState("connecting")

    const url = new URL(this.url)
    // Convert ws:// → http:// for Socket.IO initial handshake
    const origin = url.origin.replace(/^ws/, "http")

    this.socket = io(origin, {
      path: "/socket.io/",
      parser: msgpackParser,
      transports: ["websocket", "polling"],
      auth: { token: this.authToken },
      reconnection: true,
      reconnectionDelayMax: 60_000,
      reconnectionAttempts: 10,
      timeout: 5_000,
    })

    return new Promise<void>((resolve, reject) => {
      const sock = this.socket!

      sock.on("connect", () => {
        this.setState("handshake")
      })

      sock.on("hello", (hello: { serverVersion: string; protocolVersion?: number }) => {
        const pv = hello.protocolVersion ?? 1
        for (const h of this.helloHandlers) h(pv)
        this.setState("connected")
        this.catchup().catch(() => {})
        resolve()
      })

      sock.on("push.event", (event: any) => {
        for (const h of this.eventHandlers) h(event as WsPushEvent)
      })

      sock.on("push.batch", (batch: { events: any[] }) => {
        for (const event of batch.events) {
          for (const h of this.eventHandlers) h(event as WsPushEvent)
        }
      })

      sock.on("push.snapshot", (snapshot: any) => {
        for (const h of this.snapshotHandlers) h(snapshot as WsSnapshot)
      })

      sock.on("push.meta", (meta: any) => {
        for (const h of this.metaHandlers) h(meta as WsPushMeta)
      })

      sock.on("push.static", (data: any) => {
        for (const h of this.staticHandlers) h(data as WsPushStatic)
      })

      sock.on("disconnect", (reason: string) => {
        if (reason === "io client disconnect") {
          this.setState("disconnected")
          return
        }
        this.setState("reconnecting")
      })

      sock.on("reconnect_failed", () => {
        this.setState("disconnected")
      })

      sock.on("connect_error", (err: Error) => {
        reject(err)
        this.setState("disconnected")
      })
    })
  }

  /** Disconnect cleanly. */
  close(): void {
    if (this.socket) {
      this.socket.disconnect()
      this.socket = null
    }
    this.setState("disconnected")
  }

  /** Send a request and wait for the response. */
  async request(type: string, payload: Record<string, unknown> = {}, timeout = 60_000): Promise<unknown> {
    const sock = this.socket
    if (!sock?.connected) throw new Error("Not connected")

    const msg = { type, ...payload }

    return new Promise((resolve, reject) => {
      sock.timeout(timeout).emit("rpc", msg, (err: Error | null, response: { ok: boolean; data?: unknown; error?: { code: string; message: string } }) => {
        if (err) {
          reject(new Error(err.message || "Request timeout"))
          return
        }
        if (response?.ok) resolve(response.data)
        else reject(new Error(response?.error?.message ?? "Request failed"))
      })
    })
  }

  /** Send a fire-and-forget message (no response expected). */
  async send(type: string, payload: Record<string, unknown> = {}): Promise<void> {
    const sock = this.socket
    if (!sock?.connected) throw new Error("Not connected")
    sock.emit("send", { type, ...payload })
  }

  /**
   * Subscribe to events for session IDs for pre-fetch filtering.
   * Tracked sessions are re-subscribed on reconnect.
   */
  async subscribe(sessionIDs: string[]): Promise<void> {
    for (const id of sessionIDs) {
      this.reconnectState.trackedSessions.add(id)
      await this.request("session.subscribe", { sessionID: id })
    }
  }

  /**
   * Unsubscribe from events for session IDs.
   */
  async unsubscribe(sessionIDs: string[]): Promise<void> {
    for (const id of sessionIDs) {
      this.reconnectState.trackedSessions.delete(id)
      await this.request("session.unsubscribe", { sessionID: id })
    }
  }

  /** Subscribe to push.event frames. */
  onEvent(handler: EventHandler): () => void {
    this.eventHandlers.push(handler)
    return () => {
      const idx = this.eventHandlers.indexOf(handler)
      if (idx >= 0) this.eventHandlers.splice(idx, 1)
    }
  }

  /** Subscribe to push.snapshot frames. */
  onSnapshot(handler: SnapshotHandler): () => void {
    this.snapshotHandlers.push(handler)
    return () => {
      const idx = this.snapshotHandlers.indexOf(handler)
      if (idx >= 0) this.snapshotHandlers.splice(idx, 1)
    }
  }

  /** Subscribe to connection state changes. */
  onStateChange(handler: StateChangeHandler): () => void {
    this.stateHandlers.push(handler)
    return () => {
      const idx = this.stateHandlers.indexOf(handler)
      if (idx >= 0) this.stateHandlers.splice(idx, 1)
    }
  }

  /** Called on hello with the negotiated protocol version. */
  onHello(handler: HelloHandler): () => void {
    this.helloHandlers.push(handler)
    return () => {
      const idx = this.helloHandlers.indexOf(handler)
      if (idx >= 0) this.helloHandlers.splice(idx, 1)
    }
  }

  /** Subscribe to push.meta session metadata patches. */
  onMeta(handler: (meta: WsPushMeta) => void): () => void {
    this.metaHandlers.push(handler)
    return () => {
      const idx = this.metaHandlers.indexOf(handler)
      if (idx >= 0) this.metaHandlers.splice(idx, 1)
    }
  }

  /** Subscribe to push.static data (config, MCP, providers, projects). */
  onStatic(handler: (data: WsPushStatic) => void): () => void {
    this.staticHandlers.push(handler)
    return () => {
      const idx = this.staticHandlers.indexOf(handler)
      if (idx >= 0) this.staticHandlers.splice(idx, 1)
    }
  }

  get reconnect(): { cursors: Map<string, number>; trackedSessions: Set<string> } {
    return {
      cursors: this.reconnectState.cursors,
      trackedSessions: this.reconnectState.trackedSessions,
    }
  }

  // ---- Private ----

  private setState(state: ConnectionState): void {
    this.state = state
    for (const h of this.stateHandlers) h(state)
  }

  /**
   * Request initial state from the server and re-subscribe tracked sessions.
   * Called on every connect (initial + reconnect).
   */
  private async catchup(): Promise<void> {
    try {
      await this.request("sync.catchup", {}, 30_000)
    } catch {
      // Ignore catchup failures — the connection is still usable
    }

    // Re-subscribe to previously subscribed sessions
    if (this.reconnectState.trackedSessions.size > 0) {
      for (const id of this.reconnectState.trackedSessions) {
        this.send("session.subscribe", { sessionID: id }).catch(() => {})
      }
    }
  }
}

/**
 * Create a new WS client connected to the given server.
 */
export async function createOpencodeWsClient(config: { url: string; authToken: string }): Promise<WsClient> {
  const client = new WsClient(config)
  await client.connect()
  return client
}
