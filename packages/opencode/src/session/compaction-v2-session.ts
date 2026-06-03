export * as CompactionV2Session from "./compaction-v2-session"

import { SessionV2 } from "@opencode-ai/core/session"
import { SessionMessageBackfillService } from "@opencode-ai/core/session/message-backfill-service"
import { Effect } from "effect"
import { CompactionV2Context } from "./compaction-v2-context"
import { ensureBackfillReady } from "./session-v2-backfill-readiness"

export const selectForSession = Effect.fn("CompactionV2Session.selectForSession")(function* (
  sessionID: SessionV2.ID,
  options?: CompactionV2Context.SelectionOptions,
) {
  const backfill = yield* SessionMessageBackfillService.ensureLegacySessionMessagesBackfilled(sessionID).pipe(Effect.orDie)
  const notReady = ensureBackfillReady(backfill, sessionID)
  if (notReady) return yield* notReady

  const session = yield* SessionV2.Service
  // SessionV2.messages is intentionally not the readiness gate: today it retries,
  // logs, and swallows backfill aborts/failures before reading current v2 rows.
  const rows = yield* session.messages({ sessionID, order: "asc" })
  return CompactionV2Context.select(rows, options)
})
