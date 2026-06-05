import { SessionMessage } from "@opencode-ai/core/session/message"
import { MessageV2Context } from "./message-v2-context"

export type PromptReadiness =
  | {
      type: "ready"
      mode: "new-turn" | "tool-continuation"
      messages: SessionMessage.Message[]
    }
  | {
      type: "settled"
      reason: "assistant-finished"
    }
  | {
      type: "blocked"
      reason: "no-user" | "pending-task" | "assistant-not-terminal" | "tool-not-terminal"
    }

export type CompactionReadiness =
  | {
      type: "ready"
      messages: SessionMessage.Message[]
    }
  | {
      type: "blocked"
      reason:
        | "compaction-missing"
        | "compaction-completed"
        | "no-user-before-compaction"
        | "assistant-not-terminal"
        | "tool-not-terminal"
    }

export function promptProviderReadiness(messages: readonly SessionMessage.Message[]): PromptReadiness {
  const ordered = MessageV2Context.chronological(messages)
  const state = MessageV2Context.latestWithTasks(ordered)

  if (!state.user) return { type: "blocked", reason: "no-user" }
  if (state.tasks.length > 0) return { type: "blocked", reason: "pending-task" }
  if (hasUnsettledTools(ordered)) return { type: "blocked", reason: "tool-not-terminal" }
  if (state.assistant && !isTerminalAssistant(state.assistant)) return { type: "blocked", reason: "assistant-not-terminal" }
  if (isLatestUserAfterLatestAssistant(ordered, state)) return { type: "ready", mode: "new-turn", messages: ordered }
  if (state.assistant?.finish === "tool-calls") return { type: "ready", mode: "tool-continuation", messages: ordered }

  return { type: "settled", reason: "assistant-finished" }
}

export function compactionProviderReadiness(input: {
  messages: readonly SessionMessage.Message[]
  compactionID: SessionMessage.ID
}): CompactionReadiness {
  const ordered = MessageV2Context.chronological(input.messages)
  const anchorIndex = ordered.findIndex((message) => message.id === input.compactionID)

  if (anchorIndex === -1) return { type: "blocked", reason: "compaction-missing" }

  const anchor = ordered[anchorIndex]
  if (anchor.type !== "compaction") return { type: "blocked", reason: "compaction-missing" }
  if (!isPendingCompaction(anchor)) return { type: "blocked", reason: "compaction-completed" }

  const beforeAnchor = ordered.slice(0, anchorIndex)
  if (!beforeAnchor.some((message) => message.type === "user")) {
    return { type: "blocked", reason: "no-user-before-compaction" }
  }
  if (hasUnsettledTools(beforeAnchor)) return { type: "blocked", reason: "tool-not-terminal" }
  if (hasNonTerminalAssistant(beforeAnchor)) return { type: "blocked", reason: "assistant-not-terminal" }

  return { type: "ready", messages: beforeAnchor }
}

function isLatestUserAfterLatestAssistant(
  messages: readonly SessionMessage.Message[],
  state: MessageV2Context.Latest,
) {
  if (!state.user) return false
  if (!state.assistant) return true

  return indexOfMessage(messages, state.user) > indexOfMessage(messages, state.assistant)
}

function indexOfMessage(messages: readonly SessionMessage.Message[], target: SessionMessage.Message) {
  return messages.findIndex((message) => message.id === target.id)
}

function hasNonTerminalAssistant(messages: readonly SessionMessage.Message[]) {
  return messages.some((message) => message.type === "assistant" && !isTerminalAssistant(message))
}

function isTerminalAssistant(message: SessionMessage.Assistant) {
  return Boolean(message.time.completed || message.finish || message.error)
}

// Scanning the whole candidate Provider history is intentionally conservative:
// any unsettled tool result would make the replayed turn ambiguous.
function hasUnsettledTools(messages: readonly SessionMessage.Message[]) {
  return messages.some((message) => {
    if (message.type !== "assistant") return false
    return message.content.some((content) => content.type === "tool" && !isTerminalTool(content))
  })
}

function isTerminalTool(content: SessionMessage.AssistantTool) {
  return content.state.status === "completed" || content.state.status === "error"
}

function isPendingCompaction(message: SessionMessage.Compaction) {
  return message.summary === "" && message.include === undefined
}

export * as MessageV2Readiness from "./message-v2-readiness"
