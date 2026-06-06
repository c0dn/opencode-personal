import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer, Schema } from "effect"
import { asc, eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { ModelV2 } from "@opencode-ai/core/model"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionMessageUpdater } from "@opencode-ai/core/session/message-updater"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionCompactionAnchor } from "@opencode-ai/core/session/compaction-anchor"
import { SessionInputTable, SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { testEffect } from "./lib/effect"

const database = Database.layerFromPath(":memory:")
const events = EventV2.layer.pipe(Layer.provide(database))
const projector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
const it = testEffect(Layer.mergeAll(database, events, projector))
const sessionID = SessionV2.ID.make("ses_projector_test")
const created = DateTime.makeUnsafe(0)
const model = { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") }
const encodeMessage = Schema.encodeSync(SessionMessage.Message)

const assistantRow = (
  id: SessionMessage.ID,
  seq: number,
  time: { created: DateTime.Utc; completed?: DateTime.Utc } = { created },
) => {
  const {
    id: _,
    type,
    ...data
  } = encodeMessage(new SessionMessage.Assistant({ id, type: "assistant", agent: "build", model, content: [], time }))
  return { id, session_id: sessionID, type, seq, time_created: DateTime.toEpochMillis(time.created), data }
}

const setupSession = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: "test",
      directory: "/project",
      title: "test",
      version: "test",
    })
    .run()
    .pipe(Effect.orDie)
})

const loadProjectedMessages = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const rows = yield* db
    .select()
    .from(SessionMessageTable)
    .where(eq(SessionMessageTable.session_id, sessionID))
    .orderBy(asc(SessionMessageTable.seq))
    .all()
    .pipe(Effect.orDie)
  return rows.map((row) => ({
    row,
    message: Schema.decodeUnknownSync(SessionMessage.Message)({ ...row.data, id: row.id, type: row.type }),
  }))
})

describe("SessionProjector", () => {
  it.effect("orders projected messages and context by durable aggregate sequence", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service

      yield* events.publish(
        SessionEvent.Prompted,
        {
          sessionID,
          messageID: SessionMessage.ID.make("msg_first"),
          timestamp: created,
          prompt: new Prompt({ text: "first" }),
          delivery: "steer",
        },
        { id: EventV2.ID.make("evt_z") },
      )
      yield* events.publish(
        SessionEvent.Prompted,
        {
          sessionID,
          messageID: SessionMessage.ID.make("msg_second"),
          timestamp: created,
          prompt: new Prompt({ text: "second" }),
          delivery: "steer",
        },
        { id: EventV2.ID.make("evt_a") },
      )

      const sessions = yield* SessionV2.Service
      const firstPage = yield* sessions.messages({ sessionID, limit: 1, order: "asc" })
      expect(firstPage.map((message) => (message.type === "user" ? message.text : message.type))).toEqual(["first"])
      const secondPage = yield* sessions.messages({
        sessionID,
        limit: 1,
        order: "asc",
        cursor: { id: firstPage[0]!.id, direction: "next" },
      })
      expect(secondPage.map((message) => (message.type === "user" ? message.text : message.type))).toEqual(["second"])
      expect(
        (yield* sessions.messages({
          sessionID,
          limit: 1,
          order: "asc",
          cursor: { id: secondPage[0]!.id, direction: "previous" },
        })).map((message) => (message.type === "user" ? message.text : message.type)),
      ).toEqual(["first"])
      expect(
        (yield* sessions.context(sessionID)).map((message) => (message.type === "user" ? message.text : message.type)),
      ).toEqual(["first", "second"])
    }).pipe(
      Effect.provide(
        SessionV2.layer.pipe(
          Layer.provide(events),
          Layer.provide(database),
          Layer.provide(Project.defaultLayer),
          Layer.provide(SessionStore.layer.pipe(Layer.provide(database))),
          Layer.provide(SessionExecution.noopLayer),
        ),
      ),
    ),
  )

  it.effect("marks an admitted lifecycle row promoted with the PromptPromoted event sequence", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service
      const id = SessionMessage.ID.make("msg_admitted")
      yield* SessionInput.admit(db, events, {
        id,
        sessionID,
        prompt: new Prompt({ text: "promote me" }),
        delivery: "steer",
      })

      const event = yield* events.publish(SessionEvent.PromptLifecycle.Promoted, {
        sessionID,
        timestamp: created,
        messageID: id,
        prompt: new Prompt({ text: "promote me" }),
        timeCreated: created,
      })

      expect(
        yield* db.select().from(SessionInputTable).where(eq(SessionInputTable.id, id)).get().pipe(Effect.orDie),
      ).toMatchObject({ promoted_seq: event.seq })
    }),
  )

  it.effect("projects durable context messages supported by the updater", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service

      yield* events.publish(SessionEvent.AgentSwitched, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: created,
        agent: "build",
      })
      yield* events.publish(SessionEvent.ModelSwitched, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: created,
        model,
      })
      yield* events.publish(SessionEvent.Synthetic, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: created,
        text: "synthetic context",
      })
      yield* events.publish(SessionEvent.Shell.Started, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: created,
        callID: "shell-1",
        command: "pwd",
      })
      yield* events.publish(SessionEvent.Shell.Ended, {
        sessionID,
        timestamp: DateTime.makeUnsafe(1),
        callID: "shell-1",
        output: "/project",
      })
      yield* events.publish(SessionEvent.Compaction.Started, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: created,
        reason: "manual",
      })
      yield* events.publish(SessionEvent.Compaction.Delta, { sessionID, timestamp: created, text: "partial" })
      yield* events.publish(SessionEvent.Compaction.Ended, {
        sessionID,
        timestamp: DateTime.makeUnsafe(1),
        text: "summary",
        include: "msg-1",
      })

      const rows = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .orderBy(asc(SessionMessageTable.seq))
        .all()
        .pipe(Effect.orDie)
      const messages = rows.map((row) =>
        Schema.decodeUnknownSync(SessionMessage.Message)({ ...row.data, id: row.id, type: row.type }),
      )

      expect(messages.map((message) => message.type)).toEqual([
        "agent-switched",
        "model-switched",
        "synthetic",
        "shell",
        "compaction",
      ])
      expect(messages.find((message) => message.type === "shell")).toMatchObject({
        output: "/project",
        time: { completed: DateTime.makeUnsafe(1) },
      })
      expect(messages.find((message) => message.type === "compaction")).toMatchObject({
        summary: "summary",
        include: "msg-1",
      })
      expect(
        yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie),
      ).toMatchObject({
        agent: "build",
        model,
        time_updated: DateTime.toEpochMillis(created),
      })
    }),
  )

  it.effect("rejects distinct creator events that reuse one projected message ID", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service
      const id = SessionMessage.ID.make("msg_creator_collision")

      yield* events.publish(SessionEvent.Synthetic, { sessionID, messageID: id, timestamp: created, text: "keep me" })
      const exit = yield* events
        .publish(SessionEvent.Step.Started, {
          sessionID,
          assistantMessageID: id,
          timestamp: created,
          agent: "build",
          model,
        })
        .pipe(Effect.exit)

      expect(exit._tag).toBe("Failure")
      expect(
        yield* db.select().from(SessionMessageTable).where(eq(SessionMessageTable.id, id)).get().pipe(Effect.orDie),
      ).toMatchObject({ type: "synthetic" })
    }),
  )

  it.effect("does not project compaction rows for started-only lifecycle events", () =>
    Effect.gen(function* () {
      yield* setupSession
      const events = yield* EventV2.Service

      yield* events.publish(SessionEvent.Compaction.Started, {
        sessionID,
        messageID: SessionMessage.ID.make("msg_compaction_started_only"),
        timestamp: DateTime.makeUnsafe(1),
        reason: "manual",
      })

      expect((yield* loadProjectedMessages).map((item) => item.message)).toEqual([])
    }),
  )

  it.effect("does not project compaction rows for started plus delta lifecycle events", () =>
    Effect.gen(function* () {
      yield* setupSession
      const events = yield* EventV2.Service

      yield* events.publish(SessionEvent.Compaction.Started, {
        sessionID,
        messageID: SessionMessage.ID.make("msg_compaction_started_delta"),
        timestamp: DateTime.makeUnsafe(1),
        reason: "manual",
      })
      yield* events.publish(SessionEvent.Compaction.Delta, {
        sessionID,
        timestamp: DateTime.makeUnsafe(2),
        text: "partial summary",
      })

      expect((yield* loadProjectedMessages).map((item) => item.message)).toEqual([])
    }),
  )

  it.effect("treats compaction ended without a prior started event as a no-op", () =>
    Effect.gen(function* () {
      yield* setupSession
      const events = yield* EventV2.Service

      yield* events.publish(SessionEvent.Compaction.Ended, {
        sessionID,
        timestamp: DateTime.makeUnsafe(1),
        text: "orphan summary",
      })

      expect((yield* loadProjectedMessages).map((item) => item.message)).toEqual([])
    }),
  )

  it.effect("materializes completed compaction rows from started and ended events only", () =>
    Effect.gen(function* () {
      yield* setupSession
      const events = yield* EventV2.Service
      const messageID = SessionMessage.ID.make("msg_compaction_completed")
      const started = yield* events.publish(SessionEvent.Compaction.Started, {
        sessionID,
        messageID,
        timestamp: DateTime.makeUnsafe(1),
        reason: "auto",
      })
      yield* events.publish(SessionEvent.Compaction.Delta, {
        sessionID,
        timestamp: DateTime.makeUnsafe(2),
        text: "delta summary that must be ignored",
      })
      yield* events.publish(SessionEvent.Compaction.Ended, {
        sessionID,
        timestamp: DateTime.makeUnsafe(3),
        text: "final summary",
        include: "msg_recent",
      })

      const projected = yield* loadProjectedMessages
      expect(projected).toHaveLength(1)
      expect(projected[0]?.row).toMatchObject({ id: messageID, type: "compaction", seq: started.seq })
      expect(projected[0]?.message).toEqual(
        new SessionMessage.Compaction({
          id: messageID,
          type: "compaction",
          reason: "auto",
          summary: "final summary",
          include: "msg_recent",
          time: { created: DateTime.makeUnsafe(1) },
        }),
      )
    }),
  )

  it.effect("projects multiple completed compactions as separate rows", () =>
    Effect.gen(function* () {
      yield* setupSession
      const events = yield* EventV2.Service
      const firstID = SessionMessage.ID.make("msg_compaction_first")
      const secondID = SessionMessage.ID.make("msg_compaction_second")

      yield* events.publish(SessionEvent.Compaction.Started, {
        sessionID,
        messageID: firstID,
        timestamp: DateTime.makeUnsafe(1),
        reason: "manual",
      })
      yield* events.publish(SessionEvent.Compaction.Ended, {
        sessionID,
        timestamp: DateTime.makeUnsafe(2),
        text: "first summary",
      })
      yield* events.publish(SessionEvent.Compaction.Started, {
        sessionID,
        messageID: secondID,
        timestamp: DateTime.makeUnsafe(3),
        reason: "auto",
      })
      yield* events.publish(SessionEvent.Compaction.Ended, {
        sessionID,
        timestamp: DateTime.makeUnsafe(4),
        text: "second summary",
      })

      expect((yield* loadProjectedMessages).map((item) => item.message)).toEqual([
        new SessionMessage.Compaction({
          id: firstID,
          type: "compaction",
          reason: "manual",
          summary: "first summary",
          time: { created: DateTime.makeUnsafe(1) },
        }),
        new SessionMessage.Compaction({
          id: secondID,
          type: "compaction",
          reason: "auto",
          summary: "second summary",
          time: { created: DateTime.makeUnsafe(3) },
        }),
      ])
    }),
  )

  it.effect("does not reuse older started events after a compaction ends", () =>
    Effect.gen(function* () {
      yield* setupSession
      const events = yield* EventV2.Service
      const firstID = SessionMessage.ID.make("msg_compaction_unmatched_first")
      const secondID = SessionMessage.ID.make("msg_compaction_matched_second")

      yield* events.publish(SessionEvent.Compaction.Started, {
        sessionID,
        messageID: firstID,
        timestamp: DateTime.makeUnsafe(1),
        reason: "manual",
      })
      yield* events.publish(SessionEvent.Compaction.Started, {
        sessionID,
        messageID: secondID,
        timestamp: DateTime.makeUnsafe(2),
        reason: "auto",
      })
      yield* events.publish(SessionEvent.Compaction.Ended, {
        sessionID,
        timestamp: DateTime.makeUnsafe(3),
        text: "second summary",
      })
      yield* events.publish(SessionEvent.Compaction.Ended, {
        sessionID,
        timestamp: DateTime.makeUnsafe(4),
        text: "must not reuse first",
      })

      const messages = (yield* loadProjectedMessages).map((item) => item.message)
      expect(messages).toEqual([
        new SessionMessage.Compaction({
          id: secondID,
          type: "compaction",
          reason: "auto",
          summary: "second summary",
          time: { created: DateTime.makeUnsafe(2) },
        }),
      ])
    }),
  )

  it.effect("finds the latest pending compaction started anchor between ended boundaries", () =>
    Effect.gen(function* () {
      yield* setupSession
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const staleID = SessionMessage.ID.make("msg_compaction_stale_anchor")
      const olderID = SessionMessage.ID.make("msg_compaction_older_pending_anchor")
      const latestID = SessionMessage.ID.make("msg_compaction_latest_pending_anchor")

      yield* events.publish(SessionEvent.Compaction.Started, {
        sessionID,
        messageID: staleID,
        timestamp: DateTime.makeUnsafe(1),
        reason: "manual",
      })
      yield* events.publish(SessionEvent.Compaction.Ended, {
        sessionID,
        timestamp: DateTime.makeUnsafe(2),
        text: "stale summary",
      })
      yield* events.publish(SessionEvent.Compaction.Started, {
        sessionID,
        messageID: olderID,
        timestamp: DateTime.makeUnsafe(3),
        reason: "manual",
      })
      yield* events.publish(SessionEvent.Compaction.Started, {
        sessionID,
        messageID: latestID,
        timestamp: DateTime.makeUnsafe(4),
        reason: "auto",
      })

      const beforeEnding = yield* SessionCompactionAnchor.findLatestPendingStarted({ db, sessionID })
      expect(beforeEnding).toMatchObject({ id: latestID, messageID: latestID, reason: "auto" })

      const ended = yield* events.publish(SessionEvent.Compaction.Ended, {
        sessionID,
        timestamp: DateTime.makeUnsafe(5),
        text: "latest summary",
      })
      const atEndedBoundary = yield* SessionCompactionAnchor.findLatestPendingStarted({
        db,
        sessionID,
        beforeSeq: ended.seq,
      })
      const afterEnding = yield* SessionCompactionAnchor.findLatestPendingStarted({ db, sessionID })

      expect(atEndedBoundary).toMatchObject({ id: latestID, messageID: latestID, reason: "auto" })
      expect(afterEnding).toBeUndefined()
    }),
  )

  it.effect("keeps messages between compaction started and ended visible using the started sequence", () =>
    Effect.gen(function* () {
      yield* setupSession
      const events = yield* EventV2.Service
      const compactionID = SessionMessage.ID.make("msg_compaction_before_prompt")
      const started = yield* events.publish(SessionEvent.Compaction.Started, {
        sessionID,
        messageID: compactionID,
        timestamp: DateTime.makeUnsafe(1),
        reason: "manual",
      })
      yield* events.publish(SessionEvent.Prompted, {
        sessionID,
        messageID: SessionMessage.ID.make("msg_between_compaction_events"),
        timestamp: DateTime.makeUnsafe(2),
        prompt: new Prompt({ text: "visible after compaction starts" }),
        delivery: "steer",
      })
      yield* events.publish(SessionEvent.Compaction.Ended, {
        sessionID,
        timestamp: DateTime.makeUnsafe(3),
        text: "summary",
      })

      const projected = yield* loadProjectedMessages
      expect(projected[0]?.row).toMatchObject({ id: compactionID, seq: started.seq })
      expect(projected.map((item) => item.message.type)).toEqual(["compaction", "user"])

      const sessions = yield* SessionV2.Service
      expect(
        (yield* sessions.context(sessionID)).map((message) => (message.type === "user" ? message.text : message.type)),
      ).toEqual(["compaction", "visible after compaction starts"])
    }).pipe(
      Effect.provide(
        SessionV2.layer.pipe(
          Layer.provide(events),
          Layer.provide(database),
          Layer.provide(Project.defaultLayer),
          Layer.provide(SessionStore.layer.pipe(Layer.provide(database))),
          Layer.provide(SessionExecution.noopLayer),
        ),
      ),
    ),
  )

  it.effect("fails loudly when completed compaction conflicts with a non-compaction row", () =>
    Effect.gen(function* () {
      yield* setupSession
      const events = yield* EventV2.Service
      const messageID = SessionMessage.ID.make("msg_compaction_conflict")

      yield* events.publish(SessionEvent.Compaction.Started, {
        sessionID,
        messageID,
        timestamp: DateTime.makeUnsafe(1),
        reason: "manual",
      })
      yield* events.publish(SessionEvent.Synthetic, {
        sessionID,
        messageID,
        timestamp: DateTime.makeUnsafe(2),
        text: "conflicting row",
      })
      const exit = yield* events
        .publish(SessionEvent.Compaction.Ended, {
          sessionID,
          timestamp: DateTime.makeUnsafe(3),
          text: "summary",
        })
        .pipe(Effect.exit)

      expect(String(exit)).toContain("Compaction projection conflicts with existing non-compaction message")
      expect((yield* loadProjectedMessages).map((item) => item.message.type)).toEqual(["synthetic"])
    }),
  )

  it.effect("rejects a Prompted event that conflicts with an admitted inbox row", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service
      const id = SessionMessage.ID.make("msg_conflict")
      yield* SessionInput.admit(db, events, {
        id,
        sessionID,
        prompt: new Prompt({ text: "admitted" }),
        delivery: "steer",
      })

      const exit = yield* events
        .publish(SessionEvent.Prompted, {
          sessionID,
          messageID: id,
          timestamp: created,
          prompt: new Prompt({ text: "different" }),
          delivery: "steer",
        })
        .pipe(Effect.exit)

      expect(String(exit)).toContain("SessionInput.LifecycleConflict")
      expect(
        yield* db.select().from(SessionInputTable).where(eq(SessionInputTable.id, id)).get().pipe(Effect.orDie),
      ).toMatchObject({ promoted_seq: null })
    }),
  )

  it.effect("rejects an assistant message ID that conflicts with an admitted inbox row", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service
      const id = SessionMessage.ID.make("msg_conflict")
      yield* SessionInput.admit(db, events, {
        id,
        sessionID,
        prompt: new Prompt({ text: "admitted" }),
        delivery: "steer",
      })

      const exit = yield* events
        .publish(SessionEvent.Step.Started, {
          sessionID,
          timestamp: created,
          assistantMessageID: id,
          agent: "build",
          model,
        })
        .pipe(Effect.exit)

      expect(String(exit)).toContain("SessionInput.LifecycleConflict")
      expect(
        yield* db.select().from(SessionMessageTable).where(eq(SessionMessageTable.id, id)).get().pipe(Effect.orDie),
      ).toBeUndefined()
    }),
  )

  it.effect("rejects a Prompted delivery mode that conflicts with an admitted inbox row", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service
      const id = SessionMessage.ID.make("msg_delivery_conflict")
      const prompt = new Prompt({ text: "admitted" })
      yield* SessionInput.admit(db, events, { id, sessionID, prompt, delivery: "queue" })

      const exit = yield* events
        .publish(SessionEvent.Prompted, { sessionID, messageID: id, timestamp: created, prompt, delivery: "steer" })
        .pipe(Effect.exit)

      expect(String(exit)).toContain("SessionInput.LifecycleConflict")
      expect(
        yield* db.select().from(SessionInputTable).where(eq(SessionInputTable.id, id)).get().pipe(Effect.orDie),
      ).toMatchObject({ delivery: "queue", promoted_seq: null })
    }),
  )

  it.effect("does not revive a stale incomplete in-memory assistant projection", () =>
    Effect.gen(function* () {
      const stale = new SessionMessage.Assistant({
        id: SessionMessage.ID.make("msg_assistant_stale"),
        type: "assistant",
        agent: "build",
        model,
        content: [],
        time: { created },
      })
      const completed = new SessionMessage.Assistant({
        id: SessionMessage.ID.make("msg_assistant_completed"),
        type: "assistant",
        agent: "build",
        model,
        content: [],
        time: { created: DateTime.makeUnsafe(1), completed: DateTime.makeUnsafe(2) },
      })

      expect(
        yield* SessionMessageUpdater.memory({ messages: [stale, completed] }).getCurrentAssistant(),
      ).toBeUndefined()
    }),
  )

  it.effect("updates only the newest incomplete assistant projection", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionMessageTable)
        .values([
          assistantRow(SessionMessage.ID.make("msg_assistant_1"), 0),
          assistantRow(SessionMessage.ID.make("msg_assistant_2"), 1),
        ])
        .run()
        .pipe(Effect.orDie)

      const service = yield* EventV2.Service
      yield* service.publish(SessionEvent.Step.Ended, {
        sessionID,
        timestamp: DateTime.makeUnsafe(1),
        assistantMessageID: SessionMessage.ID.make("msg_assistant_2"),
        finish: "stop",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      })

      const rows = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .orderBy(asc(SessionMessageTable.id))
        .all()
        .pipe(Effect.orDie)
      const messages = rows.map((row) =>
        Schema.decodeUnknownSync(SessionMessage.Message)({ ...row.data, id: row.id, type: row.type }),
      )
      expect(messages[0]).not.toHaveProperty("time.completed")
      expect(messages[1]).toMatchObject({
        type: "assistant",
        finish: "stop",
        time: { completed: DateTime.makeUnsafe(1) },
      })
    }),
  )

  it.effect("does not revive a stale incomplete DB-backed assistant projection", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionMessageTable)
        .values([
          assistantRow(SessionMessage.ID.make("msg_assistant_stale"), 0),
          assistantRow(SessionMessage.ID.make("msg_assistant_completed"), 1, {
            created: DateTime.makeUnsafe(1),
            completed: DateTime.makeUnsafe(2),
          }),
        ])
        .run()
        .pipe(Effect.orDie)

      const service = yield* EventV2.Service
      yield* service.publish(SessionEvent.Text.Started, {
        sessionID,
        assistantMessageID: SessionMessage.ID.make("msg_assistant_completed"),
        timestamp: DateTime.makeUnsafe(3),
        textID: "text-stale",
      })

      const rows = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .orderBy(asc(SessionMessageTable.id))
        .all()
        .pipe(Effect.orDie)
      const messages = rows.map((row) =>
        Schema.decodeUnknownSync(SessionMessage.Message)({ ...row.data, id: row.id, type: row.type }),
      )
      expect(messages).toEqual([
        new SessionMessage.Assistant({
          id: SessionMessage.ID.make("msg_assistant_completed"),
          type: "assistant",
          agent: "build",
          model,
          content: [new SessionMessage.AssistantText({ type: "text", id: "text-stale", text: "" })],
          time: { created: DateTime.makeUnsafe(1), completed: DateTime.makeUnsafe(2) },
        }),
        new SessionMessage.Assistant({
          id: SessionMessage.ID.make("msg_assistant_stale"),
          type: "assistant",
          agent: "build",
          model,
          content: [],
          time: { created },
        }),
      ])
    }),
  )
})
