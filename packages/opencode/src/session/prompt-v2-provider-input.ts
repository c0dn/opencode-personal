import { SessionMessage } from "@opencode-ai/core/session/message"
import { DateTime } from "effect"
import type { ModelMessage } from "ai"
import { MessageV2Context } from "./message-v2-context"
import { MessageV2Model } from "./message-v2-model"
import PROMPT_PLAN from "./prompt/plan.txt"
import BUILD_SWITCH from "./prompt/build-switch.txt"
import PLAN_MODE from "./prompt/plan-mode.txt"

export const LegacyTransformPolicy = "not-applied-to-v2-provider-input" as const
export const MaxStepOverlayPolicy = "production-wiring-appends-max-steps" as const

export type PrepareMessagesInput = {
  messages: readonly SessionMessage.Message[]
  agentName: string
  step: number
  experimentalPlanMode: boolean
  plan?: { path: string; exists: boolean }
}

export function prepareMessages(input: PrepareMessagesInput): SessionMessage.Message[] {
  const context = MessageV2Context.context(input.messages)
  const latest = MessageV2Context.latest(context)
  const expanded = expandCompactions(context)
  const wrapped = wrapUserMessagesAfterLatestFinishedAssistant(expanded, latest.finishedAssistant, input.step)
  return appendReminderOverlay(wrapped, input, latest)
}

export async function toProviderMessages(input: PrepareMessagesInput): Promise<ModelMessage[]> {
  return MessageV2Model.toModelMessages(prepareMessages(input))
}

function wrapUserMessagesAfterLatestFinishedAssistant(
  messages: SessionMessage.Message[],
  latestFinishedAssistant: SessionMessage.Assistant | undefined,
  step: number,
) {
  if (step <= 1 || !latestFinishedAssistant) return messages

  const latestFinishedAssistantIndex = messages.findIndex((message) => message.id === latestFinishedAssistant.id)
  if (latestFinishedAssistantIndex === -1) return messages

  return messages.map((message, index) => {
    if (index <= latestFinishedAssistantIndex || message.type !== "user") return message
    if (message.text === "") return cloneUser(message, { text: "" })
    return cloneUser(message, { text: systemReminderWrappedText(message.text) })
  })
}

function appendReminderOverlay(
  messages: SessionMessage.Message[],
  input: PrepareMessagesInput,
  latest: MessageV2Context.Latest,
) {
  const reminder = reminderText(input, messages, latest)
  if (!reminder) return messages

  const latestUser = MessageV2Context.latest(messages).user
  if (!latestUser) return messages


  return messages.map((message) => {
    if (message.id !== latestUser.id || message.type !== "user") return message
    return cloneUser(message, { text: appendText(message.text, reminder) })
  })
}

function reminderText(input: PrepareMessagesInput, messages: SessionMessage.Message[], latest: MessageV2Context.Latest) {
  if (!input.experimentalPlanMode) {
    const parts = []
    if (input.agentName === "plan") parts.push(PROMPT_PLAN)
    if (input.agentName === "build" && messages.some((message) => message.type === "assistant" && message.agent === "plan")) {
      parts.push(BUILD_SWITCH)
    }
    return parts.join("\n")
  }

  if (input.agentName !== "plan" && latest.assistant?.agent === "plan") {
    if (input.plan?.exists) {
      return `${BUILD_SWITCH}\n\nA plan file exists at ${input.plan.path}. You should execute on the plan defined within it`
    }
    return BUILD_SWITCH
  }

  if (input.agentName !== "plan" || latest.assistant?.agent === "plan") return ""

  const plan = requirePlan(input.plan)
  return PLAN_MODE.replace(
    "${planInfo}",
    plan.exists
      ? `A plan file already exists at ${plan.path}. You can read it and make incremental edits using the edit tool.`
      : `No plan file exists yet. You should create your plan at ${plan.path} using the write tool.`,
  )
}

function expandCompactions(messages: readonly SessionMessage.Message[]) {
  const model = messages.find((message): message is SessionMessage.Assistant => message.type === "assistant")?.model ?? fallbackModel
  return messages.flatMap((message, index): SessionMessage.Message[] => {
    if (message.type === "compaction") return compactionSummaryPair(message, model, messages[index + 1])
    return [cloneMessage(message)]
  })
}

function compactionSummaryPair(
  compaction: SessionMessage.Compaction,
  model: SessionMessage.Assistant["model"],
  next: SessionMessage.Message | undefined,
): SessionMessage.Message[] {
  const baseID = sanitizeID(compaction.id)
  const time = compactionSummaryTime(compaction, next)
  return [
    new SessionMessage.User({
      id: SessionMessage.ID.make(`evt_provider_input_compaction_${baseID}_0_user`),
      type: "user",
      text: "What did we do so far?",
      files: [],
      agents: [],
      references: [],
      time: { created: time.user },
    }),
    new SessionMessage.Assistant({
      id: SessionMessage.ID.make(`evt_provider_input_compaction_${baseID}_1_assistant`),
      type: "assistant",
      agent: "build",
      model,
      content: [
        new SessionMessage.AssistantText({
          id: SessionMessage.ID.make(`evt_provider_input_compaction_${baseID}_2_text`),
          type: "text",
          text: compaction.summary,
        }),
      ],
      time: { created: time.assistant, completed: time.assistant },
      finish: "stop",
    }),
  ]
}

function compactionSummaryTime(compaction: SessionMessage.Compaction, next: SessionMessage.Message | undefined) {
  if (!next) return { user: compaction.time.created, assistant: compaction.time.created }

  const nextMillis = DateTime.toEpochMillis(next.time.created)
  return {
    user: DateTime.makeUnsafe(nextMillis - 2),
    assistant: DateTime.makeUnsafe(nextMillis - 1),
  }
}

function cloneMessage(message: SessionMessage.Message): SessionMessage.Message {
  if (message.type === "user") return cloneUser(message)
  if (message.type === "assistant") return cloneAssistant(message)
  return message
}

function cloneUser(message: SessionMessage.User, override?: Partial<SessionMessage.User>) {
  return new SessionMessage.User({
    ...message,
    files: [...(message.files ?? [])],
    agents: [...(message.agents ?? [])],
    references: [...(message.references ?? [])],
    ...(message.taskRequests ? { taskRequests: [...message.taskRequests] } : {}),
    ...override,
  })
}

function cloneAssistant(message: SessionMessage.Assistant) {
  return new SessionMessage.Assistant({
    ...message,
    content: [...message.content],
    ...(message.retries ? { retries: [...message.retries] } : {}),
  })
}

function systemReminderWrappedText(text: string) {
  return `<system-reminder>\nThe user sent the following message:\n${text}\n\nPlease address this message and continue with your tasks.\n</system-reminder>`
}

function appendText(text: string, addition: string) {
  if (text === "") return addition
  return `${text}\n${addition}`
}

function requirePlan(plan: PrepareMessagesInput["plan"]) {
  if (plan) return plan
  throw new Error("Plan info is required to prepare experimental plan-mode provider input")
}

function sanitizeID(id: string) {
  return id.replace(/[^a-zA-Z0-9_]/g, "_")
}

const fallbackModel = {
  providerID: "provider",
  id: "model",
  variant: "default",
} as SessionMessage.Assistant["model"]

export * as PromptV2ProviderInput from "./prompt-v2-provider-input"
