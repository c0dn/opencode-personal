export * as TranscriptV2PublicExport from "./transcript-v2-public-export"

import { Cause, Effect, Schema } from "effect"
import { asc, eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionMessageBackfillService } from "@opencode-ai/core/session/message-backfill-service"
import { SessionMessageTable } from "@opencode-ai/core/session/sql"
import { Session } from "./session"
import { TranscriptV2PublicPayload } from "./transcript-v2-public-payload"

export class PublicTranscriptExportError extends Schema.TaggedErrorClass<PublicTranscriptExportError>()(
  "TranscriptV2PublicExport.PublicTranscriptExportError",
  {
    message: Schema.String,
  },
) {}

export type PublicTranscriptExportDeps<R = never> = {
  getSessionInfo: (sessionID: SessionV2.ID) => Effect.Effect<Session.Info, unknown, R>
  ensureBackfilled: (
    sessionID: SessionV2.ID,
  ) => Effect.Effect<SessionMessageBackfillService.Result, unknown, R>
  readMessages: (input: { sessionID: SessionV2.ID; order: "asc" }) => Effect.Effect<SessionMessage.Message[], unknown, R>
}

export const loadPublicTranscriptPayloadV2 = Effect.fn("TranscriptV2PublicExport.loadPublicTranscriptPayloadV2")(
  function* (sessionID: SessionV2.ID) {
    const sessions = yield* Session.Service
    return yield* loadPublicTranscriptPayloadV2WithDeps(sessionID, {
      getSessionInfo: (id) => sessions.get(id),
      ensureBackfilled: (id) => SessionMessageBackfillService.ensureLegacySessionMessagesBackfilled(id),
      readMessages: (input) => readCanonicalMessages(input),
    })
  },
)

export const loadPublicTranscriptPayloadV2WithDeps = Effect.fn(
  "TranscriptV2PublicExport.loadPublicTranscriptPayloadV2WithDeps",
)(function* <R>(sessionID: SessionV2.ID, deps: PublicTranscriptExportDeps<R>) {
  const sessionInfo = yield* mapExportFailure(deps.getSessionInfo(sessionID), sessionID, "load session")
  const backfill = yield* mapExportFailure(deps.ensureBackfilled(sessionID), sessionID, "backfill legacy messages")
  const readiness = readinessFromBackfillResult(backfill)
  if (readiness.status !== "ready") return yield* notReady(sessionID, readiness)

  const messages = yield* mapExportFailure(deps.readMessages({ sessionID, order: "asc" }), sessionID, "read v2 messages")
  return yield* Effect.try({
    try: () => TranscriptV2PublicPayload.toPublicTranscriptPayloadV2(sessionInfo, messages, readiness),
    catch: (error) =>
      new PublicTranscriptExportError({
        message: `V2 export payload could not be built for session ${sessionID}: ${errorMessage(error)}`,
      }),
  })
})

export function readinessFromBackfillResult(
  result: SessionMessageBackfillService.Result | { status: string; reason?: string; stats?: BackfillStats },
): TranscriptV2PublicPayload.PublicTranscriptReadiness {
  if (result.status === "completed" || result.status === "already_completed") return { status: "ready" }
  return {
    status: result.status,
    ...("reason" in result && result.reason
      ? { reason: result.reason }
      : { reason: firstBackfillReason("stats" in result ? result.stats : undefined) }),
  }
}

function notReady(
  sessionID: SessionV2.ID,
  readiness: Exclude<TranscriptV2PublicPayload.PublicTranscriptReadiness, { status: "ready" }>,
) {
  return new PublicTranscriptExportError({
    message: `V2 export is not ready for session ${sessionID}: ${readiness.status}${readiness.reason ? ` (${readiness.reason})` : ""}`,
  })
}

function mapExportFailure<A, R>(effect: Effect.Effect<A, unknown, R>, sessionID: SessionV2.ID, action: string) {
  return effect.pipe(
    Effect.catchCause((cause) =>
      Effect.fail(
        new PublicTranscriptExportError({
          message: `V2 export failed to ${action} for session ${sessionID}: ${Cause.pretty(cause)}`,
        }),
      ),
    ),
  )
}

const decodeMessage = Schema.decodeUnknownEffect(SessionMessage.Message)

const readCanonicalMessages = Effect.fn("TranscriptV2PublicExport.readCanonicalMessages")(function* (input: {
  sessionID: SessionV2.ID
  order: "asc"
}) {
  const { db } = yield* Database.Service
  const rows = yield* db
    .select()
    .from(SessionMessageTable)
    .where(eq(SessionMessageTable.session_id, input.sessionID))
    .orderBy(asc(SessionMessageTable.time_created), asc(SessionMessageTable.id))
    .all()
  return yield* Effect.forEach(rows, (row) => decodeMessage({ ...row.data, id: row.id, type: row.type }))
})

type BackfillStats = {
  degraded?: readonly { reason: string; count: number }[]
  skipped?: readonly { reason: string; count: number }[]
}

function firstBackfillReason(stats: BackfillStats | undefined) {
  return [...(stats?.skipped ?? []), ...(stats?.degraded ?? [])].find((stat) => stat.count > 0)?.reason
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
