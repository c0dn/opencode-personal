/**
 * Wire-level message types for the WS binary protocol.
 */

export interface WsRequest {
  type: string
  requestID?: string
  idempotencyID?: string
  [key: string]: unknown
}

export interface WsResponse {
  type: "response"
  requestID: string
  ok: boolean
  data?: unknown
  error?: { code: string; message: string }
}

export interface WsHello {
  type: "hello"
  serverVersion: string
  protocolVersion?: number
}

export interface WsPushBatch {
  type: "push.batch"
  events: WsPushEvent[]
}

export interface WsPushMeta {
  type: "push.meta"
  sessions: Record<string, Partial<SessionMeta> & { _deleted?: true } | null>
}

export interface WsPushStatic {
  type: "push.static"
  config?: unknown
  mcp?: unknown
  providers?: unknown
  projects?: unknown
}

export type WsMessage = WsRequest | WsResponse | WsPushEvent | WsPushBatch | WsPushMeta | WsPushStatic | WsHello

export interface WsPushEvent {
  type: "push.event"
  directory?: string
  project?: string
  workspace?: string
  payload: { id: string; type: string; properties: Record<string, unknown> }
}

export interface WsSnapshot {
  type: "push.snapshot"
  page: number
  totalPages: number
  sessions: SessionMeta[]
  config?: unknown
  mcp?: unknown
  providers?: unknown
  projects?: unknown
}

export interface SessionMeta {
  id: string
  parentID?: string
  title: string
  path: string
  projectID: string
  status: "idle" | "busy"
  time: { created: number; updated: number; archived?: number }
  preview: string
  messageCount: number
  model?: string
  agent?: string
  color?: string
}

export type ConnectionState = "disconnected" | "connecting" | "handshake" | "connected" | "reconnecting"

export interface ReconnectState {
  cursors: Map<string, number>
  trackedSessions: Set<string>
}
