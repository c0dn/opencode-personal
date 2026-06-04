import { SessionMessage } from "@opencode-ai/core/session/message"
import { DateTime } from "effect"
import { Buffer } from "node:buffer"

export type DisplayReadiness = { status: "ready" } | { status: string; reason?: string }

export type DisplayTranscriptMessage =
  | DisplayAgentSwitched
  | DisplayModelSwitched
  | DisplayUser
  | DisplaySynthetic
  | DisplayShell
  | DisplayAssistant
  | DisplayCompaction

export type DisplayTime = {
  created: number
  completed?: number
}

export type DisplayAgentSwitched = {
  type: "agent-switched"
  id: string
  agent: string
  time: DisplayTime
}

export type DisplayModelSwitched = {
  type: "model-switched"
  id: string
  model: SessionMessage.ModelSwitched["model"]
  time: DisplayTime
}

export type DisplayUser = {
  type: "user"
  id: string
  text: string
  files: SessionMessage.User["files"]
  agents: SessionMessage.User["agents"]
  references: SessionMessage.User["references"]
  taskRequests?: readonly DisplayTaskRequest[]
  time: DisplayTime
}

export type DisplayTaskRequest = {
  type: "task-request"
  id: string
  prompt: string
  description: string
  agent: string
  model?: SessionMessage.UserTaskRequest["model"]
  command?: string
}

export type DisplaySynthetic = {
  type: "synthetic"
  id: string
  sessionID: string
  text: string
  time: DisplayTime
}

export type DisplayShell = {
  type: "shell"
  id: string
  callID: string
  command: string
  output: string
  time: DisplayTime
}

export type DisplayAssistant = {
  type: "assistant"
  id: string
  agent: string
  model: SessionMessage.Assistant["model"]
  content: readonly DisplayAssistantContent[]
  snapshot?: SessionMessage.Assistant["snapshot"]
  finish?: string
  cost?: number
  retries?: readonly SessionMessage.AssistantRetry[]
  tokens?: SessionMessage.Assistant["tokens"]
  error?: SessionMessage.Assistant["error"]
  time: DisplayTime
}

export type DisplayAssistantContent =
  | DisplayAssistantText
  | DisplayAssistantReasoning
  | DisplayAssistantTool
  | DisplayAssistantPatch

export type DisplayAssistantText = {
  type: "text"
  id: string
  text: string
}

export type DisplayAssistantReasoning = {
  type: "reasoning"
  id: string
  reasoningID: string
  text: string
}

export type DisplayAssistantPatch = {
  type: "patch"
  id: string
  hash: string
  files: readonly string[]
}

export type DisplayAssistantTool = {
  type: "tool"
  id: string
  callID: string
  name: string
  title?: string
  provider?: { executed: boolean }
  state: DisplayToolState
  time: {
    created: number
    ran?: number
    completed?: number
    pruned?: number
  }
}

export type DisplayToolState =
  | { status: "pending"; input: string }
  | {
      status: "running"
      input: SessionMessage.ToolStateRunning["input"]
      structured: SessionMessage.ToolStateRunning["structured"]
      content: readonly DisplayToolOutput[]
    }
  | {
      status: "completed"
      input: SessionMessage.ToolStateCompleted["input"]
      structured: SessionMessage.ToolStateCompleted["structured"]
      content: readonly DisplayToolOutput[]
    }
  | {
      status: "error"
      input: SessionMessage.ToolStateError["input"]
      structured: SessionMessage.ToolStateError["structured"]
      content: readonly DisplayToolOutput[]
      error: SessionMessage.ToolStateError["error"]
    }

export type DisplayToolOutput =
  | { type: "text"; text: string }
  | { type: "file"; uri: string; mime: string; name?: string }

export type DisplayCompaction = {
  type: "compaction"
  id: string
  reason: string
  summary: string
  include?: string
  time: DisplayTime
}

export class DisplayTranscriptNotReadyError extends Error {
  constructor(readiness: DisplayReadiness | undefined) {
    super(`v2 display transcript is not ready: ${readiness?.status ?? "missing"}`)
    this.name = "DisplayTranscriptNotReadyError"
  }
}

export class DisplayTranscriptUnsupportedError extends Error {
  constructor(kind: string, value: unknown) {
    super(`unsupported v2 display transcript ${kind}: ${variantType(value)}`)
    this.name = "DisplayTranscriptUnsupportedError"
  }
}

export function orderMessages(messages: readonly SessionMessage.Message[]) {
  return messages.slice().sort((left, right) => compareMessages(left, right))
}

export function requireReady(readiness: DisplayReadiness | undefined): asserts readiness is { status: "ready" } {
  if (readiness?.status !== "ready") throw new DisplayTranscriptNotReadyError(readiness)
}

export function toDisplayTranscriptV2(
  messages: readonly SessionMessage.Message[],
  readiness: DisplayReadiness | undefined,
): readonly DisplayTranscriptMessage[] {
  requireReady(readiness)
  return orderMessages(messages).map(displayMessage)
}

function compareMessages(left: SessionMessage.Message, right: SessionMessage.Message) {
  const time = DateTime.toEpochMillis(left.time.created) - DateTime.toEpochMillis(right.time.created)
  if (time !== 0) return time
  return compareID(left.id, right.id)
}

function compareID(left: string, right: string) {
  // Compare by byte order intentionally; IDs are not locale-collated text.
  return Buffer.from(left).compare(Buffer.from(right))
}

function displayMessage(message: SessionMessage.Message): DisplayTranscriptMessage {
  assertCanonicalID(message.id)
  switch (message.type) {
    case "agent-switched":
      return { type: message.type, id: message.id, agent: message.agent, time: displayTime(message.time) }
    case "model-switched":
      return { type: message.type, id: message.id, model: message.model, time: displayTime(message.time) }
    case "user":
      return {
        type: message.type,
        id: message.id,
        text: message.text,
        files: message.files,
        agents: message.agents,
        references: message.references,
        ...(message.taskRequests ? { taskRequests: message.taskRequests.map(displayTaskRequest) } : {}),
        time: displayTime(message.time),
      }
    case "synthetic":
      return { type: message.type, id: message.id, sessionID: message.sessionID, text: message.text, time: displayTime(message.time) }
    case "shell":
      return {
        type: message.type,
        id: message.id,
        callID: message.callID,
        command: message.command,
        output: message.output,
        time: displayTime(message.time),
      }
    case "assistant":
      return {
        type: message.type,
        id: message.id,
        agent: message.agent,
        model: message.model,
        content: message.content.map(displayAssistantContent),
        ...(message.snapshot ? { snapshot: message.snapshot } : {}),
        ...(message.finish ? { finish: message.finish } : {}),
        ...(message.cost !== undefined ? { cost: message.cost } : {}),
        ...(message.retries ? { retries: message.retries } : {}),
        ...(message.tokens ? { tokens: message.tokens } : {}),
        ...(message.error ? { error: message.error } : {}),
        time: displayTime(message.time),
      }
    case "compaction":
      if (message.include) assertCanonicalID(message.include)
      return {
        type: message.type,
        id: message.id,
        reason: message.reason,
        summary: message.summary,
        ...(message.include ? { include: message.include } : {}),
        time: displayTime(message.time),
      }
    default:
      return assertNever(message, "message")
  }
}

function displayTaskRequest(request: SessionMessage.UserTaskRequest): DisplayTaskRequest {
  assertCanonicalID(request.id)
  return {
    type: request.type,
    id: request.id,
    prompt: request.prompt,
    description: request.description,
    agent: request.agent,
    ...(request.model ? { model: request.model } : {}),
    ...(request.command ? { command: request.command } : {}),
  }
}

function displayAssistantContent(content: SessionMessage.AssistantContent): DisplayAssistantContent {
  assertCanonicalID(content.id)
  switch (content.type) {
    case "text":
      return { type: content.type, id: content.id, text: content.text }
    case "reasoning":
      return { type: content.type, id: content.id, reasoningID: content.reasoningID, text: content.text }
    case "patch":
      return { type: content.type, id: content.id, hash: content.hash, files: content.files }
    case "tool":
      return {
        type: content.type,
        id: content.id,
        callID: content.callID,
        name: content.name,
        ...(content.title ? { title: content.title } : {}),
        ...(content.provider ? { provider: { executed: content.provider.executed } } : {}),
        state: displayToolState(content.state),
        time: displayToolTime(content.time),
      }
    default:
      return assertNever(content, "assistant content")
  }
}

function displayToolState(state: SessionMessage.ToolState): DisplayToolState {
  switch (state.status) {
    case "pending":
      return { status: state.status, input: state.input }
    case "running":
      return {
        status: state.status,
        input: state.input,
        structured: state.structured,
        content: state.content.map(displayToolOutput),
      }
    case "completed":
      return {
        status: state.status,
        input: state.input,
        structured: state.structured,
        content: state.content.map(displayToolOutput),
      }
    case "error":
      return {
        status: state.status,
        input: state.input,
        structured: state.structured,
        content: state.content.map(displayToolOutput),
        error: state.error,
      }
    default:
      return assertNever(state, "tool state")
  }
}

function displayToolOutput(content: SessionMessage.ToolStateRunning["content"][number]): DisplayToolOutput {
  switch (content.type) {
    case "text":
      return { type: content.type, text: content.text }
    case "file":
      return { type: content.type, uri: content.uri, mime: content.mime, ...(content.name ? { name: content.name } : {}) }
    default:
      return assertNever(content, "tool output")
  }
}

function displayTime(time: { created: SessionMessage.Message["time"]["created"]; completed?: SessionMessage.Assistant["time"]["completed"] }): DisplayTime {
  return {
    created: DateTime.toEpochMillis(time.created),
    ...(time.completed ? { completed: DateTime.toEpochMillis(time.completed) } : {}),
  }
}

function displayToolTime(time: SessionMessage.AssistantTool["time"]): DisplayAssistantTool["time"] {
  return {
    created: DateTime.toEpochMillis(time.created),
    ...(time.ran ? { ran: DateTime.toEpochMillis(time.ran) } : {}),
    ...(time.completed ? { completed: DateTime.toEpochMillis(time.completed) } : {}),
    ...(time.pruned ? { pruned: DateTime.toEpochMillis(time.pruned) } : {}),
  }
}

function assertCanonicalID(id: string) {
  if (/^(?:msg|prt)_/.test(id)) throw new DisplayTranscriptUnsupportedError("legacy id", id)
}

function assertNever(value: never, kind: string): never {
  throw new DisplayTranscriptUnsupportedError(kind, value)
}

function variantType(value: unknown) {
  if (value && typeof value === "object" && "type" in value) return String((value as { type?: unknown }).type)
  if (value && typeof value === "object" && "status" in value) return String((value as { status?: unknown }).status)
  return typeof value
}

export * as TranscriptV2Display from "./transcript-v2-display"
