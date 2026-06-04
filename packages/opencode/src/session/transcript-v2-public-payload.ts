import { SessionMessage } from "@opencode-ai/core/session/message"
import { ToolOutput } from "@opencode-ai/core/tool-output"
import { DateTime, Schema } from "effect"
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
const REDACTED_RECORD = { redacted: true } as const
const encodeImportMessage = Schema.encodeSync(SessionMessage.Message)

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
  const payload = requireObject(value, "payload")
  rejectLegacyEnvelope(payload)
  requireKeys(payload, ["kind", "version", "session", "messages"], "payload")
  if (payload.kind !== PUBLIC_TRANSCRIPT_KIND) throw new PublicTranscriptPayloadValidationError("missing or invalid public transcript kind")
  if (payload.version !== PUBLIC_TRANSCRIPT_VERSION) throw new PublicTranscriptPayloadValidationError("unsupported public transcript version")
  validatePublicSession(payload.session)
  if (!Array.isArray(payload.messages)) throw new PublicTranscriptPayloadValidationError("public transcript messages must be an array")
  payload.messages.forEach(validatePublicMessage)
}

export function publicTranscriptPayloadV2ToCanonicalMessages(payload: PublicTranscriptPayloadV2): SessionMessage.Message[] {
  assertPublicTranscriptPayloadV2(payload)
  assertUniqueMessageIDs(payload.messages)
  return payload.messages.map(publicMessageToCanonical).map((message) => {
    encodeImportMessage(message)
    return message
  })
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

function publicMessageToCanonical(message: PublicTranscriptMessage): SessionMessage.Message {
  switch (message.type) {
    case "user":
      return new SessionMessage.User({
        type: "user",
        id: SessionMessage.ID.make(message.id),
        text: message.text,
        files: [],
        agents: [],
        references: [],
        ...(message.taskRequests ? { taskRequests: message.taskRequests.map(publicTaskRequestToCanonical) } : {}),
        time: dateTime(message.time),
      })
    case "assistant":
      return new SessionMessage.Assistant({
        type: "assistant",
        id: SessionMessage.ID.make(message.id),
        agent: message.agent,
        model: message.model,
        content: message.content.map(publicAssistantContentToCanonical),
        time: dateTime(message.time),
      })
    case "compaction":
      assertSupportedCompactionReason(message.reason)
      return new SessionMessage.Compaction({
        type: "compaction",
        id: SessionMessage.ID.make(message.id),
        reason: message.reason,
        summary: message.summary,
        ...(message.include ? { include: message.include } : {}),
        time: { created: DateTime.makeUnsafe(message.time.created) },
      })
    default:
      return assertNever(message, "public message")
  }
}

function publicTaskRequestToCanonical(request: PublicTaskRequest): SessionMessage.UserTaskRequest {
  return new SessionMessage.UserTaskRequest({
    type: "task-request",
    id: SessionMessage.ID.make(request.id),
    prompt: request.prompt,
    description: request.description,
    agent: request.agent,
    ...(request.model ? { model: request.model } : {}),
    ...(request.command ? { command: request.command } : {}),
  })
}

function publicAssistantContentToCanonical(content: PublicAssistantContent): SessionMessage.AssistantContent {
  switch (content.type) {
    case "text":
      return new SessionMessage.AssistantText({ type: "text", id: SessionMessage.ID.make(content.id), text: content.text })
    case "patch":
      return new SessionMessage.AssistantPatch({ type: "patch", id: SessionMessage.ID.make(content.id), hash: content.hash, files: [...content.files] })
    case "tool":
      return new SessionMessage.AssistantTool({
        type: "tool",
        id: SessionMessage.ID.make(content.id),
        callID: content.callID,
        name: content.name,
        ...(content.title ? { title: content.title } : {}),
        ...(content.provider ? { provider: content.provider } : {}),
        state: publicToolStateToCanonical(content.state),
        time: publicToolTimeToCanonical(content.time),
      })
    default:
      return assertNever(content, "public assistant content")
  }
}

function publicToolStateToCanonical(state: PublicToolState): SessionMessage.ToolState {
  switch (state.status) {
    case "pending":
      return new SessionMessage.ToolStatePending({ status: "pending", input: state.input })
    case "running":
      return new SessionMessage.ToolStateRunning({ status: "running", input: REDACTED_RECORD, structured: REDACTED_RECORD, content: state.content.map(publicToolOutputToCanonical) })
    case "completed":
      return new SessionMessage.ToolStateCompleted({ status: "completed", input: REDACTED_RECORD, structured: REDACTED_RECORD, content: state.content.map(publicToolOutputToCanonical) })
    case "error":
      return new SessionMessage.ToolStateError({ status: "error", input: REDACTED_RECORD, structured: REDACTED_RECORD, content: state.content.map(publicToolOutputToCanonical), error: { type: "unknown", message: state.error } })
    default:
      return assertNever(state, "public tool state")
  }
}

function publicToolOutputToCanonical(output: PublicToolOutput): SessionMessage.ToolStateRunning["content"][number] {
  switch (output.type) {
    case "text":
      return new ToolOutput.TextContent({ type: "text", text: output.text })
    case "file":
      return new ToolOutput.FileContent({ type: "file", uri: output.uri, mime: output.mime, ...(output.name ? { name: output.name } : {}) })
    default:
      return assertNever(output, "public tool output")
  }
}

function dateTime(time: PublicMessageTime): SessionMessage.User["time"] {
  return {
    created: DateTime.makeUnsafe(time.created),
    ...(time.completed !== undefined ? { completed: DateTime.makeUnsafe(time.completed) } : {}),
  }
}

function publicToolTimeToCanonical(time: PublicAssistantTool["time"]): SessionMessage.AssistantTool["time"] {
  return {
    created: DateTime.makeUnsafe(time.created),
    ...(time.ran !== undefined ? { ran: DateTime.makeUnsafe(time.ran) } : {}),
    ...(time.completed !== undefined ? { completed: DateTime.makeUnsafe(time.completed) } : {}),
    ...(time.pruned !== undefined ? { pruned: DateTime.makeUnsafe(time.pruned) } : {}),
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

function validatePublicSession(value: unknown) {
  const session = requireObject(value, "public transcript session")
  requireKeys(session, ["id", "title", "version", "agent", "model", "time"], "public transcript session")
  requirePublicID(session.id, "session id")
  requireString(session.title, "session title")
  requireString(session.version, "session version")
  requireOptionalString(session.agent, "session agent")
  validateOptionalModel(session.model, "session model")
  const time = requireObject(session.time, "session time")
  requireKeys(time, ["created", "updated"], "session time")
  requireFiniteNumber(time.created, "session time.created")
  requireFiniteNumber(time.updated, "session time.updated")
}

function validatePublicMessage(value: unknown) {
  const message = requireObject(value, "public transcript message")
  switch (message.type) {
    case "user":
      return validatePublicUserMessage(message)
    case "assistant":
      return validatePublicAssistantMessage(message)
    case "compaction":
      return validatePublicCompactionMessage(message)
    default:
      throw new PublicTranscriptPayloadValidationError(`unsupported public transcript message type: ${String(message.type)}`)
  }
}

function validatePublicUserMessage(message: Record<string, unknown>) {
  requireKeys(message, ["type", "id", "text", "taskRequests", "time"], "public user message")
  requirePublicID(message.id, "message id")
  requireString(message.text, "user text")
  validateMessageTime(message.time, "user time")
  if (message.taskRequests !== undefined) {
    if (!Array.isArray(message.taskRequests)) throw new PublicTranscriptPayloadValidationError("task requests must be an array")
    message.taskRequests.forEach(validateTaskRequest)
  }
}

function validateTaskRequest(value: unknown) {
  const request = requireObject(value, "task request")
  requireKeys(request, ["type", "id", "prompt", "description", "agent", "model", "command"], "task request")
  if (request.type !== "task-request") throw new PublicTranscriptPayloadValidationError("invalid task request type")
  requirePublicID(request.id, "task request id")
  requireRedactedText(request.prompt, "task request prompt")
  requireRedactedText(request.description, "task request description")
  requireString(request.agent, "task request agent")
  validateOptionalModel(request.model, "task request model")
  if (request.command !== undefined) requireRedactedText(request.command, "task request command")
}

function validatePublicAssistantMessage(message: Record<string, unknown>) {
  requireKeys(message, ["type", "id", "agent", "model", "content", "time"], "public assistant message")
  requirePublicID(message.id, "message id")
  requireString(message.agent, "assistant agent")
  validateModel(message.model, "assistant model")
  if (!Array.isArray(message.content)) throw new PublicTranscriptPayloadValidationError("assistant content must be an array")
  message.content.forEach(validateAssistantContent)
  validateMessageTime(message.time, "assistant time")
}

function validateAssistantContent(value: unknown) {
  const content = requireObject(value, "assistant content")
  switch (content.type) {
    case "text":
      requireKeys(content, ["type", "id", "text"], "assistant text content")
      requirePublicID(content.id, "content id")
      requireString(content.text, "assistant text")
      return
    case "patch":
      requireKeys(content, ["type", "id", "hash", "files"], "assistant patch content")
      requirePublicID(content.id, "content id")
      requireString(content.hash, "patch hash")
      if (!Array.isArray(content.files)) throw new PublicTranscriptPayloadValidationError("patch files must be an array")
      content.files.forEach((file) => requireString(file, "patch file"))
      return
    case "tool":
      return validateAssistantTool(content)
    default:
      throw new PublicTranscriptPayloadValidationError(`unsupported assistant content type: ${String(content.type)}`)
  }
}

function validateAssistantTool(tool: Record<string, unknown>) {
  requireKeys(tool, ["type", "id", "callID", "name", "title", "provider", "state", "time"], "assistant tool content")
  requirePublicID(tool.id, "content id")
  requirePublicID(tool.callID, "tool callID")
  requireString(tool.name, "tool name")
  if (tool.title !== undefined) requireRedactedText(tool.title, "tool title")
  validateOptionalToolProvider(tool.provider)
  validateToolState(tool.state)
  validateToolTime(tool.time)
}

function validateOptionalToolProvider(value: unknown) {
  if (value === undefined) return
  const provider = requireObject(value, "tool provider")
  requireKeys(provider, ["executed"], "tool provider")
  if (typeof provider.executed !== "boolean") throw new PublicTranscriptPayloadValidationError("tool provider.executed must be a boolean")
}

function validateToolState(value: unknown) {
  const state = requireObject(value, "tool state")
  switch (state.status) {
    case "pending":
      requireKeys(state, ["status", "input"], "pending tool state")
      requireRedactedText(state.input, "tool input")
      return
    case "running":
    case "completed":
      requireKeys(state, ["status", "input", "structured", "content"], `${state.status} tool state`)
      requireRedactedText(state.input, "tool input")
      requireRedactedText(state.structured, "tool structured output")
      validateToolOutputs(state.content)
      return
    case "error":
      requireKeys(state, ["status", "input", "structured", "content", "error"], "error tool state")
      requireRedactedText(state.input, "tool input")
      requireRedactedText(state.structured, "tool structured output")
      validateToolOutputs(state.content)
      requireRedactedText(state.error, "tool error")
      return
    default:
      throw new PublicTranscriptPayloadValidationError(`unsupported tool state status: ${String(state.status)}`)
  }
}

function validateToolOutputs(value: unknown) {
  if (!Array.isArray(value)) throw new PublicTranscriptPayloadValidationError("tool output content must be an array")
  value.forEach((output) => {
    const item = requireObject(output, "tool output")
    switch (item.type) {
      case "text":
        requireKeys(item, ["type", "text"], "tool text output")
        requireRedactedText(item.text, "tool output text")
        return
      case "file":
        requireKeys(item, ["type", "uri", "mime", "name"], "tool file output")
        requireRedactedURI(item.uri, "tool file uri")
        requireString(item.mime, "tool file mime")
        if (item.name !== undefined) requireRedactedText(item.name, "tool file name")
        return
      default:
        throw new PublicTranscriptPayloadValidationError(`unsupported tool output type: ${String(item.type)}`)
    }
  })
}

function validatePublicCompactionMessage(message: Record<string, unknown>) {
  requireKeys(message, ["type", "id", "reason", "summary", "include", "time"], "public compaction message")
  requirePublicID(message.id, "message id")
  requireString(message.reason, "compaction reason")
  requireRedactedText(message.summary, "compaction summary")
  if (message.include !== undefined) requirePublicID(message.include, "compaction include")
  validateMessageTime(message.time, "compaction time")
}

function assertUniqueMessageIDs(messages: readonly PublicTranscriptMessage[]) {
  const ids = new Set<string>()
  for (const message of messages) {
    if (ids.has(message.id)) throw new PublicTranscriptPayloadValidationError(`duplicate public transcript message id: ${message.id}`)
    ids.add(message.id)
  }
}

function assertSupportedCompactionReason(reason: string): asserts reason is SessionMessage.Compaction["reason"] {
  if (reason !== "auto" && reason !== "manual") {
    throw new PublicTranscriptPayloadValidationError(`unsupported public transcript compaction reason: ${reason}`)
  }
}

function validateMessageTime(value: unknown, field: string) {
  const time = requireObject(value, field)
  requireKeys(time, ["created", "completed"], field)
  requireFiniteNumber(time.created, `${field}.created`)
  if (time.completed !== undefined) requireFiniteNumber(time.completed, `${field}.completed`)
}

function validateToolTime(value: unknown) {
  const time = requireObject(value, "tool time")
  requireKeys(time, ["created", "ran", "completed", "pruned"], "tool time")
  requireFiniteNumber(time.created, "tool time.created")
  if (time.ran !== undefined) requireFiniteNumber(time.ran, "tool time.ran")
  if (time.completed !== undefined) requireFiniteNumber(time.completed, "tool time.completed")
  if (time.pruned !== undefined) requireFiniteNumber(time.pruned, "tool time.pruned")
}

function validateOptionalModel(value: unknown, field: string) {
  if (value !== undefined) validateModel(value, field)
}

function validateModel(value: unknown, field: string) {
  const model = requireObject(value, field)
  requireKeys(model, ["providerID", "id", "variant"], field)
  requireString(model.providerID, `${field}.providerID`)
  requireString(model.id, `${field}.id`)
  requireOptionalString(model.variant, `${field}.variant`)
}

function rejectLegacyEnvelope(payload: Record<string, unknown>) {
  if ("info" in payload || ("messages" in payload && !("kind" in payload))) throw new PublicTranscriptPayloadValidationError("legacy transcript payload shape is not supported")
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PublicTranscriptPayloadValidationError(`${field} must be an object`)
  return value as Record<string, unknown>
}

function requireKeys(value: Record<string, unknown>, keys: readonly string[], field: string) {
  const allowed = new Set(keys)
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new PublicTranscriptPayloadValidationError(`${field} contains unsupported field: ${key}`)
  }
  for (const key of keys) {
    if (key in value || isOptionalKey(key)) continue
    throw new PublicTranscriptPayloadValidationError(`${field} is missing required field: ${key}`)
  }
}

function isOptionalKey(key: string) {
  return key === "agent" || key === "model" || key === "variant" || key === "taskRequests" || key === "command" || key === "title" || key === "provider" || key === "include" || key === "completed" || key === "ran" || key === "pruned" || key === "name"
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new PublicTranscriptPayloadValidationError(`${field} must be a string`)
  return value
}

function requireOptionalString(value: unknown, field: string) {
  if (value !== undefined) requireString(value, field)
}

function requireFiniteNumber(value: unknown, field: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new PublicTranscriptPayloadValidationError(`${field} must be a finite number`)
}

function requirePublicID(value: unknown, field: string) {
  const id = requireString(value, field)
  if (/^(?:msg|prt)_/.test(id)) throw new PublicTranscriptPayloadValidationError(`${field} must not use a legacy id`)
}

function requireRedactedText(value: unknown, field: string) {
  if (value !== REDACTED_TEXT) throw new PublicTranscriptPayloadValidationError(`${field} must be redacted`)
}

function requireRedactedURI(value: unknown, field: string) {
  if (value !== REDACTED_URI) throw new PublicTranscriptPayloadValidationError(`${field} must be redacted`)
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
