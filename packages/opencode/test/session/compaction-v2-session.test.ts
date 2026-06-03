import { afterEach, describe, expect, test } from "bun:test"
import { DataMigrationTable } from "@opencode-ai/core/data-migration.sql"
import { Database } from "@opencode-ai/core/database/database"
import { ProviderV2 } from "@opencode-ai/core/provider"
import type { DeepMutable } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionLegacy } from "@opencode-ai/core/session/legacy"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionMessageBackfillService } from "@opencode-ai/core/session/message-backfill-service"
import { MessageTable, PartTable, SessionMessageTable } from "@opencode-ai/core/session/sql"
import { sql } from "drizzle-orm"
import { Cause, DateTime, Effect, Exit, Layer, Schema } from "effect"
import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { CompactionV2Session } from "../../src/session/compaction-v2-session"
import { BackfillNotReadyError, ensureBackfillReady } from "../../src/session/session-v2-backfill-readiness"

const tmp = new Array<string>()
const sessionID = SessionV2.ID.make("ses_compaction_v2_session")
const providerID = ProviderV2.ID.make("provider")
const modelID = ProviderV2.ModelID.make("model")
const v1MarkerName = `legacy-session-message-backfill/v1/${sessionID}`
const encodeMessage = Schema.encodeSync(SessionMessage.Message)

afterEach(async () => {
  await Promise.all(tmp.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe("session.compaction-v2-session", () => {
  test("selects from a real DB legacy compaction fixture after readiness succeeds", async () => {
    const dbPath = await makeDbPath()

    const selected = await run(
      dbPath,
      Effect.gen(function* () {
        yield* seedSession()
        yield* seedLegacy([
          user("msg_dropped", 10, "dropped prefix"),
          user("msg_retained_user", 20, "retained user"),
          assistant("msg_retained_assistant", 30, [text("msg_retained_assistant", "prt_retained_answer", "retained assistant")]),
          user("msg_compaction_marker", 40, [
            compaction("msg_compaction_marker", "prt_compaction", { auto: false, tail_start_id: "msg_retained_user" }),
          ]),
          summaryAssistant("msg_compaction_summary", 50, "msg_compaction_marker", "summary of prior work"),
          user("msg_later_user", 60, "later user"),
          assistant("msg_later_assistant", 70, [text("msg_later_assistant", "prt_later_answer", "later assistant")]),
        ])

        return yield* CompactionV2Session.selectForSession(sessionID)
      }),
    )

    expect(selected.previousSummary).toBe("summary of prior work")
    expect(selected.latestCompaction?.include).toBe(selected.history[0]?.id)
    expect(selected.history.map(displayText)).toStrictEqual([
      "retained user",
      "retained assistant",
      "later user",
      "later assistant",
    ])
    expect(selected.head.map(displayText)).toStrictEqual(selected.history.map(displayText))
    expect(selected.history.some((message) => message.type === "compaction")).toBe(false)
    expect(JSON.stringify(selected.history)).not.toContain("dropped prefix")
    assertNoLegacyIDs(selected)
  })

  test("fails before selection for ambiguous mixed cutoff", async () => {
    const dbPath = await makeDbPath()

    const exit = await run(
      dbPath,
      Effect.gen(function* () {
        yield* seedSession()
        yield* seedLegacy([user("msg_older", 10, "older"), user("msg_equal", 50, "equal boundary")])
        yield* seedV2(liveUser("evt_live_equal", 50, "live"))
        return yield* CompactionV2Session.selectForSession(sessionID, {
          tailTurns: 1,
          preserveRecentBudget: 1,
          estimate: () => {
            throw new Error("selection should not run")
          },
        }).pipe(Effect.exit)
      }),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isSuccess(exit)) throw new Error("expected failure")
    const error = Cause.squash(exit.cause)
    expect(error).toBeInstanceOf(BackfillNotReadyError)
    expect(error).toMatchObject({ status: "aborted", reason: "mixed_cutoff_ambiguous" })
  })

  test("fails typed readiness when v1 marker exists but legacy source is unavailable", async () => {
    const dbPath = await makeDbPath()

    const exit = await run(
      dbPath,
      Effect.gen(function* () {
        yield* seedSession()
        yield* seedMarker(v1MarkerName)
        return yield* CompactionV2Session.selectForSession(sessionID).pipe(Effect.exit)
      }),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isSuccess(exit)) throw new Error("expected failure")
    const error = Cause.squash(exit.cause)
    expect(error).toBeInstanceOf(BackfillNotReadyError)
    expect(error).toMatchObject({ status: "upgrade_unavailable", reason: "legacy_source_unavailable" })
  })

  test("allows safe upgrade_pending degradation before selecting canonical rows", async () => {
    const dbPath = await makeDbPath()
    const assistantEntry = assistant("msg_tool_title_deferred", 10, [
      completedTool("msg_tool_title_deferred", "prt_tool_title"),
    ])
    const tool = assistantEntry.parts[0]
    if (tool?.type !== "tool" || tool.state.status !== "completed") throw new Error("expected completed tool")
    tool.state.metadata = { unsupported: true }

    const selected = await run(
      dbPath,
      Effect.gen(function* () {
        yield* seedSession()
        yield* seedLegacy([assistantEntry])
        return yield* CompactionV2Session.selectForSession(sessionID)
      }),
    )

    expect(selected.history).toHaveLength(1)
    expect(selected.history[0]?.type).toBe("assistant")
  })

  test("classifier rejects unknown future pending-driving reasons", () => {
    const pendingUpgradeReasons = new Set([...SessionMessageBackfillService.pendingUpgradeReasons, "future_schema_missing"])
    const result: SessionMessageBackfillService.Result = {
      status: "upgrade_pending",
      inserted: 0,
      repaired: 0,
      stats: { mapped: [], degraded: [{ type: "test", reason: "future_schema_missing", count: 1 }], skipped: [] },
    }

    expect(ensureBackfillReady(result, sessionID, pendingUpgradeReasons)).toMatchObject({
      _tag: "SessionV2BackfillReadiness.BackfillNotReadyError",
      status: "upgrade_pending",
      reason: "future_schema_missing",
    })
  })

  test("wrapper stays DB/readiness-only and does not wire provider compaction", async () => {
    const source = await Bun.file(new URL("../../src/session/compaction-v2-session.ts", import.meta.url)).text()

    expect(source).not.toContain("MessageV2Model")
    expect(source).not.toContain("toModelMessages")
    expect(source).not.toContain("SessionCompaction")
    expect(source).not.toContain("SessionProcessor")
    expect(source).not.toContain("Plugin")
    expect(source).not.toContain("Token")
    expect(source).not.toContain("SUMMARY_TEMPLATE")
  })
})

async function makeDbPath() {
  const dir = await mkdtemp(join(tmpdir(), "opencode-compaction-v2-session-"))
  tmp.push(dir)
  return join(dir, "compaction-v2-session.db")
}

function layer(filename: string) {
  const database = Database.layerFromPath(filename)
  return Layer.mergeAll(SessionV2.layer.pipe(Layer.provide(database)), database)
}

function run<A, E>(filename: string, effect: Effect.Effect<A, E, SessionV2.Service | Database.Service>) {
  return Effect.runPromise(effect.pipe(Effect.provide(layer(filename)), Effect.scoped))
}

function user(id: string, created: number, valueOrParts: string | SessionLegacy.Part[]): SessionLegacy.WithParts {
  const parts = Array.isArray(valueOrParts) ? valueOrParts : [text(id, `${id.replace("msg", "prt")}_text`, valueOrParts)]
  return {
    info: { id: SessionLegacy.MessageID.make(id), sessionID, role: "user", time: { created }, agent: "build", model: { providerID, modelID } },
    parts,
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
      finish: "stop",
    },
    parts,
  }
}

function summaryAssistant(id: string, created: number, parentID: string, value: string): SessionLegacy.WithParts {
  const entry = assistant(id, created, [text(id, `${id.replace("msg", "prt")}_text`, value)])
  if (entry.info.role !== "assistant") throw new Error("expected assistant")
  entry.info.parentID = SessionLegacy.MessageID.make(parentID)
  entry.info.summary = true
  entry.info.finish = "stop"
  return entry
}

function text(messageID: string, id: string, value: string): SessionLegacy.TextPart {
  return { id: SessionLegacy.PartID.make(id), sessionID, messageID: SessionLegacy.MessageID.make(messageID), type: "text", text: value }
}

function compaction(messageID: string, id: string, input?: { auto?: boolean; tail_start_id?: string }): SessionLegacy.CompactionPart {
  return {
    id: SessionLegacy.PartID.make(id),
    sessionID,
    messageID: SessionLegacy.MessageID.make(messageID),
    type: "compaction",
    auto: input?.auto ?? true,
    tail_start_id: input?.tail_start_id ? SessionLegacy.MessageID.make(input.tail_start_id) : undefined,
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
      VALUES ('proj_compaction_v2_session', '/tmp/compaction-v2-session', 'compaction-v2-session', 1, 1, '[]')
    `)
    yield* db.run(sql`
      INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
      VALUES (${sessionID}, 'proj_compaction_v2_session', 'compaction-v2-session', '/tmp/compaction-v2-session', 'compaction-v2-session', 'test', 1, 1)
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

function seedMarker(name: string) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db.insert(DataMigrationTable).values({ name, time_completed: 1 }).run()
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

function displayText(message: SessionMessage.Message) {
  if (message.type === "user") return message.text
  if (message.type === "assistant") return message.content.find((content) => content.type === "text")?.text
  return message.type
}

function assertNoLegacyIDs(value: unknown) {
  const encoded = JSON.stringify(value)
  expect(encoded).not.toContain("msg_")
  expect(encoded).not.toContain("prt_")
}
