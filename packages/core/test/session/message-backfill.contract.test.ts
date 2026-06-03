import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { asc, eq, sql } from "drizzle-orm"
import { DateTime, Effect, Schema } from "effect"
import { DataMigrationTable } from "@opencode-ai/core/data-migration.sql"
import { Database } from "@opencode-ai/core/database/database"
import { ProviderV2 } from "@opencode-ai/core/provider"
import type { DeepMutable } from "@opencode-ai/core/schema"
import { SessionLegacy } from "@opencode-ai/core/session/legacy"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionMessageBackfill } from "@opencode-ai/core/session/message-backfill"
import { SessionMessageBackfillService } from "@opencode-ai/core/session/message-backfill-service"
import { MessageTable, PartTable, SessionMessageTable } from "@opencode-ai/core/session/sql"
import { SessionSchema } from "@opencode-ai/core/session/schema"

const tmp = new Array<string>()
const sessionID = SessionSchema.ID.make("ses_message_backfill_contract")
const providerID = ProviderV2.ID.make("provider")
const modelID = ProviderV2.ModelID.make("model")
const v1MarkerName = `legacy-session-message-backfill/v1/${sessionID}`
const v2MarkerName = `legacy-session-message-backfill/v2/${sessionID}`
const encodeMessage = Schema.encodeSync(SessionMessage.Message)
const decodeMessage = Schema.decodeUnknownSync(SessionMessage.Message)

afterEach(async () => {
  await Promise.all(tmp.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function makeDbPath() {
  const dir = await mkdtemp(join(tmpdir(), "opencode-message-backfill-contract-"))
  tmp.push(dir)
  return join(dir, "backfill.db")
}

function layer(filename: string) {
  return Database.layerFromPath(filename)
}

function run<A, E>(filename: string, effect: Effect.Effect<A, E, Database.Service>) {
  return Effect.runPromise(effect.pipe(Effect.provide(layer(filename)), Effect.scoped))
}

function user(id: string, created: number, value: string): SessionLegacy.WithParts {
  return {
    info: {
      id: SessionLegacy.MessageID.make(id),
      sessionID,
      role: "user",
      time: { created },
      agent: "build",
      model: { providerID, modelID },
    },
    parts: [text(id, `${id.replace("msg", "prt")}_text`, value)],
  }
}

function assistant(id: string, created: number, parts: SessionLegacy.Part[]): SessionLegacy.WithParts {
  return {
    info: {
      id: SessionLegacy.MessageID.make(id),
      sessionID,
      role: "assistant",
      parentID: SessionLegacy.MessageID.make("msg_parent"),
      time: { created, completed: created + 10 },
      providerID,
      modelID,
      mode: "build",
      agent: "build",
      path: { cwd: "/tmp/work", root: "/tmp/work" },
      cost: 0.12,
      tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } },
    },
    parts,
  }
}

function text(messageID: string, id: string, value: string): SessionLegacy.TextPart {
  return {
    id: SessionLegacy.PartID.make(id),
    sessionID,
    messageID: SessionLegacy.MessageID.make(messageID),
    type: "text",
    text: value,
  }
}

function subtask(messageID: string, id: string): SessionLegacy.SubtaskPart {
  return {
    id: SessionLegacy.PartID.make(id),
    sessionID,
    messageID: SessionLegacy.MessageID.make(messageID),
    type: "subtask",
    prompt: "check this",
    description: "review",
    agent: "reviewer",
    model: { providerID, modelID },
    command: "review-code",
  }
}

function patch(messageID: string, id: string): SessionLegacy.PatchPart {
  return {
    id: SessionLegacy.PartID.make(id),
    sessionID,
    messageID: SessionLegacy.MessageID.make(messageID),
    type: "patch",
    hash: "abc123",
    files: ["README.md"],
  }
}

function snapshot(messageID: string, id: string): SessionLegacy.SnapshotPart {
  return {
    id: SessionLegacy.PartID.make(id),
    sessionID,
    messageID: SessionLegacy.MessageID.make(messageID),
    type: "snapshot",
    snapshot: "standalone",
  }
}

function completedTool(messageID: string, id: string): SessionLegacy.ToolPart {
  return {
    id: SessionLegacy.PartID.make(id),
    sessionID,
    messageID: SessionLegacy.MessageID.make(messageID),
    type: "tool",
    callID: "call_1",
    tool: "bash",
    state: {
      status: "completed",
      input: { cmd: "pwd" },
      output: "done",
      title: "Run command",
      metadata: {},
      time: { start: 12, end: 13 },
    },
  }
}

function liveUser(id: string, created: number, value: string) {
  return new SessionMessage.User({
    id: SessionMessage.ID.make(id),
    type: "user",
    text: value,
    files: [],
    agents: [],
    references: [],
    time: { created: DateTime.makeUnsafe(created) },
  })
}

function seedSession() {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db.run(sql`
      INSERT INTO project (id, worktree, name, time_created, time_updated, sandboxes)
      VALUES ('proj_message_backfill', '/tmp/backfill', 'backfill', 1, 1, '[]')
    `)
    yield* db.run(sql`
      INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
      VALUES (${sessionID}, 'proj_message_backfill', 'backfill', '/tmp/backfill', 'backfill', 'test', 1, 1)
    `)
  })
}

function seedLegacy(entries: SessionLegacy.WithParts[]) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db.insert(MessageTable).values(entries.map((entry) => messageRow(entry.info))).run()
    const parts = entries.flatMap((entry) => entry.parts.map(partRow))
    if (parts.length > 0) yield* db.insert(PartTable).values(parts).run()
  })
}

function seedV2(message: SessionMessage.Message) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db.insert(SessionMessageTable).values([v2Row(message)]).run()
  })
}

function seedMarker(name = v1MarkerName) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db.insert(DataMigrationTable).values({ name, time_completed: 1 }).run()
  })
}

function readV2Rows() {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    return yield* db
      .select()
      .from(SessionMessageTable)
      .where(eq(SessionMessageTable.session_id, sessionID))
      .orderBy(asc(SessionMessageTable.time_created), asc(SessionMessageTable.id))
      .all()
  })
}

function markerExists(name = v1MarkerName) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    return !!(yield* db.select().from(DataMigrationTable).where(eq(DataMigrationTable.name, name)).get())
  })
}

function messageRow(info: SessionLegacy.Info): typeof MessageTable.$inferInsert {
  const { id, sessionID: rowSessionID, ...data } = info
  return { id, session_id: rowSessionID, time_created: info.time.created, data: data as DeepMutable<typeof data> }
}

function partRow(part: SessionLegacy.Part): typeof PartTable.$inferInsert {
  const { id, sessionID: rowSessionID, messageID, ...data } = part
  return { id, session_id: rowSessionID, message_id: messageID, time_created: 1, data: data as DeepMutable<typeof data> }
}

function v2Row(message: SessionMessage.Message): typeof SessionMessageTable.$inferInsert {
  const encoded = encodeMessage(message)
  const { id, type, ...data } = encoded
  return { id: SessionMessage.ID.make(id), session_id: sessionID, type, time_created: DateTime.toEpochMillis(message.time.created), data }
}

function expectedRows(entries: SessionLegacy.WithParts[]) {
  return SessionMessageBackfill.mapLegacyMessages(entries, { sessionID }).messages.map(v2Row)
}

function assertNoLegacyIDs(value: unknown) {
  const encoded = JSON.stringify(value)
  expect(encoded).not.toContain("msg_")
  expect(encoded).not.toContain("prt_")
}

function statCount(stats: SessionMessageBackfill.Stat[], reason: string) {
  return stats.find((stat) => stat.reason === reason)?.count ?? 0
}

describe("SessionMessageBackfillService contract", () => {
  test("no marker: legacy rows become v2 rows and marker is written", async () => {
    const dbPath = await makeDbPath()
    const entries = [user("msg_first", 10, "first visible"), user("msg_second", 20, "second visible")]

    await run(
      dbPath,
      Effect.gen(function* () {
        yield* seedSession()
        yield* seedLegacy(entries)

        const result = yield* SessionMessageBackfillService.ensureLegacySessionMessagesBackfilled(sessionID)
        const rows = yield* readV2Rows()

        expect(result.status).toBe("completed")
        if (result.status !== "completed") throw new Error("expected completed")
        expect(result.inserted).toBe(2)
        expect(result.repaired).toBe(0)
        expect(yield* markerExists()).toBe(true)
        expect(yield* markerExists(v2MarkerName)).toBe(true)
        expect(rows.map((row) => decodeMessage({ ...row.data, id: row.id, type: row.type }).type)).toEqual(["user", "user"])
        expect(rows.map((row) => row.id)).toEqual(expectedRows(entries).map((row) => row.id))
        assertNoLegacyIDs(rows)
      }),
    )
  })

  test("marker write failure rolls back inserted rows and marker", async () => {
    const dbPath = await makeDbPath()
    const entries = [user("msg_rollback_a", 10, "rollback a"), user("msg_rollback_b", 20, "rollback b")]

    await run(
      dbPath,
      Effect.gen(function* () {
        yield* seedSession()
        yield* seedLegacy(entries)
        yield* failBackfillMarkerInsert()

        const exit = yield* SessionMessageBackfillService.ensureLegacySessionMessagesBackfilled(sessionID).pipe(Effect.exit)

        expect(exit._tag).toBe("Failure")
        expect(yield* readV2Rows()).toEqual([])
        expect(yield* markerExists()).toBe(false)
      }),
    )
  })

  test("v2 marker exists: returns already_completed and does not trip marker insert trigger", async () => {
    const dbPath = await makeDbPath()

    await run(
      dbPath,
      Effect.gen(function* () {
        yield* seedSession()
        yield* seedLegacy([user("msg_marked", 10, "already marked")])
        yield* seedMarker(v2MarkerName)
        yield* failBackfillMarkerInsert()

        const result = yield* SessionMessageBackfillService.ensureLegacySessionMessagesBackfilled(sessionID)

        expect(result.status).toBe("already_completed")
        expect(yield* readV2Rows()).toEqual([])
      }),
    )
  })

  test("v1 marker alone upgrades, materializes rows, and writes v2 marker when no deferred inputs", async () => {
    const dbPath = await makeDbPath()
    const entries = [user("msg_v1_upgrade", 10, "upgrade me")]

    await run(
      dbPath,
      Effect.gen(function* () {
        yield* seedSession()
        yield* seedLegacy(entries)
        yield* seedMarker(v1MarkerName)

        const result = yield* SessionMessageBackfillService.ensureLegacySessionMessagesBackfilled(sessionID)
        const rows = yield* readV2Rows()

        expect(result.status).toBe("completed")
        if (result.status !== "completed") throw new Error("expected completed")
        expect(result.inserted).toBe(1)
        expect(result.repaired).toBe(0)
        expect(yield* markerExists(v1MarkerName)).toBe(true)
        expect(yield* markerExists(v2MarkerName)).toBe(true)
        expect(rows.map((row) => row.id)).toEqual(expectedRows(entries).map((row) => row.id))
      }),
    )
  })

  test("v1 marker with exact existing rows writes v2 marker without duplicate or repair churn", async () => {
    const dbPath = await makeDbPath()
    const entries = [user("msg_v1_existing", 10, "existing")]

    await run(
      dbPath,
      Effect.gen(function* () {
        yield* seedSession()
        yield* seedLegacy(entries)
        yield* seedMarker(v1MarkerName)
        yield* dbInsertSessionMessage(expectedRows(entries)[0]!)

        const result = yield* SessionMessageBackfillService.ensureLegacySessionMessagesBackfilled(sessionID)
        const rows = yield* readV2Rows()

        expect(result.status).toBe("completed")
        if (result.status !== "completed") throw new Error("expected completed")
        expect(result.inserted).toBe(0)
        expect(result.repaired).toBe(0)
        expect(rows).toHaveLength(1)
        expect(yield* markerExists(v2MarkerName)).toBe(true)
      }),
    )
  })

  test("user task-request-only session completes and writes v2 marker", async () => {
    const dbPath = await makeDbPath()
    const entry = user("msg_task_request_only", 10, "")
    entry.parts.push(subtask("msg_task_request_only", "prt_task_request"))

    await run(
      dbPath,
      Effect.gen(function* () {
        yield* seedSession()
        yield* seedLegacy([entry])

        const result = yield* SessionMessageBackfillService.ensureLegacySessionMessagesBackfilled(sessionID)

        const rows = yield* readV2Rows()
        const decoded = rows.map((row) => decodeMessage({ ...row.data, id: row.id, type: row.type }))

        expect(result.status).toBe("completed")
        if (result.status !== "completed") throw new Error("expected completed")
        expect(result.inserted).toBe(1)
        expect(statCount(result.stats.mapped, "user_task_request")).toBe(1)
        expect(statCount(result.stats.skipped, "subtask_schema_missing")).toBe(0)
        expect(decoded[0]).toMatchObject({
          type: "user",
          text: "",
          taskRequests: [{ type: "task-request", prompt: "check this", description: "review", agent: "reviewer", command: "review-code" }],
        })
        expect(yield* markerExists(v1MarkerName)).toBe(true)
        expect(yield* markerExists(v2MarkerName)).toBe(true)
        assertNoLegacyIDs(rows)
      }),
    )
  })

  test("parentage-unsupported subtask sessions complete and write v2 marker", async () => {
    const dbPath = await makeDbPath()
    const entry = assistant("msg_subtask_unsupported", 10, [subtask("msg_subtask_unsupported", "prt_subtask")])

    await run(
      dbPath,
      Effect.gen(function* () {
        yield* seedSession()
        yield* seedLegacy([entry])

        const result = yield* SessionMessageBackfillService.ensureLegacySessionMessagesBackfilled(sessionID)

        expect(result.status).toBe("completed")
        if (result.status !== "completed") throw new Error("expected completed")
        expect(statCount(result.stats.skipped, "subtask_parentage_unsupported")).toBe(1)
        expect(statCount(result.stats.skipped, "subtask_schema_missing")).toBe(0)
        expect(yield* markerExists(v2MarkerName)).toBe(true)
      }),
    )
  })

  test("assistant patch-only legacy session completes and writes v2 marker", async () => {
    const dbPath = await makeDbPath()
    const entry = assistant("msg_patch_only", 10, [patch("msg_patch_only", "prt_patch")])

    await run(
      dbPath,
      Effect.gen(function* () {
        yield* seedSession()
        yield* seedLegacy([entry])

        const result = yield* SessionMessageBackfillService.ensureLegacySessionMessagesBackfilled(sessionID)
        const rows = yield* readV2Rows()
        const decoded = rows.map((row) => decodeMessage({ ...row.data, id: row.id, type: row.type }))

        expect(result.status).toBe("completed")
        if (result.status !== "completed") throw new Error("expected completed")
        expect(statCount(result.stats.mapped, "assistant_patch")).toBe(1)
        expect(decoded[0]).toMatchObject({ type: "assistant", content: [{ type: "patch", hash: "abc123", files: ["README.md"] }] })
        expect(yield* markerExists(v1MarkerName)).toBe(true)
        expect(yield* markerExists(v2MarkerName)).toBe(true)
        assertNoLegacyIDs(rows)
      }),
    )
  })

  test("user-owned patch is final unsupported and still writes v2 marker", async () => {
    const dbPath = await makeDbPath()
    const entry = user("msg_user_patch", 10, "hello")
    entry.parts.push(patch("msg_user_patch", "prt_patch"))

    await run(
      dbPath,
      Effect.gen(function* () {
        yield* seedSession()
        yield* seedLegacy([entry])

        const result = yield* SessionMessageBackfillService.ensureLegacySessionMessagesBackfilled(sessionID)

        expect(result.status).toBe("completed")
        if (result.status !== "completed") throw new Error("expected completed")
        expect(statCount(result.stats.skipped, "patch_parentage_unsupported")).toBe(1)
        expect(yield* markerExists(v2MarkerName)).toBe(true)
      }),
    )
  })

  test("standalone snapshot-only legacy sessions complete with explicit stats and v2 marker", async () => {
    const cases = [
      {
        entry: assistant("msg_assistant_snapshot", 10, [snapshot("msg_assistant_snapshot", "prt_assistant_snapshot")]),
        reason: "standalone_snapshot_unsupported",
      },
      {
        entry: user("msg_user_snapshot", 10, "hello snapshot"),
        reason: "snapshot_parentage_unsupported",
      },
    ]
    cases[1]!.entry.parts.push(snapshot("msg_user_snapshot", "prt_user_snapshot"))

    for (const { entry, reason } of cases) {
      const dbPath = await makeDbPath()
      await run(
        dbPath,
        Effect.gen(function* () {
          yield* seedSession()
          yield* seedLegacy([entry])

          const result = yield* SessionMessageBackfillService.ensureLegacySessionMessagesBackfilled(sessionID)
          const rows = yield* readV2Rows()
          const decoded = rows.map((row) => decodeMessage({ ...row.data, id: row.id, type: row.type }))

          expect(result.status).toBe("completed")
          if (result.status !== "completed") throw new Error("expected completed")
          expect(result.inserted).toBe(1)
          expect(statCount(result.stats.skipped, reason)).toBe(1)
          expect(JSON.stringify(decoded)).not.toContain("standalone")
          expect(yield* markerExists(v1MarkerName)).toBe(true)
          expect(yield* markerExists(v2MarkerName)).toBe(true)
        }),
      )
    }
  })

  test("completed tool title keeps upgrade pending and withholds v2 marker", async () => {
    const dbPath = await makeDbPath()
    const entry = assistant("msg_tool_title_deferred", 10, [completedTool("msg_tool_title_deferred", "prt_tool_title")])

    await run(
      dbPath,
      Effect.gen(function* () {
        yield* seedSession()
        yield* seedLegacy([entry])

        const result = yield* SessionMessageBackfillService.ensureLegacySessionMessagesBackfilled(sessionID)

        expect(result.status).toBe("upgrade_pending")
        if (result.status !== "upgrade_pending") throw new Error("expected upgrade_pending")
        expect(result.inserted).toBe(1)
        expect(statCount(result.stats.degraded, "tool_title_schema_missing")).toBe(1)
        expect(yield* markerExists(v1MarkerName)).toBe(true)
        expect(yield* markerExists(v2MarkerName)).toBe(false)
      }),
    )
  })

  test("task request re-entry uses v2 marker without duplicate or upsert churn", async () => {
    const dbPath = await makeDbPath()
    const entry = user("msg_deferred_reentry", 10, "deferred reentry")
    entry.parts.push(subtask("msg_deferred_reentry", "prt_deferred_reentry_subtask"))

    await run(
      dbPath,
      Effect.gen(function* () {
        yield* seedSession()
        yield* seedLegacy([entry])

        const first = yield* SessionMessageBackfillService.ensureLegacySessionMessagesBackfilled(sessionID)
        const rowsAfterFirst = yield* readV2Rows()
        const second = yield* SessionMessageBackfillService.ensureLegacySessionMessagesBackfilled(sessionID)
        const rowsAfterSecond = yield* readV2Rows()

        expect(first.status).toBe("completed")
        expect(second.status).toBe("already_completed")
        if (first.status !== "completed") throw new Error("expected completed")
        expect(rowsAfterFirst).toHaveLength(1)
        expect(rowsAfterSecond).toEqual(rowsAfterFirst)
        expect(yield* markerExists(v1MarkerName)).toBe(true)
        expect(yield* markerExists(v2MarkerName)).toBe(true)
      }),
    )
  })

  test("v1 marker with task-request exact rows writes v2 marker", async () => {
    const dbPath = await makeDbPath()
    const entry = user("msg_v1_deferred_existing", 10, "v1 deferred")
    entry.parts.push(subtask("msg_v1_deferred_existing", "prt_v1_deferred_subtask"))

    await run(
      dbPath,
      Effect.gen(function* () {
        yield* seedSession()
        yield* seedLegacy([entry])
        yield* seedMarker(v1MarkerName)
        yield* dbInsertSessionMessage(expectedRows([entry])[0]!)

        const result = yield* SessionMessageBackfillService.ensureLegacySessionMessagesBackfilled(sessionID)
        const rows = yield* readV2Rows()

        expect(result.status).toBe("completed")
        if (result.status !== "completed") throw new Error("expected completed")
        expect(result.inserted).toBe(0)
        expect(result.repaired).toBe(0)
        expect(rows).toHaveLength(1)
        expect(yield* markerExists(v1MarkerName)).toBe(true)
        expect(yield* markerExists(v2MarkerName)).toBe(true)
      }),
    )
  })

  test("missing legacy source after v1 marker preserves rows and does not write v2 marker", async () => {
    const dbPath = await makeDbPath()
    const existing = v2Row(liveUser("evt_legacy_backfill_m_existing", 10, "preserved"))

    await run(
      dbPath,
      Effect.gen(function* () {
        yield* seedSession()
        yield* seedMarker(v1MarkerName)
        yield* dbInsertSessionMessage(existing)

        const result = yield* SessionMessageBackfillService.ensureLegacySessionMessagesBackfilled(sessionID)
        const rows = yield* readV2Rows()

        expect(result.status).toBe("upgrade_unavailable")
        if (result.status !== "upgrade_unavailable") throw new Error("expected upgrade_unavailable")
        expect(statCount(result.stats.skipped, "legacy_source_unavailable")).toBe(1)
        expect(rows).toHaveLength(1)
        expect(rows[0]?.id).toBe(existing.id)
        expect(rows[0]?.data).toEqual(existing.data)
        expect(yield* markerExists(v2MarkerName)).toBe(false)
      }),
    )
  })

  test("mixed equal cutoff aborts without rows or marker", async () => {
    const dbPath = await makeDbPath()

    await run(
      dbPath,
      Effect.gen(function* () {
        yield* seedSession()
        yield* seedLegacy([user("msg_equal", 50, "equal boundary")])
        yield* seedV2(liveUser("evt_live_equal", 50, "live"))

        const result = yield* SessionMessageBackfillService.ensureLegacySessionMessagesBackfilled(sessionID)
        const rows = yield* readV2Rows()

        expect(result.status).toBe("aborted")
        if (result.status !== "aborted") throw new Error("expected aborted")
        expect(result.reason).toBe("mixed_cutoff_ambiguous")
        expect(statCount(result.stats.skipped, "mixed_cutoff_ambiguous")).toBe(1)
        expect(yield* markerExists()).toBe(false)
        expect(yield* markerExists(v2MarkerName)).toBe(false)
        expect(rows.map((row) => row.id)).toEqual([SessionMessage.ID.make("evt_live_equal")])
      }),
    )
  })

  test("mixed older and equal cutoff aborts without partially backfilling older eligible rows", async () => {
    const dbPath = await makeDbPath()

    await run(
      dbPath,
      Effect.gen(function* () {
        yield* seedSession()
        yield* seedLegacy([user("msg_older_ambiguous", 10, "older eligible"), user("msg_equal_ambiguous", 50, "equal boundary")])
        yield* seedV2(liveUser("evt_live_equal_ambiguous", 50, "live"))

        const result = yield* SessionMessageBackfillService.ensureLegacySessionMessagesBackfilled(sessionID)
        const rows = yield* readV2Rows()

        expect(result.status).toBe("aborted")
        if (result.status !== "aborted") throw new Error("expected aborted")
        expect(result.reason).toBe("mixed_cutoff_ambiguous")
        expect(statCount(result.stats.skipped, "mixed_cutoff_ambiguous")).toBe(1)
        expect(yield* markerExists(v1MarkerName)).toBe(false)
        expect(yield* markerExists(v2MarkerName)).toBe(false)
        expect(rows).toHaveLength(1)
        expect(rows[0]?.id).toBe(SessionMessage.ID.make("evt_live_equal_ambiguous"))
        expect(decodeMessage({ ...rows[0]!.data, id: rows[0]!.id, type: rows[0]!.type })).toEqual(liveUser("evt_live_equal_ambiguous", 50, "live"))
      }),
    )
  })

  test("cutoff backfills only older legacy rows and writes marker", async () => {
    const dbPath = await makeDbPath()
    const older = user("msg_older", 10, "older")

    await run(
      dbPath,
      Effect.gen(function* () {
        yield* seedSession()
        yield* seedLegacy([older, user("msg_newer", 70, "newer")])
        yield* seedV2(liveUser("evt_live_newer", 50, "live"))

        const result = yield* SessionMessageBackfillService.ensureLegacySessionMessagesBackfilled(sessionID)
        const rows = yield* readV2Rows()

        expect(result.status).toBe("completed")
        if (result.status !== "completed") throw new Error("expected completed")
        expect(result.inserted).toBe(1)
        expect(statCount(result.stats.skipped, "legacy_newer_than_cutoff_omitted")).toBe(1)
        expect(yield* markerExists()).toBe(true)
        expect(yield* markerExists(v2MarkerName)).toBe(true)
        expect(rows.map((row) => row.id)).toEqual([expectedRows([older])[0]?.id, SessionMessage.ID.make("evt_live_newer")])
      }),
    )
  })

  test("partial retry without marker repairs exact existing migration rows", async () => {
    const dbPath = await makeDbPath()
    const entries = [user("msg_partial_a", 10, "partial a"), user("msg_partial_b", 20, "partial b")]

    await run(
      dbPath,
      Effect.gen(function* () {
        yield* seedSession()
        yield* seedLegacy(entries)
        yield* dbInsertSessionMessage(expectedRows(entries)[0]!)

        const result = yield* SessionMessageBackfillService.ensureLegacySessionMessagesBackfilled(sessionID)
        const rows = yield* readV2Rows()

        expect(result.status).toBe("completed")
        if (result.status !== "completed") throw new Error("expected completed")
        expect(result.inserted).toBe(1)
        expect(result.repaired).toBe(1)
        expect(yield* markerExists()).toBe(true)
        expect(rows.map((row) => row.id)).toEqual(expectedRows(entries).map((row) => row.id))
      }),
    )
  })

  test("migration-owned differing expected row repairs instead of aborting", async () => {
    const dbPath = await makeDbPath()
    const entry = user("msg_repair", 10, "expected")

    await run(
      dbPath,
      Effect.gen(function* () {
        yield* seedSession()
        yield* seedLegacy([entry])
        const expected = expectedRows([entry])[0]!
        const stale = { ...expected, data: { ...expected.data, text: "stale" } }
        yield* dbInsertSessionMessage(stale)

        const result = yield* SessionMessageBackfillService.ensureLegacySessionMessagesBackfilled(sessionID)
        const rows = yield* readV2Rows()

        expect(result.status).toBe("completed")
        if (result.status !== "completed") throw new Error("expected completed")
        expect(result.inserted).toBe(0)
        expect(result.repaired).toBe(1)
        expect(rows[0]?.data).toEqual(expected.data)
        expect(yield* markerExists(v2MarkerName)).toBe(true)
      }),
    )
  })

  test("non-backfill rows are preserved while expected migration rows are written", async () => {
    const dbPath = await makeDbPath()
    const entry = user("msg_non_backfill_protection", 10, "expected")
    const live = liveUser("evt_live_preserved", 50, "live")

    await run(
      dbPath,
      Effect.gen(function* () {
        yield* seedSession()
        yield* seedLegacy([entry])
        yield* seedV2(live)

        const result = yield* SessionMessageBackfillService.ensureLegacySessionMessagesBackfilled(sessionID)
        const rows = yield* readV2Rows()

        expect(result.status).toBe("completed")
        if (result.status !== "completed") throw new Error("expected completed")
        expect(result.inserted).toBe(1)
        expect(rows.map((row) => row.id)).toEqual([expectedRows([entry])[0]?.id, live.id])
        expect(decodeMessage({ ...rows[1]!.data, id: rows[1]!.id, type: rows[1]!.type })).toEqual(live)
      }),
    )
  })
})

function dbInsertSessionMessage(row: typeof SessionMessageTable.$inferInsert) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db.insert(SessionMessageTable).values([row]).run()
  })
}

function failBackfillMarkerInsert(name = v1MarkerName) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db.run(sql`
      CREATE TEMP TRIGGER fail_backfill_marker
      BEFORE INSERT ON data_migration
      WHEN NEW.name = ${sql.raw(sqlString(name))}
      BEGIN
        SELECT RAISE(ABORT, 'backfill marker failed');
      END
    `)
  })
}

function sqlString(value: string) {
  return `'${value.replaceAll("'", "''")}'`
}
