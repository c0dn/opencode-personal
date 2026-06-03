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
import { asc, eq, sql } from "drizzle-orm"
import { Cause, DateTime, Effect, Exit, Layer, Schema } from "effect"
import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { BackfillNotReadyError, PromptV2Context, ensureBackfillReady } from "../../src/session/prompt-v2-context"

const tmp = new Array<string>()
const sessionID = SessionV2.ID.make("ses_prompt_v2_context")
const providerID = ProviderV2.ID.make("provider")
const modelID = ProviderV2.ModelID.make("model")
const v1MarkerName = `legacy-session-message-backfill/v1/${sessionID}`
const encodeMessage = Schema.encodeSync(SessionMessage.Message)

afterEach(async () => {
  await Promise.all(tmp.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe("session.prompt-v2-context", () => {
  test("returns canonical context rows after legacy backfill", async () => {
    const dbPath = await makeDbPath()
    const userEntry = user("msg_user", 10, "hello from legacy")
    userEntry.parts.push(file("msg_user", "prt_user_file"), subtask("msg_user", "prt_user_task"))
    const assistantEntry = assistant("msg_assistant", 20, [
      reasoning("msg_assistant", "prt_reasoning", "thinking from legacy"),
      text("msg_assistant", "prt_answer", "answer from legacy"),
      completedTool("msg_assistant", "prt_tool"),
      patch("msg_assistant", "prt_patch"),
    ])

    const context = await run(
      dbPath,
      Effect.gen(function* () {
        yield* seedSession()
        yield* seedLegacy([userEntry, assistantEntry])
        return yield* PromptV2Context.messages(sessionID)
      }),
    )

    expect(context.map((message) => message.type)).toStrictEqual(["user", "assistant"])
    const userMessage = context[0]
    const assistantMessage = context[1]
    if (userMessage?.type !== "user") throw new Error("expected user context row")
    if (assistantMessage?.type !== "assistant") throw new Error("expected assistant context row")

    expect(userMessage.text).toBe("hello from legacy")
    expect(userMessage.files).toStrictEqual([
      expect.objectContaining({ mime: "text/plain", name: "note.txt", uri: "data:text/plain;base64,aGVsbG8=" }),
    ])
    expect(userMessage.taskRequests).toStrictEqual([
      expect.objectContaining({ type: "task-request", prompt: "do not send this to provider", agent: "reviewer" }),
    ])

    expect(assistantMessage.content.map((content) => content.type).sort()).toStrictEqual([
      "patch",
      "reasoning",
      "text",
      "tool",
    ])
    expect(assistantMessage.content).toContainEqual(expect.objectContaining({ type: "text", text: "answer from legacy" }))
    expect(assistantMessage.content).toContainEqual(expect.objectContaining({ type: "patch", hash: "abc123" }))
    expect(assistantMessage.content).toContainEqual(
      expect.objectContaining({
        type: "tool",
        callID: "call_1",
        name: "bash",
        state: expect.objectContaining({ status: "completed", content: [expect.objectContaining({ type: "text", text: "done" })] }),
      }),
    )
    assertNoLegacyIDs(context)
  })

  test("backfills a real DB legacy-only transcript before returning provider model messages", async () => {
    const dbPath = await makeDbPath()
    const userEntry = user("msg_user", 10, "hello from legacy")
    userEntry.parts.push(file("msg_user", "prt_user_file"), subtask("msg_user", "prt_user_task"))
    const assistantEntry = assistant("msg_assistant", 20, [
      reasoning("msg_assistant", "prt_reasoning", "thinking from legacy"),
      text("msg_assistant", "prt_answer", "answer from legacy"),
      completedTool("msg_assistant", "prt_tool"),
      patch("msg_assistant", "prt_patch"),
    ])

    const messages = await run(
      dbPath,
      Effect.gen(function* () {
        yield* seedSession()
        yield* seedLegacy([userEntry, assistantEntry])
        return yield* PromptV2Context.toModelMessages(sessionID)
      }),
    )

    expect(messages).toStrictEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "hello from legacy" },
          { type: "file", mediaType: "text/plain", filename: "note.txt", data: "data:text/plain;base64,aGVsbG8=" },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "answer from legacy" },
          { type: "reasoning", text: "thinking from legacy", providerOptions: undefined },
          { type: "tool-call", toolCallId: "call_1", toolName: "bash", input: { cmd: "pwd" }, providerExecuted: undefined },
        ],
      },
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "call_1", toolName: "bash", output: { type: "text", value: "done" } }],
      },
    ])
    assertNoLegacyIDs(messages)
  })

  test("fails before model conversion for ambiguous mixed cutoff", async () => {
    const dbPath = await makeDbPath()

    const exit = await run(
      dbPath,
      Effect.gen(function* () {
        yield* seedSession()
        yield* seedLegacy([user("msg_older", 10, "older"), user("msg_equal", 50, "equal boundary")])
        yield* seedV2(liveUser("evt_live_equal", 50, "live"))
        return yield* PromptV2Context.toModelMessages(sessionID).pipe(Effect.exit)
      }),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isSuccess(exit)) throw new Error("expected failure")
    const error = Cause.squash(exit.cause)
    expect(error).toBeInstanceOf(BackfillNotReadyError)
    expect(error).toMatchObject({ status: "aborted", reason: "mixed_cutoff_ambiguous" })
  })

  test("messages fails for ambiguous mixed cutoff", async () => {
    const dbPath = await makeDbPath()

    const exit = await run(
      dbPath,
      Effect.gen(function* () {
        yield* seedSession()
        yield* seedLegacy([user("msg_older", 10, "older"), user("msg_equal", 50, "equal boundary")])
        yield* seedV2(liveUser("evt_live_equal", 50, "live"))
        return yield* PromptV2Context.messages(sessionID).pipe(Effect.exit)
      }),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isSuccess(exit)) throw new Error("expected failure")
    const error = Cause.squash(exit.cause)
    expect(error).toBeInstanceOf(BackfillNotReadyError)
    expect(error).toMatchObject({ status: "aborted", reason: "mixed_cutoff_ambiguous" })
  })

  test("fails before model conversion when upgrade is unavailable", async () => {
    const dbPath = await makeDbPath()

    const exit = await run(
      dbPath,
      Effect.gen(function* () {
        yield* seedSession()
        yield* seedMarker(v1MarkerName)
        return yield* PromptV2Context.toModelMessages(sessionID).pipe(Effect.exit)
      }),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isSuccess(exit)) throw new Error("expected failure")
    const error = Cause.squash(exit.cause)
    expect(error).toBeInstanceOf(BackfillNotReadyError)
    expect(error).toMatchObject({ status: "upgrade_unavailable", reason: "legacy_source_unavailable" })
  })

  test("messages fails when upgrade is unavailable", async () => {
    const dbPath = await makeDbPath()

    const exit = await run(
      dbPath,
      Effect.gen(function* () {
        yield* seedSession()
        yield* seedMarker(v1MarkerName)
        return yield* PromptV2Context.messages(sessionID).pipe(Effect.exit)
      }),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isSuccess(exit)) throw new Error("expected failure")
    const error = Cause.squash(exit.cause)
    expect(error).toBeInstanceOf(BackfillNotReadyError)
    expect(error).toMatchObject({ status: "upgrade_unavailable", reason: "legacy_source_unavailable" })
  })

  test("allows model-context-safe upgrade_pending reasons", async () => {
    const dbPath = await makeDbPath()
    const assistantEntry = assistant("msg_tool_title_deferred", 10, [completedTool("msg_tool_title_deferred", "prt_tool_title")])
    if (assistantEntry.info.role !== "assistant") throw new Error("expected assistant message")
    assistantEntry.info.structured = { type: "json_schema" }
    assistantEntry.info.tokens.total = 6
    const tool = assistantEntry.parts[0]
    if (tool?.type !== "tool" || tool.state.status !== "completed") throw new Error("expected completed tool")
    tool.state.metadata = { unsupported: true }

    const messages = await run(
      dbPath,
      Effect.gen(function* () {
        yield* seedSession()
        yield* seedLegacy([assistantEntry])
        return yield* PromptV2Context.toModelMessages(sessionID)
      }),
    )

    expect(messages).toStrictEqual([
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "call_1", toolName: "bash", input: { cmd: "pwd" }, providerExecuted: undefined }],
      },
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "call_1", toolName: "bash", output: { type: "text", value: "done" } }],
      },
    ])
  })

  test("classifier rejects unknown upgrade_pending reasons", () => {
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
})

async function makeDbPath() {
  const dir = await mkdtemp(join(tmpdir(), "opencode-prompt-v2-context-"))
  tmp.push(dir)
  return join(dir, "prompt-v2-context.db")
}

function layer(filename: string) {
  const database = Database.layerFromPath(filename)
  return Layer.mergeAll(SessionV2.layer.pipe(Layer.provide(database)), database)
}

function run<A, E>(filename: string, effect: Effect.Effect<A, E, SessionV2.Service | Database.Service>) {
  return Effect.runPromise(effect.pipe(Effect.provide(layer(filename)), Effect.scoped))
}

function user(id: string, created: number, value: string): SessionLegacy.WithParts {
  return {
    info: { id: SessionLegacy.MessageID.make(id), sessionID, role: "user", time: { created }, agent: "build", model: { providerID, modelID } },
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
      finish: "stop",
    },
    parts,
  }
}

function text(messageID: string, id: string, value: string): SessionLegacy.TextPart {
  return { id: SessionLegacy.PartID.make(id), sessionID, messageID: SessionLegacy.MessageID.make(messageID), type: "text", text: value }
}

function reasoning(messageID: string, id: string, value: string): SessionLegacy.ReasoningPart {
  return {
    id: SessionLegacy.PartID.make(id),
    sessionID,
    messageID: SessionLegacy.MessageID.make(messageID),
    type: "reasoning",
    text: value,
    time: { start: 1, end: 2 },
  }
}

function file(messageID: string, id: string): SessionLegacy.FilePart {
  return {
    id: SessionLegacy.PartID.make(id),
    sessionID,
    messageID: SessionLegacy.MessageID.make(messageID),
    type: "file",
    mime: "text/plain",
    filename: "note.txt",
    url: "data:text/plain;base64,aGVsbG8=",
  }
}

function subtask(messageID: string, id: string): SessionLegacy.SubtaskPart {
  return {
    id: SessionLegacy.PartID.make(id),
    sessionID,
    messageID: SessionLegacy.MessageID.make(messageID),
    type: "subtask",
    prompt: "do not send this to provider",
    description: "review",
    agent: "reviewer",
    model: { providerID, modelID },
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
      VALUES ('proj_prompt_v2_context', '/tmp/prompt-v2-context', 'prompt-v2-context', 1, 1, '[]')
    `)
    yield* db.run(sql`
      INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
      VALUES (${sessionID}, 'proj_prompt_v2_context', 'prompt-v2-context', '/tmp/prompt-v2-context', 'prompt-v2-context', 'test', 1, 1)
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

function assertNoLegacyIDs(value: unknown) {
  const encoded = JSON.stringify(value)
  expect(encoded).not.toContain("msg_")
  expect(encoded).not.toContain("prt_")
}
