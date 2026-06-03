import { SessionMessage } from "@opencode-ai/core/session/message"
import { MessageV2Context } from "./message-v2-context"

export type SelectionOptions = {
  tailTurns?: number
  preserveRecentBudget?: number
  estimate?: (messages: readonly SessionMessage.Message[]) => number
}

export type Selection = {
  history: SessionMessage.Message[]
  head: SessionMessage.Message[]
  tailStartID?: SessionMessage.ID
  previousSummary?: string
  latestCompaction?: SessionMessage.Compaction
}

type Turn = {
  start: number
  end: number
  id: SessionMessage.ID
}

type Tail = {
  start: number
  id: SessionMessage.ID
}

export function select(messages: readonly SessionMessage.Message[], options: SelectionOptions = {}): Selection {
  const visible = history(messages)
  const tail = selectTail(visible.history, options)
  return {
    ...visible,
    head: tail ? visible.history.slice(0, tail.start) : visible.history,
    tailStartID: tail?.id,
  }
}

export function history(
  messages: readonly SessionMessage.Message[],
): Pick<Selection, "history" | "previousSummary" | "latestCompaction"> {
  // Input is the full set of already-loaded canonical v2 messages. We use the
  // compacted context only to locate the latest compaction anchor and any
  // retained include tail, then remove all compaction rows so summaries are not
  // treated as provider/user intent by future prompt wiring.
  const compacted = MessageV2Context.filterCompacted(messages)
  const latestCompaction = compacted.find(
    (message): message is SessionMessage.Compaction => message.type === "compaction",
  )

  return {
    history: compacted.filter((message) => message.type !== "compaction"),
    previousSummary: latestCompaction?.summary,
    latestCompaction,
  }
}

function selectTail(messages: readonly SessionMessage.Message[], options: SelectionOptions) {
  const limit = options.tailTurns ?? 0
  if (limit <= 0) return undefined

  const all = turns(messages)
  if (!all.length) return undefined

  const recent = all.slice(-limit)
  const budget = options.preserveRecentBudget
  const estimate = options.estimate
  if (budget === undefined || !estimate) return tailFromTurn(recent[0]!)

  let total = 0
  let keep: Tail | undefined
  for (let i = recent.length - 1; i >= 0; i--) {
    const turn = recent[i]!
    const size = estimateSize(estimate, messages.slice(turn.start, turn.end))
    if (total + size <= budget) {
      total += size
      keep = tailFromTurn(turn)
      continue
    }

    const split = splitTurn({ messages, turn, budget: budget - total, estimate })
    if (split) keep = split
    break
  }

  if (!keep || keep.start === 0) return undefined
  return keep
}

function turns(messages: readonly SessionMessage.Message[]) {
  const result: Turn[] = []
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    if (message.type !== "user") continue
    result.push({ start: i, end: messages.length, id: message.id })
  }
  for (let i = 0; i < result.length - 1; i++) {
    result[i]!.end = result[i + 1]!.start
  }
  return result
}

function splitTurn(input: {
  messages: readonly SessionMessage.Message[]
  turn: Turn
  budget: number
  estimate: (messages: readonly SessionMessage.Message[]) => number
}) {
  if (input.budget <= 0) return undefined
  if (input.turn.end - input.turn.start <= 1) return undefined

  for (let start = input.turn.start + 1; start < input.turn.end; start++) {
    const size = estimateSize(input.estimate, input.messages.slice(start, input.turn.end))
    if (size > input.budget) continue
    return { start, id: input.messages[start]!.id } satisfies Tail
  }
  return undefined
}

function tailFromTurn(turn: Turn): Tail | undefined {
  if (turn.start === 0) return undefined
  return { start: turn.start, id: turn.id }
}

function estimateSize(estimate: (messages: readonly SessionMessage.Message[]) => number, messages: SessionMessage.Message[]) {
  return Math.max(0, estimate(messages))
}

export * as CompactionV2Context from "./compaction-v2-context"
