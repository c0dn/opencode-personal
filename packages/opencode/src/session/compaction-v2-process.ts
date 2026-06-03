import { SessionMessage } from "@opencode-ai/core/session/message"
import { CompactionV2Context } from "./compaction-v2-context"

export type ProcessSelectionOptions = CompactionV2Context.SelectionOptions & {
  overflow?: boolean
  overflowReplayStartID?: SessionMessage.ID
}

export type OverflowReplay =
  | {
      status: "none"
      reason: "not-overflow" | "missing-replay-start-id" | "not-visible-user" | "no-earlier-user"
    }
  | { status: "selected"; startID: SessionMessage.ID; message: SessionMessage.User }

export type ProcessSelection = CompactionV2Context.Selection & { replay: OverflowReplay }

export function selectForProcess(
  messages: readonly SessionMessage.Message[],
  options: ProcessSelectionOptions = {},
): ProcessSelection {
  const selectionOptions = toSelectionOptions(options)
  const full = CompactionV2Context.select(messages, selectionOptions)

  if (!options.overflow) return withReplay(full, { status: "none", reason: "not-overflow" })
  if (!options.overflowReplayStartID)
    return withReplay(full, { status: "none", reason: "missing-replay-start-id" })

  const replayIndex = full.history.findIndex((message) => message.id === options.overflowReplayStartID)
  const replay = replayIndex === -1 ? undefined : full.history[replayIndex]
  if (replay?.type !== "user") return withReplay(full, { status: "none", reason: "not-visible-user" })

  if (!hasEarlierVisibleUser(full.history, replayIndex))
    return withReplay(full, { status: "none", reason: "no-earlier-user" })

  const beforeReplay = CompactionV2Context.select(full.history.slice(0, replayIndex), selectionOptions)
  return {
    ...beforeReplay,
    previousSummary: full.previousSummary,
    latestCompaction: full.latestCompaction,
    replay: { status: "selected", startID: replay.id, message: replay },
  }
}

function toSelectionOptions(options: ProcessSelectionOptions): CompactionV2Context.SelectionOptions {
  return {
    tailTurns: options.tailTurns,
    preserveRecentBudget: options.preserveRecentBudget,
    estimate: options.estimate,
  }
}

function withReplay(selection: CompactionV2Context.Selection, replay: OverflowReplay): ProcessSelection {
  return { ...selection, replay }
}

function hasEarlierVisibleUser(messages: readonly SessionMessage.Message[], replayIndex: number) {
  return messages.slice(0, replayIndex).some((message) => message.type === "user")
}

export * as CompactionV2Process from "./compaction-v2-process"
