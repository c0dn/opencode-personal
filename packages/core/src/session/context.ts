import { and, asc, desc, eq, gte, lt } from "drizzle-orm"
import { Effect, Option, Schema } from "effect"
import { Database } from "../database/database"
import { MessageDecodeError } from "./error"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { SessionMessageTable } from "./sql"

type DatabaseService = Database.Interface["db"]

const decode = Schema.decodeUnknownEffect(SessionMessage.Message)
const decodeMessageID = Schema.decodeUnknownOption(SessionMessage.ID)

export const load = Effect.fn("SessionContext.load")(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  const compaction = yield* db
    .select()
    .from(SessionMessageTable)
    .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "compaction")))
    .orderBy(desc(SessionMessageTable.seq))
    .limit(1)
    .get()
    .pipe(Effect.orDie)

  if (!compaction) {
    const rows = yield* db
      .select()
      .from(SessionMessageTable)
      .where(eq(SessionMessageTable.session_id, sessionID))
      .orderBy(asc(SessionMessageTable.seq))
      .all()
      .pipe(Effect.orDie)
    return yield* decodeRows(rows)
  }

  const include = getCompactionInclude(compaction)
  const includeRow = include
    ? yield* db
        .select({ seq: SessionMessageTable.seq })
        .from(SessionMessageTable)
        .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.id, include)))
        .get()
        .pipe(Effect.orDie)
    : undefined
  const includeSeq = includeRow && includeRow.seq < compaction.seq ? includeRow.seq : undefined
  const anchorAndAfterRows = yield* db
    .select()
    .from(SessionMessageTable)
    .where(and(eq(SessionMessageTable.session_id, sessionID), gte(SessionMessageTable.seq, compaction.seq)))
    .orderBy(asc(SessionMessageTable.seq))
    .all()
    .pipe(Effect.orDie)

  if (includeSeq === undefined) return yield* decodeRows(anchorAndAfterRows)

  const includedTailRows = yield* db
    .select()
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, sessionID),
        gte(SessionMessageTable.seq, includeSeq),
        lt(SessionMessageTable.seq, compaction.seq),
      ),
    )
    .orderBy(asc(SessionMessageTable.seq))
    .all()
    .pipe(Effect.orDie)

  const anchor = anchorAndAfterRows.slice(0, 1)
  const afterAnchor = anchorAndAfterRows.slice(1)
  return yield* decodeRows([...anchor, ...includedTailRows, ...afterAnchor])
})

function getCompactionInclude(row: typeof SessionMessageTable.$inferSelect) {
  const data = row.data
  if (!data || typeof data !== "object") return undefined
  if (!("include" in data)) return undefined
  if (typeof data.include !== "string") return undefined
  return Option.getOrUndefined(decodeMessageID(data.include))
}

function decodeRows(rows: (typeof SessionMessageTable.$inferSelect)[]) {
  return Effect.forEach(rows, (row) =>
    decode({ ...row.data, id: row.id, type: row.type }).pipe(
      Effect.mapError(
        () =>
          new MessageDecodeError({
            sessionID: SessionSchema.ID.make(row.session_id),
            messageID: SessionMessage.ID.make(row.id),
          }),
      ),
    ),
  )
}

export * as SessionContext from "./context"
