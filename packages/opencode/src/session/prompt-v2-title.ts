import type { SessionMessageBackfillService } from "@opencode-ai/core/session/message-backfill-service"

export type BackfillReadiness =
  | { status: "ready" }
  | { status: "not-ready"; reason?: string }
  | { status: "ambiguous"; reason?: string }

export type TitleFile = {
  uri: string
  mime: string
  name?: string
}

export type TitleTaskRequest = {
  prompt: string
}

export type TitleMessage = {
  type: string
  text?: string
  files?: readonly TitleFile[]
  taskRequests?: readonly TitleTaskRequest[]
}

export type DecideInput = {
  readiness: BackfillReadiness
  session: {
    parentID?: string | null
    isDefaultTitle: boolean
  }
  messages: readonly TitleMessage[]
}

export type GenerateSource = {
  mode: "visible-user" | "task-requests"
  text: string
  files: readonly TitleFile[]
}

export type SkipReason =
  | "backfill-not-ready"
  | "backfill-ambiguous"
  | "parent-session"
  | "non-default-title"
  | "no-real-user"
  | "empty-title-source"

export type Decision =
  | { type: "generate"; source: GenerateSource }
  | { type: "skip"; reason: SkipReason; detail?: string }

const titleSourceSafePendingReasons = new Set(["tool_title_schema_missing", "patch_schema_missing"])

export function classifyBackfillTitleReadiness(
  result: SessionMessageBackfillService.Result,
): BackfillReadiness {
  switch (result.status) {
    case "completed":
    case "already_completed":
      return { status: "ready" }
    case "upgrade_pending":
      return allPendingReasonsAreTitleSourceSafe(result.stats) ? { status: "ready" } : { status: "not-ready", reason: "upgrade_pending" }
    case "upgrade_unavailable":
      return { status: "not-ready", reason: "upgrade_unavailable" }
    case "aborted":
      return result.reason === "mixed_cutoff_ambiguous"
        ? { status: "ambiguous", reason: result.reason }
        : { status: "not-ready", reason: result.reason }
  }
}

export function classifyBackfillTitleFailure(): BackfillReadiness {
  return { status: "not-ready", reason: "backfill_failed" }
}

export function decide(input: DecideInput): Decision {
  // Readiness gates title decisions first so canonical-row ambiguity never
  // falls through into parent/default-title/source checks.
  const readinessSkip = skipForReadiness(input.readiness)
  if (readinessSkip) return readinessSkip
  if (input.session.parentID) return { type: "skip", reason: "parent-session" }
  if (!input.session.isDefaultTitle) return { type: "skip", reason: "non-default-title" }

  const firstUser = input.messages.find((message) => message.type === "user")
  if (!firstUser) return { type: "skip", reason: "no-real-user" }

  const source = sourceForUser(firstUser)
  if (source.text.trim() === "" && source.files.length === 0) return { type: "skip", reason: "empty-title-source" }
  return { type: "generate", source }
}

function skipForReadiness(readiness: BackfillReadiness): Decision | undefined {
  if (readiness.status === "ready") return undefined
  if (readiness.status === "ambiguous") {
    return { type: "skip", reason: "backfill-ambiguous", detail: readiness.reason }
  }
  return { type: "skip", reason: "backfill-not-ready", detail: readiness.reason }
}

function sourceForUser(user: TitleMessage): GenerateSource {
  if (isTaskRequestsOnly(user)) {
    return {
      mode: "task-requests",
      text: user.taskRequests!.map((request) => request.prompt).join("\n"),
      files: [],
    }
  }

  return {
    mode: "visible-user",
    text: user.text ?? "",
    files: [...(user.files ?? [])],
  }
}

function isTaskRequestsOnly(user: TitleMessage) {
  return (user.taskRequests?.length ?? 0) > 0 && (user.text ?? "").trim() === "" && (user.files?.length ?? 0) === 0
}

function allPendingReasonsAreTitleSourceSafe(stats: Extract<SessionMessageBackfillService.Result, { status: "upgrade_pending" }>["stats"]) {
  const pending = [...stats.skipped, ...stats.degraded].filter((stat) => stat.count > 0)
  return pending.every((stat) => titleSourceSafePendingReasons.has(stat.reason))
}

export * as PromptV2Title from "./prompt-v2-title"
