import type { SessionMessage } from "@opencode-ai/core/session/message"
import { DateTime } from "effect"
import type { Session } from "./session"
import { TranscriptV2Display } from "./transcript-v2-display"

export const PUBLIC_TRANSCRIPT_KIND = "opencode.transcript" as const
export const PUBLIC_TRANSCRIPT_VERSION = 2 as const

export type PublicTranscriptReadiness = { status: "ready" } | { status: string; reason?: string }

export type PublicTranscriptPayloadV2 = {
  kind: typeof PUBLIC_TRANSCRIPT_KIND
  version: typeof PUBLIC_TRANSCRIPT_VERSION
  session: PublicTranscriptSession
  messages: readonly PublicTranscriptMessage[]
}

export type PublicTranscriptSession = {
  id: string
  title: string
  version: string
  agent?: string
  model?: Session.Info["model"]
  time: { created: number; updated: number }
}

export type PublicTranscriptMessage = PublicUserMessage | PublicAssistantMessage | PublicCompactionMessage

export type PublicUserMessage = {
  type: "user"
  id: string
  text: string
  taskRequests?: readonly PublicTaskRequest[]
  time: PublicMessageTime
}

export type PublicTaskRequest = {
  type: "task-request"
  id: string
  prompt: typeof REDACTED_TEXT
  description: typeof REDACTED_TEXT
  agent: string
  model?: SessionMessage.UserTaskRequest["model"]
  command?: typeof REDACTED_TEXT
}

export type PublicAssistantMessage = {
  type: "assistant"
  id: string
  agent: string
  model: SessionMessage.Assistant["model"]
  content: readonly PublicAssistantContent[]
  time: PublicMessageTime
}

export type PublicAssistantContent = PublicAssistantText | PublicAssistantPatch | PublicAssistantTool

export type PublicAssistantText = {
  type: "text"
  id: string
  text: string
}

export type PublicAssistantPatch = {
  type: "patch"
  id: string
  hash: string
  files: readonly string[]
}

export type PublicAssistantTool = {
  type: "tool"
  id: string
  callID: string
  name: string
  title?: typeof REDACTED_TEXT
  provider?: { executed: boolean }
  state: PublicToolState
  time: {
    created: number
    ran?: number
    completed?: number
    pruned?: number
  }
}

export type PublicToolState =
  | { status: "pending"; input: typeof REDACTED_TEXT }
  | { status: "running"; input: typeof REDACTED_TEXT; structured: typeof REDACTED_TEXT; content: readonly PublicToolOutput[] }
  | { status: "completed"; input: typeof REDACTED_TEXT; structured: typeof REDACTED_TEXT; content: readonly PublicToolOutput[] }
  | { status: "error"; input: typeof REDACTED_TEXT; structured: typeof REDACTED_TEXT; content: readonly PublicToolOutput[]; error: typeof REDACTED_TEXT }

export type PublicToolOutput =
  | { type: "text"; text: typeof REDACTED_TEXT }
  | { type: "file"; uri: typeof REDACTED_URI; mime: string; name?: typeof REDACTED_TEXT }

export type PublicCompactionMessage = {
  type: "compaction"
  id: string
  reason: string
  summary: typeof REDACTED_TEXT
  include?: string
  time: PublicMessageTime
}

export type PublicMessageTime = {
  created: number
  completed?: number
}

export class PublicTranscriptNotReadyError extends Error {
  constructor(readiness: PublicTranscriptReadiness | undefined) {
    super(`v2 public transcript payload is not ready: ${readiness?.status ?? "missing"}`)
    this.name = "PublicTranscriptNotReadyError"
  }
}

export class PublicTranscriptUnsupportedError extends Error {
  constructor(kind: string, value: unknown) {
    super(`unsupported v2 public transcript payload ${kind}: ${variantType(value)}`)
    this.name = "PublicTranscriptUnsupportedError"
  }
}

export class PublicTranscriptPayloadValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PublicTranscriptPayloadValidationError"
  }
}

const REDACTED_TEXT = "[redacted]" as const
const REDACTED_URI = "redacted://file" as const

export function toPublicTranscriptPayloadV2(
  session: Session.Info,
  messages: readonly SessionMessage.Message[],
  readiness: PublicTranscriptReadiness | undefined,
): PublicTranscriptPayloadV2 {
  requireReady(readiness)
  return {
    kind: PUBLIC_TRANSCRIPT_KIND,
    version: PUBLIC_TRANSCRIPT_VERSION,
    session: publicSession(session),
    messages: TranscriptV2Display.orderMessages(messages).flatMap(publicMessage),
  }
}

export function requireReady(readiness: PublicTranscriptReadiness | undefined): asserts readiness is { status: "ready" } {
  if (readiness?.status !== "ready") throw new PublicTranscriptNotReadyError(readiness)
}

export function assertPublicTranscriptPayloadV2(value: unknown): asserts value is PublicTranscriptPayloadV2 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PublicTranscriptPayloadValidationError("payload must be an envelope object")
  const payload = value as Record<string, unknown>
  if ("info" in payload) throw new PublicTranscriptPayloadValidationError("legacy transcript payload shape is not supported")
  if (payload.kind !== PUBLIC_TRANSCRIPT_KIND) throw new PublicTranscriptPayloadValidationError("missing or invalid public transcript kind")
  if (payload.version !== PUBLIC_TRANSCRIPT_VERSION) throw new PublicTranscriptPayloadValidationError("unsupported public transcript version")
  if (!payload.session || typeof payload.session !== "object" || Array.isArray(payload.session)) {
    throw new PublicTranscriptPayloadValidationError("public transcript session must be an object")
  }
  if (!Array.isArray(payload.messages)) throw new PublicTranscriptPayloadValidationError("public transcript messages must be an array")
}

function publicSession(session: Session.Info): PublicTranscriptSession {
  return {
    id: session.id,
    title: session.title,
    version: session.version,
    ...(session.agent ? { agent: session.agent } : {}),
    ...(session.model ? { model: session.model } : {}),
    time: { created: session.time.created, updated: session.time.updated },
  }
}

function publicMessage(message: SessionMessage.Message): readonly PublicTranscriptMessage[] {
  assertCanonicalID(message.id)
  switch (message.type) {
    case "user":
      return [
        {
          type: message.type,
          id: message.id,
          text: message.text,
          ...(message.taskRequests ? { taskRequests: message.taskRequests.map(publicTaskRequest) } : {}),
          time: publicMessageTime(message.time),
        },
      ]
    case "assistant":
      return [{ type: message.type, id: message.id, agent: message.agent, model: message.model, content: publicAssistantContent(message.content), time: publicMessageTime(message.time) }]
    case "compaction":
      if (message.include) assertCanonicalID(message.include)
      return [{ type: message.type, id: message.id, reason: message.reason, summary: REDACTED_TEXT, ...(message.include ? { include: message.include } : {}), time: publicMessageTime(message.time) }]
    case "synthetic":
    case "agent-switched":
    case "model-switched":
    case "shell":
      return []
    default:
      return assertNever(message, "message")
  }
}

function publicTaskRequest(request: SessionMessage.UserTaskRequest): PublicTaskRequest {
  assertCanonicalID(request.id)
  return {
    type: request.type,
    id: request.id,
    prompt: REDACTED_TEXT,
    description: REDACTED_TEXT,
    agent: request.agent,
    ...(request.model ? { model: request.model } : {}),
    ...(request.command ? { command: REDACTED_TEXT } : {}),
  }
}

function publicAssistantContent(content: readonly SessionMessage.AssistantContent[]): readonly PublicAssistantContent[] {
  return content.flatMap((item): readonly PublicAssistantContent[] => {
    assertCanonicalID(item.id)
    switch (item.type) {
      case "text":
        return [{ type: item.type, id: item.id, text: item.text }]
      case "patch":
        return [{ type: item.type, id: item.id, hash: item.hash, files: item.files.map((_, index) => `redacted-file-${index + 1}`) }]
      case "tool":
        return [{ type: item.type, id: item.id, callID: item.callID, name: item.name, ...(item.title ? { title: REDACTED_TEXT } : {}), ...(item.provider ? { provider: { executed: item.provider.executed } } : {}), state: publicToolState(item.state), time: publicToolTime(item.time) }]
      case "reasoning":
        return []
      default:
        return assertNever(item, "assistant content")
    }
  })
}

function publicToolState(state: SessionMessage.ToolState): PublicToolState {
  switch (state.status) {
    case "pending":
      return { status: state.status, input: REDACTED_TEXT }
    case "running":
    case "completed":
      return { status: state.status, input: REDACTED_TEXT, structured: REDACTED_TEXT, content: state.content.map(publicToolOutput) }
    case "error":
      return { status: state.status, input: REDACTED_TEXT, structured: REDACTED_TEXT, content: state.content.map(publicToolOutput), error: REDACTED_TEXT }
    default:
      return assertNever(state, "tool state")
  }
}

function publicToolOutput(output: SessionMessage.ToolStateRunning["content"][number]): PublicToolOutput {
  switch (output.type) {
    case "text":
      return { type: output.type, text: REDACTED_TEXT }
    case "file":
      return { type: output.type, uri: REDACTED_URI, mime: output.mime, ...(output.name ? { name: REDACTED_TEXT } : {}) }
    default:
      return assertNever(output, "tool output")
  }
}

function publicMessageTime(time: { created: SessionMessage.Message["time"]["created"]; completed?: SessionMessage.Assistant["time"]["completed"] }): PublicMessageTime {
  return {
    created: DateTime.toEpochMillis(time.created),
    ...(time.completed ? { completed: DateTime.toEpochMillis(time.completed) } : {}),
  }
}

function publicToolTime(time: SessionMessage.AssistantTool["time"]): PublicAssistantTool["time"] {
  return {
    created: DateTime.toEpochMillis(time.created),
    ...(time.ran ? { ran: DateTime.toEpochMillis(time.ran) } : {}),
    ...(time.completed ? { completed: DateTime.toEpochMillis(time.completed) } : {}),
    ...(time.pruned ? { pruned: DateTime.toEpochMillis(time.pruned) } : {}),
  }
}

function assertCanonicalID(id: string) {
  if (/^(?:msg|prt)_/.test(id)) throw new PublicTranscriptUnsupportedError("legacy id", id)
}

function assertNever(value: never, kind: string): never {
  throw new PublicTranscriptUnsupportedError(kind, value)
}

function variantType(value: unknown) {
  if (value && typeof value === "object" && "type" in value) return String((value as { type?: unknown }).type)
  if (value && typeof value === "object" && "status" in value) return String((value as { status?: unknown }).status)
  return typeof value
}

export * as TranscriptV2PublicPayload from "./transcript-v2-public-payload"
