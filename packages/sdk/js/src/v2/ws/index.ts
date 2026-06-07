import type { WsMessage, WsResponse, ConnectionState, ReconnectState, WsPushEvent, WsSnapshot, SessionMeta, WsHello, WsPushBatch, WsPushMeta, WsPushStatic } from "./types.js"

export type { WsMessage, WsResponse, ConnectionState, ReconnectState, WsPushEvent, WsSnapshot, SessionMeta, WsHello, WsPushBatch, WsPushMeta, WsPushStatic }

const HEARTBEAT_INTERVAL = 15_000
const HEARTBEAT_TIMEOUT = 45_000
const RECONNECT_BASE_DELAY = 250
const RECONNECT_MAX_DELAY = 60_000
const RECONNECT_MAX_ATTEMPTS = 10
const CONNECT_TIMEOUT = 5_000

type EventHandler = (event: WsPushEvent) => void
type SnapshotHandler = (snapshot: WsSnapshot) => void
type StateChangeHandler = (state: ConnectionState) => void
type HelloHandler = (protocolVersion: number) => void

/**
 * WebSocket binary protocol client.
 */
export class WsClient {
  private ws: WebSocket | null = null
  private state: ConnectionState = "disconnected"
  private pending = new Map<string, PendingRequest>()
  private retryQueue: PendingRequest[] = []
  private requestCounter = 0n
  private eventHandlers: EventHandler[] = []
  private snapshotHandlers: SnapshotHandler[] = []
  private stateHandlers: StateChangeHandler[] = []
  private helloHandlers: HelloHandler[] = []
  private metaHandlers: ((meta: WsPushMeta) => void)[] = []
  private staticHandlers: ((data: WsPushStatic) => void)[] = []
  private heartbeatTimer: ReturnType<typeof setTimeout> | undefined
  private protocolVersion = 1
  private lastPongAt = 0
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private reconnectState: ReconnectState = { cursors: new Map(), trackedSessions: new Set() }
  private lastStaticHash: string | undefined
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

  /** Sessions this client is subscribed to for event pre-fetch. */
  get subscribed(): Set<string> {
    return this.reconnectState.trackedSessions
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
    // Reject all pending and queued requests
    const err = new Error("Connection closed")
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    this.pending.clear()
    for (const p of this.retryQueue) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    this.retryQueue = []
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

      this.pending.set(requestID, { resolve, reject, timer, type, payload, timeoutMs: timeout })
    })
  }

  /** Send a fire-and-forget message (no response expected). */
  async send(type: string, payload: Record<string, unknown> = {}): Promise<void> {
    const msg = { type, ...payload }
    const frame = await this.encode(msg)
    this.ws!.send(frame)
  }

  /**
   * Subscribe to events for session IDs for pre-fetch filtering.
   * Tracked sessions are re-subscribed on reconnect.
   */
  async subscribe(sessionIDs: string[]): Promise<void> {
    for (const id of sessionIDs) this.reconnectState.trackedSessions.add(id)
    await this.send("session.subscribe", { sessionIDs })
  }

  /**
   * Unsubscribe from events for session IDs.
   */
  async unsubscribe(sessionIDs: string[]): Promise<void> {
    for (const id of sessionIDs) this.reconnectState.trackedSessions.delete(id)
    await this.send("session.unsubscribe", { sessionIDs })
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

  private async handleMessage(data: ArrayBuffer): Promise<void> {
    try {
      const msg = await this.decode(new Uint8Array(data)) as WsMessage
      if (!msg || typeof msg !== "object") return

      if (msg.type === "response") {
        this.handleResponse(msg as WsResponse)
      } else if (msg.type === "push.event") {
        for (const h of this.eventHandlers) h(msg as WsPushEvent)
      } else if (msg.type === "push.batch") {
        const batch = msg as WsPushBatch
        for (const event of batch.events) {
          for (const h of this.eventHandlers) h(event)
        }
      } else if (msg.type === "push.snapshot") {
        for (const h of this.snapshotHandlers) h(msg as unknown as WsSnapshot)
      } else if (msg.type === "push.meta") {
        for (const h of this.metaHandlers) h(msg as WsPushMeta)
      } else if (msg.type === "push.static") {
        for (const h of this.staticHandlers) h(msg as WsPushStatic)
      } else if (msg.type === "hello") {
        const hello = msg as WsHello
        this.protocolVersion = hello.protocolVersion ?? 1
        for (const h of this.helloHandlers) h(this.protocolVersion)
        this.setState("connected")
        this.reconnectAttempts = 0
        // Fetch initial state on every connect (initial + reconnect)
        this.catchup().catch(() => {})
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

    // Move pending requests to retry queue — don't reject, they replay on reconnect
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer)
      this.retryQueue.push(pending)
    }
    this.pending.clear()

    if (this.state === "disconnected") return

    this.setState("reconnecting")

    if (this.reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
      // Max attempts reached — reject remaining queued requests
      const err = new Error("Max reconnect attempts reached")
      for (const p of this.retryQueue) p.reject(err)
      this.retryQueue = []
      this.setState("disconnected")
      return
    }

    const delay = Math.min(RECONNECT_BASE_DELAY * Math.pow(2, this.reconnectAttempts), RECONNECT_MAX_DELAY)
    this.reconnectAttempts++

    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connect()
      } catch {
        // Reconnect failed — state machine will retry on next handleDisconnect
      }
    }, delay)
  }

  /**
   * Request initial state from the server — static data (if version changed) +
   * session snapshot. Called on every connect (initial + reconnect).
   */
  private async catchup(): Promise<void> {
    const payload: Record<string, unknown> = {}
    if (this.lastStaticHash) payload.staticHash = this.lastStaticHash

    const result = await this.request("sync.catchup", payload, 30_000) as Record<string, unknown> | undefined
    if (result?.staticHash) this.lastStaticHash = String(result.staticHash)

    // Re-subscribe to previously subscribed sessions
    if (this.reconnectState.trackedSessions.size > 0) {
      const ids = [...this.reconnectState.trackedSessions]
      await this.send("session.subscribe", { sessionIDs: ids })
    }

    // Replay queued requests that were in-flight at disconnect
    if (this.retryQueue.length > 0) {
      const queued = this.retryQueue
      this.retryQueue = []
      for (const pending of queued) {
        this.request(pending.type, pending.payload, pending.timeoutMs)
          .then(pending.resolve)
          .catch(pending.reject)
      }
    }
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
    const packed = encode(value)

    // Tiny frames: skip Brotli (overhead > savings)
    if (packed.length < 64) {
      const frame = new Uint8Array(packed.length + 1)
      frame[0] = 0x00 // raw marker
      frame.set(packed, 1)
      return frame
    }

    const brotli = await this.getBrotli()
    const compressed = brotli.compress(packed, { quality: 4 })
    const frame = new Uint8Array(compressed.length + 1)
    frame[0] = 0x01 // Brotli marker
    frame.set(compressed, 1)
    return frame
  }

  private async decode(bytes: Uint8Array): Promise<unknown> {
    const { decode } = await import("@msgpack/msgpack")
    const marker = bytes[0]

    // Raw marker: skip decompression
    if (marker === 0x00) {
      return decode(bytes.slice(1))
    }

    // Brotli marker (0x01) or legacy (no marker): decompress
    const compressed = marker === 0x01 ? bytes.slice(1) : bytes
    const brotli = await this.getBrotli()
    const decompressed = brotli.decompress(compressed)
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
  payload: Record<string, unknown>
  timeoutMs: number
}

/**
 * Create a new WS client connected to the given server.
 */
export async function createOpencodeWsClient(config: { url: string; authToken: string }): Promise<WsClient> {
  const client = new WsClient(config)
  await client.connect()
  return client
}
