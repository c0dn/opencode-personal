import { describe, expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { MessageTable, PartTable, SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionStore } from "@opencode-ai/core/session/store"
import { BackgroundJob } from "@/background/job"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Session } from "@/session/session"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { TranscriptV2Public } from "@/session/transcript-v2-public"
import { DateTime, Effect, Layer, Schema } from "effect"
import { testEffect } from "../lib/effect"

const database = Database.layerFromPath(":memory:")
const events = EventV2.layer.pipe(Layer.provide(database))
const eventBridge = EventV2Bridge.layer.pipe(Layer.provide(events))
const sessionStore = SessionStore.layer.pipe(Layer.provide(database))
const project = Layer.mock(ProjectV2.Service, {
  directories: () => Effect.succeed([]),
  resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory, vcs: undefined }),
  commit: () => Effect.void,
})
const session = Session.layer.pipe(
  Layer.provide(database),
  Layer.provide(eventBridge),
  Layer.provide(BackgroundJob.defaultLayer),
  Layer.provide(RuntimeFlags.layer({})),
)
const sessionV2 = SessionV2.layer.pipe(
  Layer.provide(database),
  Layer.provide(events),
  Layer.provide(sessionStore),
  Layer.provide(SessionExecution.noopLayer),
  Layer.provide(project),
)
const it = testEffect(
  Layer.mergeAll(
    database,
    events,
    eventBridge,
    session,
    sessionV2,
  ),
)

const providerID = ProviderV2.ID.make("test-provider")
const model = {
  id: ModelV2.ID.make("test-model"),
  providerID,
  variant: ModelV2.VariantID.make("default"),
}
const encodeMessage = Schema.encodeUnknownSync(SessionMessage.Message)

describe("TranscriptV2Public", () => {
  it.effect("loads Session.Info plus canonical v2 messages in ascending order", () =>
    Effect.gen(function* () {
      const sessionID = SessionID.make("ses_transcript_order")
      yield* setupSession(sessionID, "ordered transcript")
      yield* insertCanonicalMessage(sessionID, userMessage("msg_second", "second", 2000), 2)
      yield* insertCanonicalMessage(sessionID, userMessage("msg_first", "first", 1000), 1)

      const payload = yield* TranscriptV2Public.load(sessionID)

      expect(payload.version).toBe(2)
      expect(payload.info.title).toBe("ordered transcript")
      expect(payload.messages.map(messageText)).toEqual(["first", "second"])
    }),
  )

  it.effect("encodes a JSON-compatible public payload with millis DateTimes and version 2", () =>
    Effect.gen(function* () {
      const sessionID = SessionID.make("ses_transcript_encode")
      yield* setupSession(sessionID, "encoded transcript")
      yield* insertCanonicalMessage(sessionID, userMessage("msg_encoded", "hello", 1234), 1)

      const payload = yield* TranscriptV2Public.load(sessionID)
      const encoded = TranscriptV2Public.encode(payload) as Record<string, unknown>

      expect(encoded.version).toBe(2)
      expect((encoded.messages as Array<{ time: { created: number } }>)[0]!.time.created).toBe(1234)
      expect(JSON.parse(JSON.stringify(encoded))).toEqual(encoded)
    }),
  )

  it.effect("does not backfill or adapt legacy-only MessageTable and PartTable rows", () =>
    Effect.gen(function* () {
      const sessionID = SessionID.make("ses_transcript_legacy_only")
      yield* setupSession(sessionID, "legacy transcript")
      yield* insertLegacyRows(sessionID)

      const payload = yield* TranscriptV2Public.load(sessionID)
      const encoded = TranscriptV2Public.encode(payload)

      expect(payload.messages).toEqual([])
      expect(JSON.stringify(encoded)).not.toContain("msg_legacy")
      expect(JSON.stringify(encoded)).not.toContain("prt_legacy")
    }),
  )

  it.effect("fails explicitly for corrupt v2 message rows without falling back to legacy rows", () =>
    Effect.gen(function* () {
      const sessionID = SessionID.make("ses_transcript_corrupt")
      yield* setupSession(sessionID, "corrupt transcript")
      yield* insertLegacyRows(sessionID)
      yield* insertCorruptCanonicalRow(sessionID)

      const exit = yield* TranscriptV2Public.load(sessionID).pipe(Effect.exit)

      expect(exit._tag).toBe("Failure")
    }),
  )

  it.effect("does not include legacy part ids in canonical payload JSON", () =>
    Effect.gen(function* () {
      const sessionID = SessionID.make("ses_transcript_canonical_ids")
      yield* setupSession(sessionID, "canonical transcript")
      yield* insertCanonicalMessage(
        sessionID,
        new SessionMessage.Assistant({
          id: SessionMessage.ID.make("msg_canonical_assistant"),
          type: "assistant",
          agent: "build",
          model,
          content: [new SessionMessage.AssistantText({ type: "text", id: "evt_text", text: "assistant" })],
          time: { created: DateTime.makeUnsafe(2000) },
        }),
        1,
      )

      const payload = yield* TranscriptV2Public.load(sessionID)
      const encoded = TranscriptV2Public.encode(payload)
      const json = JSON.stringify(encoded)

      expect(json).toContain("evt_text")
      expect(json).not.toContain("prt_")
    }),
  )
})

function setupSession(sessionID: SessionID, title: string) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const projectRow: typeof ProjectTable.$inferInsert = {
      id: ProjectV2.ID.global,
      worktree: AbsolutePath.make("/project"),
      sandboxes: [],
      time_created: 1,
      time_updated: 1,
    }
    const sessionRow: typeof SessionTable.$inferInsert = {
      id: sessionID,
      project_id: ProjectV2.ID.global,
      slug: title.replaceAll(" ", "-"),
      directory: "/project",
      title,
      version: "test",
      cost: 0,
      tokens_input: 0,
      tokens_output: 0,
      tokens_reasoning: 0,
      tokens_cache_read: 0,
      tokens_cache_write: 0,
      time_created: 1,
      time_updated: 2,
    }
    yield* db
      .insert(ProjectTable)
      .values(projectRow)
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values(sessionRow)
      .run()
      .pipe(Effect.orDie)
  })
}

function userMessage(id: string, text: string, created: number) {
  return new SessionMessage.User({
    id: SessionMessage.ID.make(id),
    type: "user",
    text,
    files: [],
    agents: [],
    references: [],
    time: { created: DateTime.makeUnsafe(created) },
  })
}

function messageText(message: SessionMessage.Message) {
  if (message.type === "user") return message.text
  if (message.type === "assistant") return message.content.map((item) => (item.type === "text" ? item.text : "")).join("")
  return message.type
}

function insertCanonicalMessage(sessionID: SessionID, message: SessionMessage.Message, seq: number) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const encoded = encodeMessage(message)
    const { id, type, ...data } = encoded
    const row: typeof SessionMessageTable.$inferInsert = {
      id: SessionMessage.ID.make(id),
      session_id: sessionID,
      type,
      seq,
      time_created: DateTime.toEpochMillis(message.time.created),
      time_updated: DateTime.toEpochMillis(message.time.created),
      data: data as (typeof SessionMessageTable.$inferInsert)["data"],
    }
    yield* db
      .insert(SessionMessageTable)
      .values(row)
      .run()
      .pipe(Effect.orDie)
  })
}

function insertLegacyRows(sessionID: SessionID) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const messageRow: typeof MessageTable.$inferInsert = {
      id: MessageID.make("msg_legacy"),
      session_id: sessionID,
      time_created: 1,
      time_updated: 1,
      data: { role: "user", time: { created: 1 } } as (typeof MessageTable.$inferInsert)["data"],
    }
    const partRow: typeof PartTable.$inferInsert = {
      id: PartID.make("prt_legacy"),
      message_id: MessageID.make("msg_legacy"),
      session_id: sessionID,
      time_created: 1,
      time_updated: 1,
      data: { type: "text", text: "legacy" } as (typeof PartTable.$inferInsert)["data"],
    }
    yield* db
      .insert(MessageTable)
      .values(messageRow)
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(PartTable)
      .values(partRow)
      .run()
      .pipe(Effect.orDie)
  })
}

function insertCorruptCanonicalRow(sessionID: SessionID) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const row: typeof SessionMessageTable.$inferInsert = {
      id: SessionMessage.ID.make("msg_corrupt"),
      session_id: sessionID,
      type: "user",
      seq: 1,
      time_created: 1,
      time_updated: 1,
      data: { text: "missing required fields" } as unknown as (typeof SessionMessageTable.$inferInsert)["data"],
    }
    yield* db
      .insert(SessionMessageTable)
      .values(row)
      .run()
      .pipe(Effect.orDie)
  })
}
