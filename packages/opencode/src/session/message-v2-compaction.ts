import { SessionMessage } from "@opencode-ai/core/session/message"
import { DateTime } from "effect"
import { Buffer } from "node:buffer"
import { MessageV2Context } from "./message-v2-context"

export type Anchor = {
  id: SessionMessage.ID
  time: DateTime.Utc
}

export type ProviderMessage = SessionMessage.User | SessionMessage.Assistant

export type Estimate = (messages: readonly ProviderMessage[]) => number | Promise<number>

export type Result =
  | {
      type: "blocked"
      reason: "compaction-completed" | "no-user-before-compaction"
    }
  | {
      type: "selected"
      previousSummary?: string
      messages: ProviderMessage[]
      include?: SessionMessage.ID
    }

type Turn = {
  start: number
  end: number
}

type Tail = {
  start: number
}

export async function select(input: {
  messages: readonly SessionMessage.Message[]
  anchor: Anchor
  tailTurns?: number
  preserveRecentTokens: number
  estimate: Estimate
}): Promise<Result> {
  const ordered = MessageV2Context.chronological(input.messages)
  if (hasCompletedAnchor(ordered, input.anchor.id)) return { type: "blocked", reason: "compaction-completed" }

  const beforeAnchor = ordered.filter((message) => compareMessageToAnchor(message, input.anchor) < 0)
  const visible = MessageV2Context.context(beforeAnchor)
  const candidates = providerCandidates(visible)
  if (!candidates.some((message) => message.type === "user")) {
    return { type: "blocked", reason: "no-user-before-compaction" }
  }

  const selection = await selectTail({
    messages: candidates,
    tailTurns: input.tailTurns,
    preserveRecentTokens: input.preserveRecentTokens,
    estimate: input.estimate,
  })
  const previousSummary = latestCompletedSummary(visible)

  return {
    type: "selected",
    messages: selection.messages,
    ...(previousSummary ? { previousSummary } : {}),
    ...(selection.include ? { include: selection.include } : {}),
  }
}

async function selectTail(input: {
  messages: readonly ProviderMessage[]
  tailTurns?: number
  preserveRecentTokens: number
  estimate: Estimate
}) {
  const limit = input.tailTurns ?? 2
  if (limit <= 0) return { messages: input.messages.slice(), include: undefined }

  const all = turns(input.messages)
  if (all.length === 0) return { messages: input.messages.slice(), include: undefined }

  const recent = all.slice(-limit)
  const sizes: number[] = []
  for (const turn of recent) {
    sizes.push(await input.estimate(input.messages.slice(turn.start, turn.end)))
  }

  let total = 0
  let keep: Tail | undefined
  for (let index = recent.length - 1; index >= 0; index--) {
    const turn = recent[index]!
    const size = sizes[index]!
    if (total + size <= input.preserveRecentTokens) {
      total += size
      keep = { start: turn.start }
      continue
    }

    const split = await splitTurn({
      messages: input.messages,
      turn,
      budget: input.preserveRecentTokens - total,
      estimate: input.estimate,
    })
    if (split) keep = split
    break
  }

  if (!keep || keep.start === 0) return { messages: input.messages.slice(), include: undefined }

  const include = input.messages.at(keep.start)?.id
  if (!include) return { messages: input.messages.slice(), include: undefined }

  return {
    messages: input.messages.slice(0, keep.start),
    include,
  }
}

async function splitTurn(input: {
  messages: readonly ProviderMessage[]
  turn: Turn
  budget: number
  estimate: Estimate
}): Promise<Tail | undefined> {
  if (input.budget <= 0) return undefined
  if (input.turn.end - input.turn.start <= 1) return undefined

  for (let start = input.turn.start + 1; start < input.turn.end; start++) {
    const size = await input.estimate(input.messages.slice(start, input.turn.end))
    if (size <= input.budget) return { start }
  }

  return undefined
}

function turns(messages: readonly ProviderMessage[]) {
  const starts: number[] = []
  for (const [index, message] of messages.entries()) {
    if (message.type !== "user") continue
    starts.push(index)
  }
  return starts.map((start, index): Turn => ({ start, end: starts[index + 1] ?? messages.length }))
}

function hasCompletedAnchor(messages: readonly SessionMessage.Message[], anchorID: SessionMessage.ID) {
  return messages.some((message) => {
    if (message.type !== "compaction") return false
    if (message.id !== anchorID) return false
    return isCompletedCompaction(message)
  })
}

function isCompletedCompaction(message: SessionMessage.Compaction) {
  return message.summary !== "" || message.include !== undefined
}

function latestCompletedSummary(messages: readonly SessionMessage.Message[]) {
  return messages
    .filter((message): message is SessionMessage.Compaction => message.type === "compaction")
    .filter((message) => message.summary !== "")
    .at(-1)?.summary
}

function providerCandidates(messages: readonly SessionMessage.Message[]): ProviderMessage[] {
  return messages.filter((message): message is ProviderMessage => message.type === "user" || message.type === "assistant")
}

function compareMessageToAnchor(message: SessionMessage.Message, anchor: Anchor) {
  const time = DateTime.toEpochMillis(message.time.created) - DateTime.toEpochMillis(anchor.time)
  if (time !== 0) return time
  return compareID(message.id, anchor.id)
}

function compareID(left: string, right: string) {
  return Buffer.from(left).compare(Buffer.from(right))
}

export * as MessageV2Compaction from "./message-v2-compaction"
