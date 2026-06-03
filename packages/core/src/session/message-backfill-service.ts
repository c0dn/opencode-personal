export * as SessionMessageBackfillService from "./message-backfill-service"

import { and, asc, eq, inArray, sql } from "drizzle-orm"
import { DateTime, Effect, Schema } from "effect"
import { DataMigrationTable } from "../data-migration.sql"
import { Database } from "../database/database"
import { SessionLegacy } from "./legacy"
import { SessionMessage } from "./message"
import { SessionMessageBackfill } from "./message-backfill"
import { MessageTable, PartTable, SessionMessageTable } from "./sql"
import { SessionSchema } from "./schema"

export const v1MarkerPrefix = "legacy-session-message-backfill/v1/"
export const v2MarkerPrefix = "legacy-session-message-backfill/v2/"
// Reserved prefix for migration-owned rows; there is no private provenance column
// to distinguish safe repair targets from live projector/API rows.
const backfillIDPrefix = "evt_legacy_backfill_"
const encodeMessage = Schema.encodeSync(SessionMessage.Message)
type Transaction = Parameters<Parameters<Database.Interface["db"]["transaction"]>[0]>[0]

export type AbortReason = "mixed_cutoff_ambiguous" | "deterministic_id_collision"

export type Result =
  | { status: "completed"; stats: SessionMessageBackfill.Stats; inserted: number; repaired: number }
  | { status: "upgrade_pending"; stats: SessionMessageBackfill.Stats; inserted: number; repaired: number }
  | { status: "upgrade_unavailable"; stats: SessionMessageBackfill.Stats; inserted: number; repaired: number }
  | { status: "already_completed" }
  | { status: "aborted"; reason: AbortReason; stats: SessionMessageBackfill.Stats }

export const ensureLegacySessionMessagesBackfilled = Effect.fn("SessionMessageBackfillService.ensureLegacySessionMessagesBackfilled")(
  function* (sessionID: SessionSchema.ID | string) {
    const { db } = yield* Database.Service
    const marker = markerNames(sessionID)
    if (yield* hasMarker(db, marker.v2)) return { status: "already_completed" } as Result

    return yield* db
      .transaction(
        (tx) =>
          Effect.gen(function* () {
            if (yield* hasMarker(tx, marker.v2)) return { status: "already_completed" } as Result
            const hasV1Marker = yield* hasMarker(tx, marker.v1)

            const cutoff = yield* tx
              .select({ id: SessionMessageTable.id, time_created: SessionMessageTable.time_created })
              .from(SessionMessageTable)
              .where(
                and(
                  eq(SessionMessageTable.session_id, SessionSchema.ID.make(sessionID)),
                  sql`${SessionMessageTable.id} NOT LIKE ${`${backfillIDPrefix}%`}`,
                ),
              )
              .orderBy(asc(SessionMessageTable.time_created), asc(SessionMessageTable.id))
              .limit(1)
              .get()

            const legacyMessages = yield* hydrateLegacyMessages(sessionID, tx)
            if (hasV1Marker && legacyMessages.length === 0) {
              return {
                status: "upgrade_unavailable",
                stats: { mapped: [], degraded: [], skipped: [{ type: "backfill", reason: "legacy_source_unavailable", count: 1 }] },
                inserted: 0,
                repaired: 0,
              } as Result
            }
            if (cutoff && legacyMessages.some((message) => message.info.time.created === cutoff.time_created)) {
              return abort("mixed_cutoff_ambiguous", { mapped: [], degraded: [], skipped: [] })
            }

            const eligible = cutoff
              ? legacyMessages.filter((message) => message.info.time.created < cutoff.time_created)
              : legacyMessages
            const mapped = SessionMessageBackfill.mapLegacyMessages(eligible, { sessionID })
            if (cutoff) {
              legacyMessages
                .filter((message) => message.info.time.created > cutoff.time_created)
                .forEach(() => addStat(mapped.stats.skipped, "backfill", "legacy_newer_than_cutoff_omitted"))
            }
            const rows = mapped.messages.map((message) => targetRow(sessionID, message))
            const existingRows = rows.length === 0
              ? []
              : yield* tx
                  .select()
                  .from(SessionMessageTable)
                  .where(inArray(SessionMessageTable.id, rows.map((row) => row.id)))
                  .all()
            const collision = existingRows.find((row) => !isBackfillRow(row.id))
            if (collision) return abort("deterministic_id_collision", mapped.stats)
            const targetRowsAlreadyExact =
              rows.length > 0 && existingRows.length === rows.length && existingRows.every((row) => rowMatchesTarget(row, rows))

            if (rows.length > 0 && !targetRowsAlreadyExact) {
              yield* tx
                .insert(SessionMessageTable)
                .values(rows)
                .onConflictDoUpdate({
                  target: SessionMessageTable.id,
                  set: {
                    session_id: sql`excluded.session_id`,
                    type: sql`excluded.type`,
                    time_created: sql`excluded.time_created`,
                    data: sql`excluded.data`,
                  },
                })
                .run()
            }
            if (!hasV1Marker) yield* writeMarker(tx, marker.v1)
            const status = hasDeferredV2Inputs(mapped.stats) ? "upgrade_pending" : "completed"
            if (status === "completed") yield* writeMarker(tx, marker.v2)
            return {
              status,
              stats: mapped.stats,
              inserted: targetRowsAlreadyExact ? 0 : rows.length - existingRows.length,
              repaired: targetRowsAlreadyExact ? 0 : existingRows.length,
            } as Result
          }),
        { behavior: "immediate" },
      )
      .pipe(Effect.tap((result) => logResult(sessionID, result)))
      .pipe(Effect.orDie)
  },
)

function logResult(sessionID: SessionSchema.ID | string, result: Result) {
  if (result.status === "already_completed") return Effect.void
  if (
    (result.status === "completed" || result.status === "upgrade_pending" || result.status === "upgrade_unavailable") &&
    result.inserted === 0 &&
    result.repaired === 0 &&
    result.stats.degraded.length === 0 &&
    result.stats.skipped.length === 0
  )
    return Effect.void
  return (result.status === "completed" ? Effect.logInfo : Effect.logWarning)(
    `legacy session message backfill ${result.status}`,
  ).pipe(
    Effect.annotateLogs({
      sessionID,
      status: result.status,
      inserted: "inserted" in result ? result.inserted : 0,
      repaired: "repaired" in result ? result.repaired : 0,
      ...(result.status === "aborted" ? { reason: result.reason } : {}),
      mapped: summarizeStats(result.stats.mapped),
      degraded: summarizeStats(result.stats.degraded),
      skipped: summarizeStats(result.stats.skipped),
    }),
  )
}

function markerNames(sessionID: SessionSchema.ID | string) {
  return { v1: `${v1MarkerPrefix}${sessionID}`, v2: `${v2MarkerPrefix}${sessionID}` }
}

function hasMarker(db: Transaction | Database.Interface["db"], marker: string) {
  return Effect.gen(function* () {
    return !!(yield* db.select({ name: DataMigrationTable.name }).from(DataMigrationTable).where(eq(DataMigrationTable.name, marker)).get())
  })
}

function writeMarker(db: Transaction, marker: string) {
  return db.insert(DataMigrationTable).values({ name: marker, time_completed: Date.now() }).run()
}

function isBackfillRow(id: string) {
  return id.startsWith(backfillIDPrefix)
}

function rowMatchesTarget(row: typeof SessionMessageTable.$inferSelect, targets: (typeof SessionMessageTable.$inferInsert)[]) {
  const target = targets.find((candidate) => candidate.id === row.id)
  return (
    !!target &&
    row.session_id === target.session_id &&
    row.type === target.type &&
    row.time_created === target.time_created &&
    JSON.stringify(row.data) === JSON.stringify(target.data)
  )
}

export const pendingUpgradeReasons = [
  "patch_schema_missing",
  "tool_title_schema_missing",
] as const
const pendingUpgradeReasonSet = new Set<string>(pendingUpgradeReasons)

function hasDeferredV2Inputs(stats: SessionMessageBackfill.Stats) {
  return [...stats.skipped, ...stats.degraded].some((stat) => pendingUpgradeReasonSet.has(stat.reason) && stat.count > 0)
}

function summarizeStats(stats: SessionMessageBackfill.Stat[]) {
  return stats.map((stat) => `${stat.type}:${stat.reason}=${stat.count}`)
}

function hydrateLegacyMessages(sessionID: SessionSchema.ID | string, db: Transaction) {
  return Effect.gen(function* () {
    const messages = yield* db
      .select()
      .from(MessageTable)
      .where(eq(MessageTable.session_id, SessionSchema.ID.make(sessionID)))
      .orderBy(asc(MessageTable.time_created), asc(MessageTable.id))
      .all()
    const parts = yield* db
      .select()
      .from(PartTable)
      .where(eq(PartTable.session_id, SessionSchema.ID.make(sessionID)))
      .orderBy(asc(PartTable.message_id), asc(PartTable.id))
      .all()
    const partsByMessage = new Map(
      messages.map((message) => [
        message.id,
        parts
          .filter((part) => part.message_id === message.id)
          .map((part) => ({ ...part.data, id: part.id, sessionID: part.session_id, messageID: part.message_id } as SessionLegacy.Part)),
      ]),
    )
    return messages.map((message) => ({
      info: { ...message.data, id: message.id, sessionID: message.session_id } as SessionLegacy.Info,
      parts: partsByMessage.get(message.id) ?? [],
    }))
  })
}

function targetRow(sessionID: SessionSchema.ID | string, message: SessionMessage.Message): typeof SessionMessageTable.$inferInsert {
  const encoded = encodeMessage(message)
  const { id, type, ...data } = encoded
  return {
    id: SessionMessage.ID.make(id),
    session_id: SessionSchema.ID.make(sessionID),
    type,
    time_created: DateTime.toEpochMillis(message.time.created),
    data,
  }
}

function abort(reason: AbortReason, stats: SessionMessageBackfill.Stats): Result {
  addStat(stats.skipped, "backfill", reason)
  return { status: "aborted", reason, stats }
}

function addStat(stats: SessionMessageBackfill.Stat[], type: string, reason: string) {
  const existing = stats.find((stat) => stat.type === type && stat.reason === reason)
  if (existing) {
    existing.count++
    return
  }
  stats.push({ type, reason, count: 1 })
}
