import type { SessionMessage } from "@opencode-ai/core/session/message"
import { DateTime } from "effect"

export const PendingCompactionPolicy = "requires-explicit-pending-compaction-input" as const
export const InterruptedOrphanToolPolicy = "unsupported-v2-signal-missing" as const

export type LoopTime = {
  created: DateTime.DateTime | number
  completed?: DateTime.DateTime | number
}

export type LoopMessageBase = {
  id: string
  type: string
  time: LoopTime
}

export type LoopTaskRequest = {
  id: string
  type: "task-request"
  prompt: string
  description: string
  agent: string
  model?: unknown
  command?: string
}

export type LoopUserMessage = LoopMessageBase & {
  type: "user"
  taskRequests?: readonly LoopTaskRequest[]
}

export type LoopAssistantTool = {
  type: "tool"
  provider?: {
    executed: boolean
  }
  state: {
    status: "pending" | "running" | "completed" | "error"
  }
}

export type LoopAssistantMessage = LoopMessageBase & {
  type: "assistant"
  content: readonly (LoopAssistantTool | { type: string })[]
  finish?: string
  error?: unknown
}

export type LoopCompactionMessage = LoopMessageBase & {
  type: "compaction"
}

export type LoopMessage = LoopUserMessage | LoopAssistantMessage | LoopCompactionMessage | LoopMessageBase

export type PendingCompactionRequest = {
  id: string
  type: "compaction"
  time: LoopTime
  auto?: boolean
  overflow?: boolean
}

export type PendingRequest =
  | {
      type: "task-request"
      id: string
      messageID: string
      request: LoopTaskRequest
    }
  | {
      type: "compaction"
      id: string
      request: PendingCompactionRequest
    }

export type ExitEligibility =
  | { eligible: true; reason: "assistant-after-user-finished-without-tools" }
  | {
      eligible: false
      reason:
        | "no-latest-user"
        | "no-latest-assistant"
        | "assistant-not-after-user"
        | "assistant-not-finished"
        | "assistant-finish-tool-calls"
        | "assistant-has-unacknowledged-tools"
      tools?: readonly ToolExitState[]
    }

export type ToolExitState = {
  status: LoopAssistantTool["state"]["status"]
  providerExecuted: boolean
  blocksExit: boolean
}

export type LoopState = {
  orderedMessages: readonly LoopMessage[]
  latestUser?: LoopUserMessage
  latestAssistant?: LoopAssistantMessage
  latestFinishedAssistant?: LoopAssistantMessage
  assistantAfterUser: boolean
  exitEligibility: ExitEligibility
  pendingRequests: readonly PendingRequest[]
  pendingCompactionPolicy: typeof PendingCompactionPolicy
  unsupported: {
    interruptedOrphanTools: typeof InterruptedOrphanToolPolicy
  }
}

export type ComputeInput = {
  messages: readonly LoopMessage[]
  pendingCompactionRequests?: readonly PendingCompactionRequest[]
}

export function fromSessionMessages(messages: readonly SessionMessage.Message[]): LoopMessage[] {
  return messages.map(fromSessionMessage)
}

export function fromSessionMessage(message: SessionMessage.Message): LoopMessage {
  if (message.type === "user") return fromUserMessage(message)
  if (message.type === "assistant") return fromAssistantMessage(message)
  if (message.type === "compaction") return fromCompactionMessage(message)
  return fromBaseMessage(message)
}

export function compute(input: ComputeInput): LoopState {
  const orderedMessages = chronological(input.messages)
  const latestUser = latestUserMessage(orderedMessages)
  const latestAssistant = latestAssistantMessage(orderedMessages)
  const latestFinishedAssistant = latestFinishedAssistantMessage(orderedMessages)
  const assistantAfterUser = isAssistantAfterUser(latestAssistant, latestUser)

  return {
    orderedMessages,
    latestUser,
    latestAssistant,
    latestFinishedAssistant,
    assistantAfterUser,
    exitEligibility: exitEligibility({ latestUser, latestAssistant, assistantAfterUser }),
    pendingRequests: pendingRequests({
      messages: orderedMessages,
      latestFinishedAssistant,
      pendingCompactionRequests: input.pendingCompactionRequests ?? [],
    }),
    pendingCompactionPolicy: PendingCompactionPolicy,
    unsupported: { interruptedOrphanTools: InterruptedOrphanToolPolicy },
  }
}

function fromUserMessage(message: SessionMessage.User): LoopUserMessage {
  return {
    ...fromBaseMessage(message),
    type: "user",
    taskRequests: message.taskRequests,
  }
}

function fromAssistantMessage(message: SessionMessage.Assistant): LoopAssistantMessage {
  return {
    ...fromBaseMessage(message),
    type: "assistant",
    content: message.content.map(fromAssistantContent),
    finish: message.finish,
    error: message.error,
  }
}

function fromAssistantContent(content: SessionMessage.AssistantContent): LoopAssistantMessage["content"][number] {
  if (content.type !== "tool") return { type: content.type }
  return {
    type: "tool",
    provider: content.provider ? { executed: content.provider.executed } : undefined,
    state: { status: content.state.status },
  }
}

function fromCompactionMessage(message: SessionMessage.Compaction): LoopCompactionMessage {
  return {
    ...fromBaseMessage(message),
    type: "compaction",
  }
}

function fromBaseMessage(message: SessionMessage.Message): LoopMessageBase {
  return {
    id: message.id,
    type: message.type,
    time: message.time,
  }
}

function chronological(messages: readonly LoopMessage[]) {
  return messages.slice().sort(compareMessages)
}

function latestUserMessage(messages: readonly LoopMessage[]) {
  return chronological(messages).findLast(isUser)
}

function latestAssistantMessage(messages: readonly LoopMessage[]) {
  return chronological(messages).findLast(isAssistant)
}

function latestFinishedAssistantMessage(messages: readonly LoopMessage[]) {
  return chronological(messages).findLast((message): message is LoopAssistantMessage => {
    return isAssistant(message) && isFinishedAssistant(message)
  })
}

function isFinishedAssistant(message: LoopAssistantMessage) {
  // The cutoff treats completed/finish/error as turn-finished, but exit eligibility
  // still requires an explicit finish reason so unfinished/error turns cannot end the loop.
  return Boolean(message.time.completed || message.finish || message.error)
}

function isAssistantAfterUser(assistant: LoopAssistantMessage | undefined, user: LoopUserMessage | undefined) {
  if (!assistant || !user) return false
  return compareMessages(assistant, user) > 0
}

function exitEligibility(input: {
  latestUser?: LoopUserMessage
  latestAssistant?: LoopAssistantMessage
  assistantAfterUser: boolean
}): ExitEligibility {
  if (!input.latestUser) return { eligible: false, reason: "no-latest-user" }
  if (!input.latestAssistant) return { eligible: false, reason: "no-latest-assistant" }
  if (!input.assistantAfterUser) return { eligible: false, reason: "assistant-not-after-user" }
  if (!input.latestAssistant.finish) return { eligible: false, reason: "assistant-not-finished" }
  if (input.latestAssistant.finish === "tool-calls") return { eligible: false, reason: "assistant-finish-tool-calls" }

  const tools = toolExitStates(input.latestAssistant)
  const blocking = tools.filter((tool) => tool.blocksExit)
  if (blocking.length > 0) return { eligible: false, reason: "assistant-has-unacknowledged-tools", tools: blocking }

  return { eligible: true, reason: "assistant-after-user-finished-without-tools" }
}

function toolExitStates(assistant: LoopAssistantMessage): ToolExitState[] {
  return assistant.content.filter(isTool).map((tool) => {
    const providerExecuted = tool.provider?.executed === true
    return {
      status: tool.state.status,
      providerExecuted,
      blocksExit: !providerExecuted,
    }
  })
}

function pendingRequests(input: {
  messages: readonly LoopMessage[]
  latestFinishedAssistant?: LoopAssistantMessage
  pendingCompactionRequests?: readonly PendingCompactionRequest[]
}): PendingRequest[] {
  const cutoff = input.latestFinishedAssistant
  const items = input.messages.flatMap((message): PendingRequestItem[] => {
    if (!isAfterCutoff(message, cutoff) || !isUser(message)) return []
    return (message.taskRequests ?? []).map((request, index) => ({
      order: orderKey(message, index),
      request: { type: "task-request", id: request.id, messageID: message.id, request },
    }))
  })

  for (const request of input.pendingCompactionRequests ?? []) {
    if (!isAfterCutoff(request, cutoff)) continue
    items.push({ order: orderKey(request, 0), request: { type: "compaction", id: request.id, request } })
  }

  return items.sort(compareRequestItems).map((item) => item.request)
}

function compareMessages(left: Pick<LoopMessageBase, "id" | "time">, right: Pick<LoopMessageBase, "id" | "time">) {
  const time = toEpochMillis(left.time.created) - toEpochMillis(right.time.created)
  if (time !== 0) return time
  return compareID(left.id, right.id)
}

function compareID(left: string, right: string) {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function toEpochMillis(value: DateTime.DateTime | number) {
  if (typeof value === "number") return value
  return DateTime.toEpochMillis(value)
}

function isUser(message: LoopMessage): message is LoopUserMessage {
  return message.type === "user"
}

function isAssistant(message: LoopMessage): message is LoopAssistantMessage {
  return message.type === "assistant"
}

function isTool(content: LoopAssistantMessage["content"][number]): content is LoopAssistantTool {
  return content.type === "tool"
}

function isAfterCutoff(message: Pick<LoopMessageBase, "id" | "time">, cutoff: LoopAssistantMessage | undefined) {
  if (!cutoff) return true
  return compareMessages(message, cutoff) > 0
}

type RequestOrder = {
  time: number
  id: string
  index: number
}

type PendingRequestItem = {
  order: RequestOrder
  request: PendingRequest
}

function orderKey(message: Pick<LoopMessageBase, "id" | "time">, index: number): RequestOrder {
  return { time: toEpochMillis(message.time.created), id: message.id, index }
}

function compareRequestItems(left: PendingRequestItem, right: PendingRequestItem) {
  const time = left.order.time - right.order.time
  if (time !== 0) return time
  const id = compareID(left.order.id, right.order.id)
  if (id !== 0) return id
  return left.order.index - right.order.index
}

export * as PromptV2LoopState from "./prompt-v2-loop-state"
