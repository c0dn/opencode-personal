import { SessionMessage } from "@opencode-ai/core/session/message"
import { DateTime } from "effect"
import { Buffer } from "node:buffer"

export type Latest = {
  user?: SessionMessage.User
  assistant?: SessionMessage.Assistant
  finishedAssistant?: SessionMessage.Assistant
}

type AgentTask = {
  type: "subtask"
  id: string
  message: SessionMessage.User
  agent: NonNullable<SessionMessage.User["agents"]>[number]
  index: number
}

type CompactionTask = {
  type: "compaction"
  id: SessionMessage.ID
  message: SessionMessage.Compaction
  auto: boolean
}

export type Task = AgentTask | CompactionTask

export type LatestWithTasks = Latest & {
  tasks: Task[]
}

export function chronological(messages: readonly SessionMessage.Message[]) {
  return messages.slice().sort((left, right) => compareMessages(left, right))
}

export function filterCompacted(messages: readonly SessionMessage.Message[]) {
  const ordered = chronological(messages)
  const latestCompaction = ordered
    .filter((message): message is SessionMessage.Compaction => message.type === "compaction")
    .at(-1)
  if (!latestCompaction) return ordered

  const compactionIndex = ordered.findIndex((message) => message.id === latestCompaction.id)
  const afterCompaction = ordered.slice(compactionIndex + 1)
  if (!latestCompaction.include) return [latestCompaction, ...afterCompaction]

  const includeIndex = ordered.findIndex((message) => message.id === latestCompaction.include)
  if (includeIndex === -1 || includeIndex >= compactionIndex) return [latestCompaction, ...afterCompaction]

  return [latestCompaction, ...ordered.slice(includeIndex, compactionIndex), ...afterCompaction]
}

export function context(messages: readonly SessionMessage.Message[]) {
  return filterCompacted(messages)
}

export function latest(messages: readonly SessionMessage.Message[]): Latest {
  const ordered = chronological(messages)
  return {
    user: ordered.findLast((message): message is SessionMessage.User => message.type === "user"),
    assistant: ordered.findLast((message): message is SessionMessage.Assistant => message.type === "assistant"),
    finishedAssistant: ordered.findLast((message): message is SessionMessage.Assistant => {
      return message.type === "assistant" && isTerminalAssistant(message)
    }),
  }
}

export type PromptContext = LatestWithTasks & {
  activeAgent?: string
  activeModel?: {
    id: string
    providerID: string
    variant?: string
  }
}

export function promptContext(messages: readonly SessionMessage.Message[]): PromptContext {
  const state = latestWithTasks(messages)
  const ordered = chronological(messages)

  const latestAgent = ordered.findLast(
    (message): message is SessionMessage.AgentSwitched => message.type === "agent-switched",
  )
  const latestModel = ordered.findLast(
    (message): message is SessionMessage.ModelSwitched => message.type === "model-switched",
  )

  return {
    ...state,
    ...(latestAgent ? { activeAgent: latestAgent.agent } : {}),
    ...(latestModel ? { activeModel: { id: latestModel.model.id, providerID: latestModel.model.providerID, variant: latestModel.model.variant } } : {}),
  }
}

export function latestWithTasks(messages: readonly SessionMessage.Message[]): LatestWithTasks {
  const ordered = chronological(messages)
  const state = latest(ordered)
  const boundary = state.finishedAssistant ? ordered.findIndex((message) => message.id === state.finishedAssistant?.id) : -1
  const pending = boundary === -1 ? ordered : ordered.slice(boundary + 1)
  return {
    ...state,
    tasks: pending.flatMap(tasksForMessage),
  }
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

function tasksForMessage(message: SessionMessage.Message): Task[] {
  if (message.type === "user") return agentTasks(message)
  if (message.type === "compaction" && isPendingCompaction(message)) {
    return [{ type: "compaction", id: message.id, message, auto: message.reason === "auto" }]
  }
  return []
}

function agentTasks(message: SessionMessage.User): AgentTask[] {
  return (message.agents ?? []).map((agent, index) => ({
    type: "subtask" as const,
    id: `${message.id}/agent/${index}`,
    message,
    agent,
    index,
  }))
}

function isPendingCompaction(message: SessionMessage.Compaction) {
  return message.summary === "" && message.include === undefined
}

function isTerminalAssistant(message: SessionMessage.Assistant) {
  // v2 assistant turns are terminal when the step has completed, emitted a
  // finish reason, or failed with an assistant error. Pending/running turns have
  // none of these signals and are intentionally excluded.
  return Boolean(message.time.completed || message.finish || message.error)
}

export * as MessageV2Context from "./message-v2-context"
