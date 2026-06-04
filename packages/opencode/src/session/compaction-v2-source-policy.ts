import { SessionMessage } from "@opencode-ai/core/session/message"
import { DateTime } from "effect"

export type CurrentProcessorResult = {
  summary?: string | null
  include?: string | null
}

export type SelectInput = {
  current?: CurrentProcessorResult
  canonicalCompactions?: readonly SessionMessage.Compaction[]
}

export type SelectedSource = "current-result" | "canonical-compaction"

export type NotReadyReason = "no-exact-source" | "empty-summary"

export type UnsupportedReason = "invalid-include-id"

export type Decision =
  | {
      status: "selected"
      source: SelectedSource
      summary: string
      include?: SessionMessage.ID
      compactionID?: SessionMessage.ID
    }
  | { status: "not-ready"; reason: NotReadyReason; detail?: string; source?: SelectedSource; compactionID?: SessionMessage.ID }
  | { status: "unsupported"; reason: UnsupportedReason; detail: string; source: SelectedSource; compactionID?: SessionMessage.ID }

export function select(input: SelectInput): Decision {
  // Presence of `current` anchors precedence. `current: {}` is an exact current source with an empty summary,
  // not permission to fall back to older canonical rows.
  if (input.current) return selectCurrent(input.current)

  const latest = latestCanonicalCompaction(input.canonicalCompactions ?? [])
  if (!latest) return { status: "not-ready", reason: "no-exact-source" }
  return selectCanonicalCompaction(latest)
}

function selectCurrent(current: CurrentProcessorResult): Decision {
  const summary = normalizeSummary(current.summary)
  if (!summary) return { status: "not-ready", reason: "empty-summary", source: "current-result" }

  const include = normalizeInclude(current.include)
  if (include.status === "invalid") {
    return { status: "unsupported", reason: "invalid-include-id", detail: include.value, source: "current-result" }
  }

  return selected({ source: "current-result", summary, include: include.value })
}

function selectCanonicalCompaction(compaction: SessionMessage.Compaction): Decision {
  const summary = normalizeSummary(compaction.summary)
  if (!summary) {
    return {
      status: "not-ready",
      reason: "empty-summary",
      source: "canonical-compaction",
      compactionID: compaction.id,
    }
  }

  const include = normalizeInclude(compaction.include)
  if (include.status === "invalid") {
    return {
      status: "unsupported",
      reason: "invalid-include-id",
      detail: include.value,
      source: "canonical-compaction",
      compactionID: compaction.id,
    }
  }

  return selected({ source: "canonical-compaction", summary, include: include.value, compactionID: compaction.id })
}

function selected(input: {
  source: SelectedSource
  summary: string
  include?: SessionMessage.ID
  compactionID?: SessionMessage.ID
}): Decision {
  return {
    status: "selected",
    source: input.source,
    summary: input.summary,
    ...(input.include ? { include: input.include } : {}),
    ...(input.compactionID ? { compactionID: input.compactionID } : {}),
  }
}

function latestCanonicalCompaction(compactions: readonly SessionMessage.Compaction[]) {
  return compactions.slice().sort(compareCompactions).at(-1)
}

function compareCompactions(left: SessionMessage.Compaction, right: SessionMessage.Compaction) {
  const time = DateTime.toEpochMillis(left.time.created) - DateTime.toEpochMillis(right.time.created)
  if (time !== 0) return time
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}

function normalizeSummary(summary: string | null | undefined) {
  // Trim is only for blank detection; preserve non-blank whitespace verbatim.
  if (!summary || summary.trim() === "") return undefined
  return summary
}

function normalizeInclude(include: string | null | undefined): { status: "valid"; value?: SessionMessage.ID } | { status: "invalid"; value: string } {
  if (!include) return { status: "valid" }
  if (isCanonicalID(include)) return { status: "valid", value: SessionMessage.ID.make(include) }
  return { status: "invalid", value: include }
}

function isCanonicalID(value: string) {
  return /^evt_[A-Za-z0-9_-]+$/.test(value)
}

export * as CompactionV2SourcePolicy from "./compaction-v2-source-policy"
