export * as SessionV2BackfillReadiness from "./session-v2-backfill-readiness"

import { SessionV2 } from "@opencode-ai/core/session"
import { SessionMessageBackfillService } from "@opencode-ai/core/session/message-backfill-service"
import { Schema } from "effect"

const modelContextSafePendingReasons = new Set<string>(["tool_title_schema_missing", "patch_schema_missing"])
const pendingDrivingBackfillReasons = new Set<string>(SessionMessageBackfillService.pendingUpgradeReasons)

export class BackfillNotReadyError extends Schema.TaggedErrorClass<BackfillNotReadyError>()(
  "SessionV2BackfillReadiness.BackfillNotReadyError",
  {
    sessionID: Schema.String,
    status: Schema.String,
    reason: Schema.optional(Schema.String),
  },
) {}

export function ensureBackfillReady(
  result: SessionMessageBackfillService.Result,
  sessionID: SessionV2.ID | string,
  pendingUpgradeReasons: ReadonlySet<string> = pendingDrivingBackfillReasons,
): BackfillNotReadyError | undefined {
  if (result.status === "completed" || result.status === "already_completed") return undefined
  if (result.status === "upgrade_pending") return pendingBackfillError(result, sessionID, pendingUpgradeReasons)
  return new BackfillNotReadyError({
    sessionID,
    status: result.status,
    reason: "reason" in result ? result.reason : firstStatReason(result.stats.skipped) ?? firstStatReason(result.stats.degraded),
  })
}

function pendingBackfillError(
  result: Extract<SessionMessageBackfillService.Result, { status: "upgrade_pending" }>,
  sessionID: SessionV2.ID | string,
  pendingUpgradeReasons: ReadonlySet<string>,
) {
  const unsafe = [...result.stats.degraded, ...result.stats.skipped].find((stat) => {
    return stat.count > 0 && pendingUpgradeReasons.has(stat.reason) && !modelContextSafePendingReasons.has(stat.reason)
  })
  if (!unsafe) return undefined
  return new BackfillNotReadyError({ sessionID, status: result.status, reason: unsafe.reason })
}

function firstStatReason(stats: readonly { reason: string; count: number }[]) {
  return stats.find((stat) => stat.count > 0)?.reason
}
