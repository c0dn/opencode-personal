export * as SessionCompactionAnchor from "./compaction-anchor"

import { and, desc, eq, gt, lt } from "drizzle-orm"
import { DateTime, Effect, Schema } from "effect"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { EventTable } from "../event/sql"
import { SessionEvent } from "./event"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"

type DatabaseService = Database.Interface["db"]

export type PendingStartedAnchor = {
  seq: number
  id: SessionMessage.ID
  messageID: SessionMessage.ID
  time: DateTime.Utc
  timestamp: DateTime.Utc
  reason: "auto" | "manual"
}

const decodeCompactionStarted = Schema.decodeUnknownSync(SessionEvent.Compaction.Started.data)
const compactionStartedType = synchronizedType(SessionEvent.Compaction.Started)
const compactionEndedType = synchronizedType(SessionEvent.Compaction.Ended)

export function findLatestPendingStarted(input: {
  db: DatabaseService
  sessionID: SessionSchema.ID
  beforeSeq?: number
}) {
  return Effect.gen(function* () {
    const latestPriorEnded = yield* input.db
      .select({ seq: EventTable.seq })
      .from(EventTable)
      .where(
        and(
          eq(EventTable.aggregate_id, input.sessionID),
          eq(EventTable.type, compactionEndedType),
          input.beforeSeq === undefined ? undefined : lt(EventTable.seq, input.beforeSeq),
        ),
      )
      .orderBy(desc(EventTable.seq))
      .limit(1)
      .get()
      .pipe(Effect.orDie)

    const startedRow = yield* input.db
      .select({ seq: EventTable.seq, data: EventTable.data })
      .from(EventTable)
      .where(
        and(
          eq(EventTable.aggregate_id, input.sessionID),
          eq(EventTable.type, compactionStartedType),
          input.beforeSeq === undefined ? undefined : lt(EventTable.seq, input.beforeSeq),
          latestPriorEnded ? gt(EventTable.seq, latestPriorEnded.seq) : undefined,
        ),
      )
      .orderBy(desc(EventTable.seq))
      .limit(1)
      .get()
      .pipe(Effect.orDie)
    if (!startedRow) return

    const started = decodeCompactionStarted(startedRow.data)
    return {
      seq: startedRow.seq,
      id: started.messageID,
      messageID: started.messageID,
      time: started.timestamp,
      timestamp: started.timestamp,
      reason: started.reason,
    } satisfies PendingStartedAnchor
  })
}

function synchronizedType(definition: EventV2.Definition) {
  if (!definition.sync) throw new Error(`Event type ${definition.type} is not synchronized`)
  return EventV2.versionedType(definition.type, definition.sync.version)
}
