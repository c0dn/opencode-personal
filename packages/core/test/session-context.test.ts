import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { testEffect } from "./lib/effect"

const database = Database.layerFromPath(":memory:")
const events = EventV2.layer.pipe(Layer.provide(database))
const store = SessionStore.layer.pipe(Layer.provide(database))
const sessions = SessionV2.layer.pipe(
  Layer.provide(database),
  Layer.provide(events),
  Layer.provide(store),
  Layer.provide(Project.defaultLayer),
  Layer.provide(SessionExecution.noopLayer),
)
const it = testEffect(Layer.mergeAll(database, sessions))
const created = DateTime.makeUnsafe(0)
const encodeMessage = Schema.encodeSync(SessionMessage.Message)

describe("SessionContext", () => {
  it.effect("keeps compaction include tail through the production SessionV2.context source", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_context_include_tail")
      const before = SessionMessage.ID.make("msg_context_before")
      const tailFirst = SessionMessage.ID.make("msg_context_tail_first")
      const tailSecond = SessionMessage.ID.make("msg_context_tail_second")
      const compaction = SessionMessage.ID.make("msg_context_compaction")
      const after = SessionMessage.ID.make("msg_context_after")

      yield* seedSession(sessionID, [
        { message: user(before, "before include"), seq: 0 },
        { message: user(tailFirst, "tail first"), seq: 1 },
        { message: user(tailSecond, "tail second"), seq: 2 },
        { message: compactionMessage(compaction, tailFirst), seq: 3 },
        { message: user(after, "after compaction"), seq: 4 },
      ])

      const session = yield* SessionV2.Service
      const context = yield* session.context(sessionID)

      expect(context.map((message) => message.id)).toEqual([compaction, tailFirst, tailSecond, after])
      expect(context.map((message) => message.type)).toEqual(["compaction", "user", "user", "user"])
    }),
  )

  it.effect("uses the latest compaction without include as the context anchor", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_context_latest_no_include")
      const before = SessionMessage.ID.make("msg_context_latest_before")
      const oldCompaction = SessionMessage.ID.make("msg_context_latest_old_compaction")
      const between = SessionMessage.ID.make("msg_context_latest_between")
      const compaction = SessionMessage.ID.make("msg_context_latest_compaction")
      const after = SessionMessage.ID.make("msg_context_latest_after")

      yield* seedSession(sessionID, [
        { message: user(before, "before old compaction"), seq: 0 },
        { message: compactionMessage(oldCompaction, before), seq: 1 },
        { message: user(between, "between compactions"), seq: 2 },
        { message: compactionMessage(compaction), seq: 3 },
        { message: user(after, "after latest compaction"), seq: 4 },
      ])

      const session = yield* SessionV2.Service
      const context = yield* session.context(sessionID)

      expect(context.map((message) => message.id)).toEqual([compaction, after])
    }),
  )

  it.effect("ignores a missing compaction include target", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_context_missing_include")
      const before = SessionMessage.ID.make("msg_context_missing_before")
      const tail = SessionMessage.ID.make("msg_context_missing_tail")
      const missing = SessionMessage.ID.make("msg_context_missing_target")
      const compaction = SessionMessage.ID.make("msg_context_missing_compaction")
      const after = SessionMessage.ID.make("msg_context_missing_after")

      yield* seedSession(sessionID, [
        { message: user(before, "before missing include"), seq: 0 },
        { message: user(tail, "tail not retained"), seq: 1 },
        { message: compactionMessage(compaction, missing), seq: 2 },
        { message: user(after, "after missing include"), seq: 3 },
      ])

      const session = yield* SessionV2.Service
      const context = yield* session.context(sessionID)

      expect(context.map((message) => message.id)).toEqual([compaction, after])
    }),
  )

  it.effect("ignores a malformed compaction include value", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_context_invalid_include")
      const before = SessionMessage.ID.make("msg_context_invalid_before")
      const tail = SessionMessage.ID.make("msg_context_invalid_tail")
      const compaction = SessionMessage.ID.make("msg_context_invalid_compaction")
      const after = SessionMessage.ID.make("msg_context_invalid_after")

      yield* seedSession(sessionID, [
        { message: user(before, "before invalid include"), seq: 0 },
        { message: user(tail, "tail not retained"), seq: 1 },
        { message: compactionMessageWithRawInclude(compaction, "context_invalid_include"), seq: 2 },
        { message: user(after, "after invalid include"), seq: 3 },
      ])

      const session = yield* SessionV2.Service
      const context = yield* session.context(sessionID)

      expect(context.map((message) => message.id)).toEqual([compaction, after])
    }),
  )

  it.effect("ignores a compaction include target at or after the anchor", () =>
    Effect.gen(function* () {
      const atAnchorSessionID = SessionV2.ID.make("ses_context_include_at_anchor")
      const beforeAtAnchor = SessionMessage.ID.make("msg_context_at_anchor_before")
      const compactionAtAnchor = SessionMessage.ID.make("msg_context_at_anchor_compaction")
      const afterAtAnchor = SessionMessage.ID.make("msg_context_at_anchor_after")
      const afterAnchorSessionID = SessionV2.ID.make("ses_context_include_after_anchor")
      const beforeAfterAnchor = SessionMessage.ID.make("msg_context_after_anchor_before")
      const tailAfterAnchor = SessionMessage.ID.make("msg_context_after_anchor_tail")
      const compactionAfterAnchor = SessionMessage.ID.make("msg_context_after_anchor_compaction")
      const afterAfterAnchor = SessionMessage.ID.make("msg_context_after_anchor_after")

      yield* seedSession(atAnchorSessionID, [
        { message: user(beforeAtAnchor, "before at-anchor include"), seq: 0 },
        { message: compactionMessage(compactionAtAnchor, compactionAtAnchor), seq: 1 },
        { message: user(afterAtAnchor, "after at-anchor include"), seq: 2 },
      ])
      yield* seedSession(afterAnchorSessionID, [
        { message: user(beforeAfterAnchor, "before after-anchor include"), seq: 0 },
        { message: user(tailAfterAnchor, "tail not retained"), seq: 1 },
        { message: compactionMessage(compactionAfterAnchor, afterAfterAnchor), seq: 2 },
        { message: user(afterAfterAnchor, "after after-anchor include"), seq: 3 },
      ])

      const session = yield* SessionV2.Service
      const atAnchorContext = yield* session.context(atAnchorSessionID)
      const afterAnchorContext = yield* session.context(afterAnchorSessionID)

      expect(atAnchorContext.map((message) => message.id)).toEqual([compactionAtAnchor, afterAtAnchor])
      expect(afterAnchorContext.map((message) => message.id)).toEqual([compactionAfterAnchor, afterAfterAnchor])
    }),
  )

  it.effect("ignores a compaction include target from another session", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_context_other_session_include")
      const otherSessionID = SessionV2.ID.make("ses_context_other_session_source")
      const before = SessionMessage.ID.make("msg_context_other_before")
      const tail = SessionMessage.ID.make("msg_context_other_tail")
      const include = SessionMessage.ID.make("msg_context_other_include")
      const compaction = SessionMessage.ID.make("msg_context_other_compaction")
      const after = SessionMessage.ID.make("msg_context_other_after")

      yield* seedSession(otherSessionID, [{ message: user(include, "include in another session"), seq: 0 }])
      yield* seedSession(sessionID, [
        { message: user(before, "before other-session include"), seq: 0 },
        { message: user(tail, "tail not retained"), seq: 1 },
        { message: compactionMessage(compaction, include), seq: 2 },
        { message: user(after, "after other-session include"), seq: 3 },
      ])

      const session = yield* SessionV2.Service
      const context = yield* session.context(sessionID)

      expect(context.map((message) => message.id)).toEqual([compaction, after])
    }),
  )
})

function user(id: SessionMessage.ID, text: string) {
  return new SessionMessage.User({
    id,
    type: "user",
    text,
    files: [],
    agents: [],
    references: [],
    time: { created },
  })
}

function compactionMessage(id: SessionMessage.ID, include?: SessionMessage.ID) {
  return compactionMessageWithRawInclude(id, include)
}

function compactionMessageWithRawInclude(id: SessionMessage.ID, include?: string) {
  const base = {
    id,
    type: "compaction" as const,
    reason: "manual" as const,
    summary: "summary",
    time: { created },
  }
  return new SessionMessage.Compaction(include ? { ...base, include } : base)
}

function seedSession(sessionID: SessionV2.ID, messages: { message: SessionMessage.Message; seq: number }[]) {
  return Effect.gen(function* () {
    const database = yield* Database.Service
    yield* database.db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* database.db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: sessionID,
        directory: "/project",
        title: sessionID,
        version: "test",
      })
      .run()
      .pipe(Effect.orDie)
    yield* database.db
      .insert(SessionMessageTable)
      .values(messages.map((message) => row(sessionID, message.message, message.seq)))
      .run()
      .pipe(Effect.orDie)
  })
}

function row(sessionID: SessionV2.ID, message: SessionMessage.Message, seq: number) {
  const encoded = encodeMessage(message)
  const { id: _, type: __, ...data } = encoded
  return {
    id: message.id,
    session_id: sessionID,
    type: message.type,
    seq,
    time_created: DateTime.toEpochMillis(message.time.created),
    data,
  }
}
