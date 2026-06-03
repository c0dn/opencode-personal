export * as PromptV2Context from "./prompt-v2-context"

import { SessionV2 } from "@opencode-ai/core/session"
import { SessionMessageBackfillService } from "@opencode-ai/core/session/message-backfill-service"
import { Effect } from "effect"
import { MessageV2Model } from "./message-v2-model"
import { ensureBackfillReady } from "./session-v2-backfill-readiness"
export { BackfillNotReadyError, ensureBackfillReady } from "./session-v2-backfill-readiness"

export const messages = Effect.fn("PromptV2Context.messages")(function* (sessionID: SessionV2.ID) {
  const backfill = yield* SessionMessageBackfillService.ensureLegacySessionMessagesBackfilled(sessionID).pipe(Effect.orDie)
  const notReady = ensureBackfillReady(backfill, sessionID)
  if (notReady) return yield* notReady

  const session = yield* SessionV2.Service
  // SessionV2.context is intentionally not the readiness gate: today it logs
  // and swallows backfill aborts before reading current v2 rows.
  return yield* session.context(sessionID)
})

export const toModelMessages = Effect.fn("PromptV2Context.toModelMessages")(function* (sessionID: SessionV2.ID) {
  const context = yield* messages(sessionID)
  return yield* Effect.promise(() => MessageV2Model.toModelMessages(context))
})
