import type { WsMessage, WsResponse, ConnectionState, ReconnectState, WsPushEvent, WsSnapshot, SessionMeta } from "./types.js"

export type { WsMessage, WsResponse, ConnectionState, ReconnectState, WsPushEvent, WsSnapshot, SessionMeta }

const HEARTBEAT_INTERVAL = 15_000
const HEARTBEAT_TIMEOUT = 45_000
const RECONNECT_BASE_DELAY = 250
const RECONNECT_MAX_DELAY = 60_000
const RECONNECT_MAX_ATTEMPTS = 10
const CONNECT_TIMEOUT = 5_000

type EventHandler = (event: WsPushEvent) => void
type SnapshotHandler = (snapshot: WsSnapshot) => void
type StateChangeHandler = (state: ConnectionState) => void

/**
 * WebSocket binary protocol client.
 */
export class WsClient {
  private ws: WebSocket | null = null
  private state: ConnectionState = "disconnected"
  private pending = new Map<string, PendingRequest>()
  private requestCounter = 0n
  private eventHandlers: EventHandler[] = []
  private snapshotHandlers: SnapshotHandler[] = []
  private stateHandlers: StateChangeHandler[] = []
  private heartbeatTimer: ReturnType<typeof setTimeout> | undefined
  private lastPongAt = 0
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private reconnectState: ReconnectState = { cursors: new Map(), trackedSessions: new Set() }
  private url: string
  private authToken: string
  private brotliPromise: Promise<{ compress(b: Uint8Array, o?: { quality?: number }): Uint8Array; decompress(b: Uint8Array): Uint8Array }> | undefined

  constructor(config: { url: string; authToken: string }) {
    this.url = config.url
    this.authToken = config.authToken
  }

  get connectionState(): ConnectionState {
    return this.state
  }

  /** Connect to the WS server. */
  async connect(): Promise<void> {
    if (this.state === "connected" || this.state === "connecting") return
    this.setState("connecting")

    const url = new URL(this.url)
    url.searchParams.set("auth_token", this.authToken)

    this.ws = new WebSocket(url.toString())
    this.ws.binaryType = "arraybuffer"

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Connection timeout"))
        this.setState("disconnected")
      }, CONNECT_TIMEOUT)

      this.ws!.onopen = () => {
        clearTimeout(timeout)
        this.setState("handshake")
        this.startHeartbeat()
        resolve()
      }

      this.ws!.onmessage = (event) => this.handleMessage(event.data as ArrayBuffer)
      this.ws!.onclose = () => this.handleDisconnect()
      this.ws!.onerror = () => {
        clearTimeout(timeout)
        reject(new Error("WebSocket error"))
        this.setState("disconnected")
      }
    })
  }

  /** Disconnect cleanly. */
  close(): void {
    this.stopHeartbeat()
    this.stopReconnect()
    if (this.ws) {
      this.ws.onclose = null // prevent reconnect
      this.ws.close(1000)
      this.ws = null
    }
    this.setState("disconnected")
  }

  /** Send a request and wait for the response. */
  async request(type: string, payload: Record<string, unknown> = {}, timeout = 60_000): Promise<unknown> {
    const requestID = `req_${String(this.requestCounter++)}`
    const msg = { type, requestID, ...payload }
    const frame = await this.encode(msg)
    this.ws!.send(frame)

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestID)
        reject(new Error(`Request timeout: ${type}`))
      }, timeout)

      this.pending.set(requestID, { resolve, reject, timer, type })
    })
  }

  /** Send a fire-and-forget message (no response expected). */
  async send(type: string, payload: Record<string, unknown> = {}): Promise<void> {
    const msg = { type, ...payload }
    const frame = await this.encode(msg)
    this.ws!.send(frame)
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

  private async handleMessage(data: ArrayBuffer): Promise<void> {
    try {
      const msg = await this.decode(new Uint8Array(data)) as WsMessage
      if (!msg || typeof msg !== "object") return

      if (msg.type === "response") {
        this.handleResponse(msg as WsResponse)
      } else if (msg.type === "push.event") {
        for (const h of this.eventHandlers) h(msg as WsPushEvent)
      } else if (msg.type === "push.snapshot") {
        for (const h of this.snapshotHandlers) h(msg as unknown as WsSnapshot)
      } else if (msg.type === "hello") {
        this.setState("connected")
        this.reconnectAttempts = 0
      } else if (msg.type === "pong") {
        this.lastPongAt = Date.now()
      }
    } catch {
      // Ignore decode errors on individual messages
    }
  }

  private handleResponse(resp: WsResponse): void {
    const pending = this.pending.get(resp.requestID)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(resp.requestID)
    if (resp.ok) pending.resolve(resp.data)
    else pending.reject(new Error(resp.error?.message ?? "Request failed"))
  }

  private handleDisconnect(): void {
    this.stopHeartbeat()
    this.ws = null

    // Reject all pending requests
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(new Error("Connection closed"))
    }
    this.pending.clear()

    if (this.state === "disconnected") return

    this.setState("reconnecting")

    if (this.reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
      this.setState("disconnected")
      return
    }

    const delay = Math.min(RECONNECT_BASE_DELAY * Math.pow(2, this.reconnectAttempts), RECONNECT_MAX_DELAY)
    this.reconnectAttempts++

    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connect()
        // After reconnect, send catchup
        if (this.reconnectState.cursors.size > 0) {
          const cursors: Record<string, number> = {}
          for (const [id, seq] of this.reconnectState.cursors) {
            cursors[id] = seq
          }
          await this.request("sync.catchup", { cursors }, 30_000)
        }
      } catch {
        // Reconnect failed — state machine will retry on next handleDisconnect
      }
    }, delay)
  }

  private startHeartbeat(): void {
    this.lastPongAt = Date.now()
    this.heartbeatTimer = setInterval(async () => {
      if (Date.now() - this.lastPongAt > HEARTBEAT_TIMEOUT) {
        this.ws?.close(1001, "heartbeat timeout")
        return
      }
      try {
        await this.send("ping")
      } catch {
        // ignore
      }
    }, HEARTBEAT_INTERVAL)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = undefined
    }
  }

  private stopReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
  }

  private async encode(value: unknown): Promise<Uint8Array> {
    const { encode } = await import("@msgpack/msgpack")
    const brotli = await this.getBrotli()
    const packed = encode(value)
    return brotli.compress(packed, { quality: 4 })
  }

  private async decode(bytes: Uint8Array): Promise<unknown> {
    const { decode } = await import("@msgpack/msgpack")
    const brotli = await this.getBrotli()
    const decompressed = brotli.decompress(bytes)
    return decode(decompressed)
  }

  private async getBrotli() {
    if (!this.brotliPromise) {
      this.brotliPromise = import("brotli-wasm").then((mod) => mod.default) as Promise<any>
    }
    return this.brotliPromise
  }
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  type: string
}

/**
 * Create a new WS client connected to the given server.
 */
export async function createOpencodeWsClient(config: { url: string; authToken: string }): Promise<WsClient> {
  const client = new WsClient(config)
  await client.connect()
  return client
}
