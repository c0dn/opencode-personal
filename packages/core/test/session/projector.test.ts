import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { eq, sql } from "drizzle-orm"
import { DateTime, Effect, Layer, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { EventSequenceTable, EventTable } from "@opencode-ai/core/event/sql"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionV2 } from "@opencode-ai/core/session"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionMessageTable } from "@opencode-ai/core/session/sql"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { ToolOutput } from "@opencode-ai/core/tool-output"

const tmp = new Array<string>()
const sessionID = SessionSchema.ID.make("ses_projector")
const model = {
  id: ModelV2.ID.make("model"),
  providerID: ProviderV2.ID.make("provider"),
}

afterEach(async () => {
  await Promise.all(tmp.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function makeDbPath() {
  const dir = await mkdtemp(join(tmpdir(), "opencode-projector-test-"))
  tmp.push(dir)
  return join(dir, "projector.db")
}

function layer(filename: string) {
  return Layer.mergeAll(SessionProjector.layer, SessionV2.layer).pipe(
    Layer.provideMerge(EventV2.layer),
    Layer.provideMerge(Database.layerFromPath(filename)),
  )
}

function run<A, E>(
  filename: string,
  effect: Effect.Effect<A, E, Database.Service | EventV2.Service | SessionV2.Service>,
) {
  return Effect.runPromise(effect.pipe(Effect.provide(layer(filename)), Effect.scoped))
}

function eventID(suffix: string) {
  return EventV2.ID.make(`evt_${suffix}`)
}

function at(millis: number) {
  return DateTime.makeUnsafe(millis)
}

function serialized(event: EventV2.Payload, seq: number): EventV2.SerializedEvent {
  return {
    id: event.id,
    type: EventV2.versionedType(event.type, event.version ?? 1),
    seq,
    aggregateID: sessionID,
    data: EventV2.encodeKnownPayload(event).data,
  }
}

function seedSession() {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db.run(sql`
      INSERT INTO project (id, worktree, name, time_created, time_updated, sandboxes)
      VALUES ('proj_projector', '/tmp/projector', 'projector', 1, 1, '[]')
    `)
    yield* db.run(sql`
      INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
      VALUES (${sessionID}, 'proj_projector', 'projector', '/tmp/projector', 'projector', 'test', 1, 1)
    `)
  })
}

function readMessages() {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const rows = yield* db.select().from(SessionMessageTable).all().pipe(Effect.orDie)
    return rows
      .sort((left, right) => left.time_created - right.time_created || left.id.localeCompare(right.id))
      .map((row) => Schema.decodeUnknownSync(SessionMessage.Message)({ ...row.data, id: row.id, type: row.type }))
  })
}

function insertMessage(message: SessionMessage.Message) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const encoded = Schema.encodeSync(SessionMessage.Message)(message)
    const { id, type, ...data } = encoded
    yield* db
      .insert(SessionMessageTable)
      .values([
        {
          id: SessionMessage.ID.make(id),
          session_id: sessionID,
          type,
          time_created: DateTime.toEpochMillis(message.time.created),
          data,
        },
      ])
      .run()
      .pipe(Effect.orDie)
  })
}

function assistantMessage(input: {
  id: string
  created: number
  completed?: number
  content?: SessionMessage.Assistant["content"]
}) {
  return new SessionMessage.Assistant({
    id: SessionMessage.ID.make(input.id),
    type: "assistant",
    agent: "build",
    model,
    time: { created: at(input.created), completed: input.completed === undefined ? undefined : at(input.completed) },
    content: input.content ?? [],
  })
}

function publishCompaction(input: {
  startedID: EventV2.ID
  endedID?: EventV2.ID
  startedAt: number
  endedAt?: number
  reason?: "manual" | "auto"
  text?: string
  include?: string
}) {
  return Effect.gen(function* () {
    const events = yield* EventV2.Service
    yield* events.publish(
      SessionEvent.Compaction.Started,
      { sessionID, timestamp: at(input.startedAt), reason: input.reason ?? "manual" },
      { id: input.startedID },
    )
    if (!input.endedID || input.endedAt === undefined) return
    yield* events.publish(
      SessionEvent.Compaction.Ended,
      { sessionID, timestamp: at(input.endedAt), text: input.text ?? "summary", include: input.include },
      { id: input.endedID },
    )
  })
}

function resetStoredEvents() {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db.delete(EventTable).where(eq(EventTable.aggregate_id, sessionID)).run().pipe(Effect.orDie)
    yield* db.delete(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, sessionID)).run().pipe(Effect.orDie)
  })
}

function dbEvents() {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    return yield* db
      .select()
      .from(EventTable)
      .where(eq(EventTable.aggregate_id, sessionID))
      .orderBy(sql`seq asc`)
      .all()
      .pipe(Effect.orDie)
  })
}

function serializedEventRow(row: typeof EventTable.$inferSelect): EventV2.SerializedEvent {
  return {
    id: row.id,
    type: row.type,
    seq: row.seq,
    aggregateID: row.aggregate_id,
    data: row.data,
  }
}

function publishTranscript() {
  return Effect.gen(function* () {
    const events = yield* EventV2.Service
    const prompted = yield* events.publish(
      SessionEvent.Prompted,
      { sessionID, timestamp: at(10), prompt: new Prompt({ text: "hello", files: [], agents: [], references: [] }) },
      { id: eventID("prompted") },
    )
    const stepStarted = yield* events.publish(
      SessionEvent.Step.Started,
      { sessionID, timestamp: at(20), agent: "build", model, snapshot: "start" },
      { id: eventID("assistant") },
    )
    const textStarted = yield* events.publish(
      SessionEvent.Text.Started,
      { sessionID, timestamp: at(30) },
      { id: eventID("text_started") },
    )
    const textDelta = yield* events.publish(
      SessionEvent.Text.Delta,
      { sessionID, timestamp: at(31), delta: "ignored partial" },
      { id: eventID("text_delta") },
    )
    const textEnded = yield* events.publish(
      SessionEvent.Text.Ended,
      { sessionID, timestamp: at(40), text: "hello assistant" },
      { id: eventID("text_ended") },
    )
    const toolStarted = yield* events.publish(
      SessionEvent.Tool.Input.Started,
      { sessionID, timestamp: at(50), callID: "call_1", name: "bash" },
      { id: eventID("tool_started") },
    )
    const toolCalled = yield* events.publish(
      SessionEvent.Tool.Called,
      {
        sessionID,
        timestamp: at(60),
        callID: "call_1",
        tool: "bash",
        input: { command: "pwd" },
        provider: { executed: true },
      },
      { id: eventID("tool_called") },
    )
    const toolSuccess = yield* events.publish(
      SessionEvent.Tool.Success,
      {
        sessionID,
        timestamp: at(70),
        callID: "call_1",
        structured: {},
        title: "Shell command",
        content: [
          new ToolOutput.TextContent({ type: "text", text: "/tmp" }),
          new ToolOutput.FileContent({
            type: "file",
            uri: "data:image/png;base64,AAAA",
            mime: "image/png",
            name: "image.png",
          }),
        ],
        provider: { executed: true, metadata: { status: "done" } },
      },
      { id: eventID("tool_success") },
    )
    const stepEnded = yield* events.publish(
      SessionEvent.Step.Ended,
      {
        sessionID,
        timestamp: at(80),
        finish: "stop",
        cost: 0.25,
        tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
        snapshot: "end",
      },
      { id: eventID("step_ended") },
    )
    const compactionStarted = yield* events.publish(
      SessionEvent.Compaction.Started,
      { sessionID, timestamp: at(90), reason: "manual" },
      { id: eventID("compaction_started") },
    )
    const compactionEnded = yield* events.publish(
      SessionEvent.Compaction.Ended,
      { sessionID, timestamp: at(100), text: "final summary", include: "keep" },
      { id: eventID("compaction_ended") },
    )
    return [
      prompted,
      stepStarted,
      textStarted,
      textDelta,
      textEnded,
      toolStarted,
      toolCalled,
      toolSuccess,
      stepEnded,
      compactionStarted,
      compactionEnded,
    ]
  })
}

function retryError() {
  return {
    message: "provider returned 429",
    statusCode: 429,
    isRetryable: true,
    responseHeaders: { "retry-after": "1" },
    responseBody: "rate limited",
    metadata: { provider: "test" },
  }
}

function retryTranscriptEvents() {
  return Effect.gen(function* () {
    const events = yield* EventV2.Service
    const stepStarted = yield* events.publish(
      SessionEvent.Step.Started,
      { sessionID, timestamp: at(10), agent: "build", model, snapshot: "before-retry" },
      { id: eventID("retry_assistant") },
    )
    const retried = yield* events.publish(
      SessionEvent.Retried,
      { sessionID, timestamp: at(20), attempt: 2, error: retryError() },
      { id: eventID("retried") },
    )
    return [stepStarted, retried]
  })
}

function assertNoLegacyIDs(value: unknown) {
  const strings: string[] = []
  const visit = (current: unknown) => {
    if (typeof current === "string") {
      strings.push(current)
      return
    }
    if (Array.isArray(current)) {
      current.forEach(visit)
      return
    }
    if (current && typeof current === "object") Object.values(current).forEach(visit)
  }
  visit(value)
  for (const string of strings) {
    expect(string.startsWith("msg_")).toBe(false)
    expect(string.startsWith("prt_")).toBe(false)
  }
}

describe("SessionProjector", () => {
  test("projects session.next transcript events into v2 messages", async () => {
    const dbPath = await makeDbPath()
    await run(
      dbPath,
      Effect.gen(function* () {
        yield* seedSession()
        yield* publishTranscript()

        const messages = yield* readMessages()
        expect(messages.map((message) => message.type)).toEqual(["user", "assistant", "compaction"])
        expect(messages[0]).toMatchObject({ id: eventID("prompted"), type: "user", text: "hello" })
        expect(messages[2]).toMatchObject({
          id: eventID("compaction_started"),
          type: "compaction",
          summary: "final summary",
          include: "keep",
        })

        const assistant = messages[1]
        expect(assistant?.type).toBe("assistant")
        if (assistant?.type !== "assistant") return
        expect(assistant.id).toBe(eventID("assistant"))
        expect(assistant.finish).toBe("stop")
        expect(assistant.snapshot).toEqual({ start: "start", end: "end" })
        expect(assistant.content).toMatchObject([
          { type: "text", id: eventID("text_started"), text: "hello assistant" },
          { type: "tool", id: eventID("tool_started"), callID: "call_1", state: { status: "completed" } },
        ])
        const tool = assistant.content[1]
        expect(tool?.type).toBe("tool")
        if (tool?.type !== "tool") return
        expect(tool.state.status).toBe("completed")
        if (tool.state.status !== "completed") return
        expect(tool.title).toBe("Shell command")
        expect(tool.state.content).toEqual([
          { type: "text", text: "/tmp" },
          { type: "file", uri: "data:image/png;base64,AAAA", mime: "image/png", name: "image.png" },
        ])
        expect(tool.state).not.toHaveProperty("attachments")
      }),
    )
  })

  test("replay is deterministic and duplicate delivery does not duplicate projected content", async () => {
    const sourceDb = await makeDbPath()
    const targetDb = await makeDbPath()
    const events = await run(
      sourceDb,
      Effect.gen(function* () {
        yield* seedSession()
        return (yield* publishTranscript()).map(serialized)
      }),
    )

    await run(
      targetDb,
      Effect.gen(function* () {
        yield* seedSession()
        const service = yield* EventV2.Service
        yield* service.replayAll(events)
        yield* resetStoredEvents()
        yield* service.replayAll(events)

        const messages = yield* readMessages()
        expect(messages.map((message) => message.type)).toEqual(["user", "assistant", "compaction"])
        const assistant = messages[1]
        expect(assistant?.type).toBe("assistant")
        if (assistant?.type !== "assistant") return
        expect(assistant.content.map((item) => item.id)).toEqual([eventID("text_started"), eventID("tool_started")])
        expect(assistant.content).toMatchObject([
          { type: "text", text: "hello assistant" },
          { type: "tool", state: { status: "completed" } },
        ])
      }),
    )
  })

  test("compaction started only does not create a canonical compaction row", async () => {
    const dbPath = await makeDbPath()
    await run(
      dbPath,
      Effect.gen(function* () {
        yield* seedSession()
        yield* publishCompaction({ startedID: eventID("started_only"), startedAt: 10 })

        expect(yield* readMessages()).toEqual([])
      }),
    )
  })

  test("compaction started plus delta does not create a canonical compaction row", async () => {
    const dbPath = await makeDbPath()
    await run(
      dbPath,
      Effect.gen(function* () {
        yield* seedSession()
        const events = yield* EventV2.Service
        yield* events.publish(
          SessionEvent.Compaction.Started,
          { sessionID, timestamp: at(10), reason: "manual" },
          { id: eventID("started_delta") },
        )
        yield* events.publish(
          SessionEvent.Compaction.Delta,
          { sessionID, timestamp: at(11), text: "partial" },
          { id: eventID("delta_without_end") },
        )

        expect(yield* readMessages()).toEqual([])
      }),
    )
  })

  test("compaction ended without a matching started event does not create or mutate rows", async () => {
    const dbPath = await makeDbPath()
    await run(
      dbPath,
      Effect.gen(function* () {
        yield* seedSession()
        const events = yield* EventV2.Service
        yield* events.publish(
          SessionEvent.Compaction.Ended,
          { sessionID, timestamp: at(10), text: "orphan summary", include: "orphan" },
          { id: eventID("orphan_ended") },
        )
        expect(yield* readMessages()).toEqual([])

        yield* publishCompaction({
          startedID: eventID("completed_before_orphan"),
          endedID: eventID("completed_before_orphan_end"),
          startedAt: 20,
          endedAt: 30,
          text: "original summary",
          include: "original",
        })
        yield* events.publish(
          SessionEvent.Compaction.Ended,
          { sessionID, timestamp: at(40), text: "stale summary", include: "stale" },
          { id: eventID("stale_ended") },
        )

        expect(yield* readMessages()).toMatchObject([
          {
            id: eventID("completed_before_orphan"),
            type: "compaction",
            summary: "original summary",
            include: "original",
          },
        ])
      }),
    )
  })

  test("compaction ended materializes one row from started identity and ended payload", async () => {
    const dbPath = await makeDbPath()
    await run(
      dbPath,
      Effect.gen(function* () {
        yield* seedSession()
        yield* publishCompaction({
          startedID: eventID("materialized_started"),
          endedID: eventID("materialized_ended"),
          startedAt: 10,
          endedAt: 20,
          reason: "auto",
          text: "authoritative summary",
          include: "keep-after-anchor",
        })

        const messages = yield* readMessages()
        expect(messages).toHaveLength(1)
        expect(messages[0]).toMatchObject({
          id: eventID("materialized_started"),
          type: "compaction",
          reason: "auto",
          summary: "authoritative summary",
          include: "keep-after-anchor",
          time: { created: at(10) },
        })
      }),
    )
  })

  test("repeated completed compactions create two rows and context anchors on the second", async () => {
    const dbPath = await makeDbPath()
    await run(
      dbPath,
      Effect.gen(function* () {
        yield* seedSession()
        yield* publishCompaction({
          startedID: eventID("first_compaction"),
          endedID: eventID("first_compaction_end"),
          startedAt: 10,
          endedAt: 20,
          text: "first summary",
        })
        const events = yield* EventV2.Service
        yield* events.publish(
          SessionEvent.Prompted,
          {
            sessionID,
            timestamp: at(30),
            prompt: new Prompt({ text: "between", files: [], agents: [], references: [] }),
          },
          { id: eventID("between_compactions") },
        )
        yield* publishCompaction({
          startedID: eventID("second_compaction"),
          endedID: eventID("second_compaction_end"),
          startedAt: 40,
          endedAt: 50,
          text: "second summary",
        })
        yield* events.publish(
          SessionEvent.Prompted,
          {
            sessionID,
            timestamp: at(60),
            prompt: new Prompt({ text: "after", files: [], agents: [], references: [] }),
          },
          { id: eventID("after_second_compaction") },
        )

        const messages = yield* readMessages()
        expect(messages.filter((message) => message.type === "compaction").map((message) => message.id)).toEqual([
          eventID("first_compaction"),
          eventID("second_compaction"),
        ])

        const session = yield* SessionV2.Service
        const context = yield* session.context(sessionID)
        expect(context.map((message) => message.id)).toEqual([
          eventID("second_compaction"),
          eventID("after_second_compaction"),
        ])
      }),
    )
  })

  test("abandoned compaction start is not updated by a later completed compaction", async () => {
    const dbPath = await makeDbPath()
    await run(
      dbPath,
      Effect.gen(function* () {
        yield* seedSession()
        yield* publishCompaction({ startedID: eventID("abandoned_compaction"), startedAt: 10 })
        yield* publishCompaction({
          startedID: eventID("completed_after_abandoned"),
          endedID: eventID("completed_after_abandoned_end"),
          startedAt: 20,
          endedAt: 30,
          text: "completed summary",
        })

        expect(yield* readMessages()).toMatchObject([
          { id: eventID("completed_after_abandoned"), type: "compaction", summary: "completed summary" },
        ])
      }),
    )
  })

  test("duplicate replay does not duplicate compaction or mutate a stale started row", async () => {
    const sourceDb = await makeDbPath()
    const targetDb = await makeDbPath()
    const events = await run(
      sourceDb,
      Effect.gen(function* () {
        yield* seedSession()
        yield* publishCompaction({ startedID: eventID("duplicate_abandoned"), startedAt: 10 })
        yield* publishCompaction({
          startedID: eventID("duplicate_completed"),
          endedID: eventID("duplicate_completed_end"),
          startedAt: 20,
          endedAt: 30,
          text: "completed once",
        })
        return (yield* dbEvents()).map(serializedEventRow)
      }),
    )

    await run(
      targetDb,
      Effect.gen(function* () {
        yield* seedSession()
        const service = yield* EventV2.Service
        yield* service.replayAll(events)
        yield* resetStoredEvents()
        yield* service.replayAll(events)

        expect(yield* readMessages()).toMatchObject([
          { id: eventID("duplicate_completed"), type: "compaction", summary: "completed once" },
        ])
      }),
    )
  })

  test("context ignores started-only compactions and keeps messages after a started anchor visible", async () => {
    const dbPath = await makeDbPath()
    await run(
      dbPath,
      Effect.gen(function* () {
        yield* seedSession()
        const events = yield* EventV2.Service
        yield* events.publish(
          SessionEvent.Prompted,
          {
            sessionID,
            timestamp: at(10),
            prompt: new Prompt({ text: "before", files: [], agents: [], references: [] }),
          },
          { id: eventID("before_started_only") },
        )
        yield* publishCompaction({ startedID: eventID("context_started_only"), startedAt: 20 })
        yield* events.publish(
          SessionEvent.Prompted,
          {
            sessionID,
            timestamp: at(30),
            prompt: new Prompt({ text: "after start", files: [], agents: [], references: [] }),
          },
          { id: eventID("after_started_only") },
        )

        const session = yield* SessionV2.Service
        expect((yield* session.context(sessionID)).map((message) => message.id)).toEqual([
          eventID("before_started_only"),
          eventID("after_started_only"),
        ])

        yield* events.publish(
          SessionEvent.Compaction.Ended,
          { sessionID, timestamp: at(40), text: "summary", include: undefined },
          { id: eventID("context_ended") },
        )
        yield* events.publish(
          SessionEvent.Prompted,
          {
            sessionID,
            timestamp: at(50),
            prompt: new Prompt({ text: "after end", files: [], agents: [], references: [] }),
          },
          { id: eventID("after_ended") },
        )

        expect((yield* session.context(sessionID)).map((message) => message.id)).toEqual([
          eventID("context_started_only"),
          eventID("after_started_only"),
          eventID("after_ended"),
        ])
      }),
    )
  })

  test("tool called does not regress a terminal tool state", async () => {
    const dbPath = await makeDbPath()
    await run(
      dbPath,
      Effect.gen(function* () {
        yield* seedSession()
        const events = yield* EventV2.Service
        yield* events.publish(
          SessionEvent.Step.Started,
          { sessionID, timestamp: at(10), agent: "build", model },
          { id: eventID("terminal_assistant") },
        )
        yield* events.publish(
          SessionEvent.Tool.Input.Started,
          { sessionID, timestamp: at(20), callID: "call_terminal", name: "bash" },
          { id: eventID("terminal_tool") },
        )
        yield* events.publish(
          SessionEvent.Tool.Called,
          {
            sessionID,
            timestamp: at(30),
            callID: "call_terminal",
            tool: "bash",
            input: { command: "pwd" },
            provider: { executed: true },
          },
          { id: eventID("terminal_called") },
        )
        yield* events.publish(
          SessionEvent.Tool.Success,
          {
            sessionID,
            timestamp: at(40),
            callID: "call_terminal",
            structured: {},
            content: [new ToolOutput.TextContent({ type: "text", text: "/tmp" })],
            provider: { executed: true, metadata: { status: "done" } },
          },
          { id: eventID("terminal_success") },
        )
        yield* events.publish(
          SessionEvent.Tool.Called,
          {
            sessionID,
            timestamp: at(50),
            callID: "call_terminal",
            tool: "bash",
            input: { command: "pwd" },
            provider: { executed: true },
          },
          { id: eventID("terminal_called_late") },
        )

        const assistant = (yield* readMessages())[0]
        expect(assistant?.type).toBe("assistant")
        if (assistant?.type !== "assistant") return
        expect(assistant.content[0]).toMatchObject({ type: "tool", state: { status: "completed" } })
      }),
    )
  })

  test("tool settlement preserves call metadata and stores result metadata separately", async () => {
    const dbPath = await makeDbPath()
    await run(
      dbPath,
      Effect.gen(function* () {
        yield* seedSession()
        const events = yield* EventV2.Service
        yield* events.publish(
          SessionEvent.Step.Started,
          { sessionID, timestamp: at(10), agent: "build", model },
          { id: eventID("metadata_assistant") },
        )
        yield* events.publish(
          SessionEvent.Tool.Input.Started,
          { sessionID, timestamp: at(20), callID: "call_metadata", name: "bash" },
          { id: eventID("metadata_tool") },
        )
        yield* events.publish(
          SessionEvent.Tool.Called,
          {
            sessionID,
            timestamp: at(30),
            callID: "call_metadata",
            tool: "bash",
            input: { command: "pwd" },
            provider: { executed: false, metadata: { call: "metadata" } },
          },
          { id: eventID("metadata_called") },
        )
        yield* events.publish(
          SessionEvent.Tool.Success,
          {
            sessionID,
            timestamp: at(40),
            callID: "call_metadata",
            structured: {},
            content: [new ToolOutput.TextContent({ type: "text", text: "/tmp" })],
            provider: { executed: true, resultMetadata: { result: "metadata" } },
          },
          { id: eventID("metadata_success") },
        )

        const assistant = (yield* readMessages())[0]
        expect(assistant?.type).toBe("assistant")
        if (assistant?.type !== "assistant") return
        const tool = assistant.content[0]
        expect(tool?.type).toBe("tool")
        if (tool?.type !== "tool") return
        expect(tool.provider).toEqual({
          executed: true,
          metadata: { call: "metadata" },
          resultMetadata: { result: "metadata" },
        })
      }),
    )
  })

  test("legacy settlement provider metadata is treated as result metadata", async () => {
    const dbPath = await makeDbPath()
    await run(
      dbPath,
      Effect.gen(function* () {
        yield* seedSession()
        const events = yield* EventV2.Service
        yield* events.publish(
          SessionEvent.Step.Started,
          { sessionID, timestamp: at(10), agent: "build", model },
          { id: eventID("legacy_metadata_assistant") },
        )
        yield* events.publish(
          SessionEvent.Tool.Input.Started,
          { sessionID, timestamp: at(20), callID: "call_legacy_metadata", name: "bash" },
          { id: eventID("legacy_metadata_tool") },
        )
        yield* events.publish(
          SessionEvent.Tool.Called,
          {
            sessionID,
            timestamp: at(30),
            callID: "call_legacy_metadata",
            tool: "bash",
            input: { command: "pwd" },
            provider: { executed: true, metadata: { call: "metadata" } },
          },
          { id: eventID("legacy_metadata_called") },
        )
        yield* events.publish(
          SessionEvent.Tool.Failed,
          {
            sessionID,
            timestamp: at(40),
            callID: "call_legacy_metadata",
            error: { type: "unknown", message: "boom" },
            provider: { executed: true, metadata: { legacy: "settlement" } },
          },
          { id: eventID("legacy_metadata_failed") },
        )

        const assistant = (yield* readMessages())[0]
        expect(assistant?.type).toBe("assistant")
        if (assistant?.type !== "assistant") return
        const tool = assistant.content[0]
        expect(tool?.type).toBe("tool")
        if (tool?.type !== "tool") return
        expect(tool.provider).toEqual({
          executed: true,
          metadata: { call: "metadata" },
          resultMetadata: { legacy: "settlement" },
        })
      }),
    )
  })

  test("tool failed terminalizes pending tools and does not overwrite completed tools", async () => {
    const dbPath = await makeDbPath()
    await run(
      dbPath,
      Effect.gen(function* () {
        yield* seedSession()
        const events = yield* EventV2.Service
        yield* events.publish(
          SessionEvent.Step.Started,
          { sessionID, timestamp: at(10), agent: "build", model },
          { id: eventID("failed_pending_assistant") },
        )
        yield* events.publish(
          SessionEvent.Tool.Input.Started,
          { sessionID, timestamp: at(20), callID: "call_pending", name: "bash" },
          { id: eventID("failed_pending_tool") },
        )
        yield* events.publish(
          SessionEvent.Tool.Failed,
          {
            sessionID,
            timestamp: at(30),
            callID: "call_pending",
            error: { type: "unknown", message: "pending failed" },
            provider: { executed: false, resultMetadata: { interrupted: true } },
          },
          { id: eventID("failed_pending") },
        )
        yield* events.publish(
          SessionEvent.Tool.Failed,
          {
            sessionID,
            timestamp: at(40),
            callID: "call_missing",
            error: { type: "unknown", message: "missing" },
            provider: { executed: false },
          },
          { id: eventID("failed_missing") },
        )

        const pendingAssistant = (yield* readMessages())[0]
        expect(pendingAssistant?.type).toBe("assistant")
        if (pendingAssistant?.type !== "assistant") return
        expect(pendingAssistant.content).toHaveLength(1)
        const pendingTool = pendingAssistant.content[0]
        expect(pendingTool?.type).toBe("tool")
        if (pendingTool?.type !== "tool") return
        expect(pendingTool.state).toEqual({
          status: "error",
          input: {},
          structured: {},
          content: [],
          error: { type: "unknown", message: "pending failed" },
        })
        expect(pendingTool.provider?.resultMetadata).toEqual({ interrupted: true })

        yield* events.publish(
          SessionEvent.Tool.Called,
          {
            sessionID,
            timestamp: at(50),
            callID: "call_pending",
            tool: "bash",
            input: { command: "pwd" },
            provider: { executed: true },
          },
          { id: eventID("failed_late_called") },
        )

        const afterLate = (yield* readMessages())[0]
        expect(afterLate?.type).toBe("assistant")
        if (afterLate?.type !== "assistant") return
        expect(afterLate.content[0]).toMatchObject({ type: "tool", state: { status: "error" } })
      }),
    )
  })

  test("targeted step and tool events update only the assistant named by assistantMessageID", async () => {
    const dbPath = await makeDbPath()
    await run(
      dbPath,
      Effect.gen(function* () {
        yield* seedSession()
        const events = yield* EventV2.Service
        const firstAssistantID = eventID("target_first_assistant")
        const secondAssistantID = eventID("target_second_assistant")
        yield* events.publish(
          SessionEvent.Step.Started,
          { sessionID, timestamp: at(10), agent: "build", model },
          { id: firstAssistantID },
        )
        yield* events.publish(
          SessionEvent.Tool.Input.Started,
          {
            sessionID,
            assistantMessageID: firstAssistantID,
            timestamp: at(20),
            callID: "target-call",
            name: "bash",
          },
          { id: eventID("target_tool_started") },
        )
        yield* events.publish(
          SessionEvent.Step.Started,
          { sessionID, timestamp: at(30), agent: "build", model },
          { id: secondAssistantID },
        )
        yield* events.publish(
          SessionEvent.Tool.Called,
          {
            sessionID,
            assistantMessageID: firstAssistantID,
            timestamp: at(40),
            callID: "target-call",
            tool: "bash",
            input: { command: "pwd" },
            provider: { executed: true },
          },
          { id: eventID("target_tool_called") },
        )
        yield* events.publish(
          SessionEvent.Tool.Failed,
          {
            sessionID,
            assistantMessageID: firstAssistantID,
            timestamp: at(50),
            callID: "target-call",
            error: { type: "unknown", message: "boom" },
            provider: { executed: true },
          },
          { id: eventID("target_tool_failed") },
        )
        yield* events.publish(
          SessionEvent.Step.Failed,
          {
            sessionID,
            assistantMessageID: firstAssistantID,
            timestamp: at(60),
            error: { type: "unknown", message: "step boom" },
          },
          { id: eventID("target_step_failed") },
        )

        const messages = yield* readMessages()
        const first = messages.find((message) => message.id === firstAssistantID)
        const second = messages.find((message) => message.id === secondAssistantID)
        expect(first?.type).toBe("assistant")
        expect(second?.type).toBe("assistant")
        if (first?.type !== "assistant" || second?.type !== "assistant") return

        expect(first.finish).toBe("error")
        expect(first.error).toEqual({ type: "unknown", message: "step boom" })
        expect(first.content[0]).toMatchObject({ type: "tool", callID: "target-call", state: { status: "error" } })
        expect(second.finish).toBeUndefined()
        expect(second.content).toEqual([])
      }),
    )
  })

  test("untargeted fallback does not revive an older incomplete assistant after a newer completed row", async () => {
    const dbPath = await makeDbPath()
    await run(
      dbPath,
      Effect.gen(function* () {
        yield* seedSession()
        yield* insertMessage(assistantMessage({ id: "evt_projector_stale_incomplete", created: 10 }))
        yield* insertMessage(assistantMessage({ id: "evt_projector_newer_completed", created: 20, completed: 30 }))
        const events = yield* EventV2.Service
        yield* events.publish(
          SessionEvent.Step.Ended,
          {
            sessionID,
            timestamp: at(40),
            finish: "stop",
            cost: 1,
            tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
          },
          { id: eventID("untargeted_projector_step_end") },
        )

        const messages = yield* readMessages()
        const stale = messages.find((message) => message.id === "evt_projector_stale_incomplete")
        expect(stale?.type).toBe("assistant")
        if (stale?.type === "assistant") expect(stale.finish).toBeUndefined()
      }),
    )
  })

  test("projects retry metadata onto the active assistant without creating a message", async () => {
    const dbPath = await makeDbPath()
    await run(
      dbPath,
      Effect.gen(function* () {
        yield* seedSession()
        yield* retryTranscriptEvents()

        const messages = yield* readMessages()
        expect(messages.map((message) => message.type)).toEqual(["assistant"])

        const assistant = messages[0]
        expect(assistant?.type).toBe("assistant")
        if (assistant?.type !== "assistant") return

        expect(assistant.id).toBe(eventID("retry_assistant"))
        expect(assistant).toMatchObject({
          retries: [
            {
              attempt: 2,
              error: retryError(),
              time: { created: at(20) },
            },
          ],
        })
        assertNoLegacyIDs(assistant)
      }),
    )
  })

  test("projects rich failed step errors onto the active assistant", async () => {
    const dbPath = await makeDbPath()
    await run(
      dbPath,
      Effect.gen(function* () {
        yield* seedSession()
        const error = {
          type: "api",
          message: "provider returned 429",
          statusCode: 429,
          isRetryable: true,
          responseHeaders: { "retry-after": "1" },
          responseBody: "rate limited",
          metadata: { provider: "test" },
        } satisfies SessionEvent.AssistantError
        const events = yield* EventV2.Service
        yield* events.publish(
          SessionEvent.Step.Started,
          { sessionID, timestamp: at(10), agent: "build", model, snapshot: "before-error" },
          { id: eventID("failed_assistant") },
        )
        yield* events.publish(
          SessionEvent.Step.Failed,
          { sessionID, timestamp: at(20), error },
          { id: eventID("step_failed") },
        )

        const messages = yield* readMessages()
        expect(messages.map((message) => message.type)).toEqual(["assistant"])

        const assistant = messages[0]
        expect(assistant?.type).toBe("assistant")
        if (assistant?.type !== "assistant") return

        expect(assistant.finish).toBe("error")
        expect(assistant.time.completed).toEqual(at(20))
        expect(assistant.error).toEqual(error)
      }),
    )
  })

  test("drops retry metadata before any active assistant and leaves the transcript empty", async () => {
    const dbPath = await makeDbPath()
    await run(
      dbPath,
      Effect.gen(function* () {
        yield* seedSession()
        const events = yield* EventV2.Service
        yield* events.publish(
          SessionEvent.Retried,
          { sessionID, timestamp: at(10), attempt: 2, error: retryError() },
          { id: eventID("retry_without_assistant") },
        )

        expect(yield* readMessages()).toEqual([])
      }),
    )
  })

  test("replaying retry events does not duplicate assistant retry metadata", async () => {
    const sourceDb = await makeDbPath()
    const targetDb = await makeDbPath()
    const events = await run(
      sourceDb,
      Effect.gen(function* () {
        yield* seedSession()
        return (yield* retryTranscriptEvents()).map(serialized)
      }),
    )

    await run(
      targetDb,
      Effect.gen(function* () {
        yield* seedSession()
        const service = yield* EventV2.Service
        yield* service.replayAll(events)
        yield* resetStoredEvents()
        yield* service.replayAll(events)

        const messages = yield* readMessages()
        expect(messages.map((message) => message.type)).toEqual(["assistant"])

        const assistant = messages[0]
        expect(assistant?.type).toBe("assistant")
        if (assistant?.type !== "assistant") return

        expect(assistant).toMatchObject({
          retries: [
            {
              attempt: 2,
              error: retryError(),
              time: { created: at(20) },
            },
          ],
        })
      }),
    )
  })
})
