import { afterEach, expect, spyOn, test } from "bun:test"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { MessageTable, PartTable, SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionLegacy } from "@opencode-ai/core/session/legacy"
import { DateTime, Effect, Layer, Schema } from "effect"
import { asc, eq } from "drizzle-orm"
import path from "path"
import {
  parseShareUrl,
  runImport,
  shouldAttachShareAuthHeaders,
  transformShareData,
  type ShareData,
} from "../../src/cli/cmd/import"
import { TranscriptV2PublicPayload } from "../../src/session/transcript-v2-public-payload"
import { testEffect } from "../lib/effect"
import { requireInstance } from "../fixture/fixture"
import { ShareNext } from "../../src/share/share-next"
import type { InstanceContext } from "../../src/project/instance-context"

const originalFetch = globalThis.fetch
const encodeMessage = Schema.encodeSync(SessionMessage.Message)

const it = testEffect(
  Layer.mergeAll(
    Database.defaultLayer,
    AppFileSystem.defaultLayer,
    Layer.mock(ShareNext.Service, {
      url: () => Effect.succeed("https://opncd.ai"),
      request: () => Effect.succeed({ baseUrl: "https://opncd.ai", headers: {}, api: { create: "/api/share", sync: (id: string) => `/api/share/${id}/sync`, remove: (id: string) => `/api/share/${id}`, data: (id: string) => `/api/shares/${id}/data` } }),
    }),
  ),
)

afterEach(() => {
  globalThis.fetch = originalFetch
})

// parseShareUrl tests
test("parses valid share URLs", () => {
  expect(parseShareUrl("https://opncd.ai/share/Jsj3hNIW")).toBe("Jsj3hNIW")
  expect(parseShareUrl("https://custom.example.com/share/abc123")).toBe("abc123")
  expect(parseShareUrl("http://localhost:3000/share/test_id-123")).toBe("test_id-123")
})

test("rejects invalid URLs", () => {
  expect(parseShareUrl("https://opncd.ai/s/Jsj3hNIW")).toBeNull() // legacy format
  expect(parseShareUrl("https://opncd.ai/share/")).toBeNull()
  expect(parseShareUrl("https://opncd.ai/share/id/extra")).toBeNull()
  expect(parseShareUrl("not-a-url")).toBeNull()
})

test("only attaches share auth headers for same-origin URLs", () => {
  expect(shouldAttachShareAuthHeaders("https://control.example.com/share/abc", "https://control.example.com")).toBe(
    true,
  )
  expect(shouldAttachShareAuthHeaders("https://other.example.com/share/abc", "https://control.example.com")).toBe(false)
  expect(shouldAttachShareAuthHeaders("https://control.example.com:443/share/abc", "https://control.example.com")).toBe(
    true,
  )
  expect(shouldAttachShareAuthHeaders("not-a-url", "https://control.example.com")).toBe(false)
})

// transformShareData tests
test("transforms share data to storage format", () => {
  const data: ShareData[] = [
    { type: "session", data: { id: "sess-1", title: "Test" } as any },
    { type: "message", data: { id: "msg-1", sessionID: "sess-1" } as any },
    { type: "part", data: { id: "part-1", messageID: "msg-1" } as any },
    { type: "part", data: { id: "part-2", messageID: "msg-1" } as any },
  ]

  const result = transformShareData(data)!

  expect(result.info.id).toBe("sess-1")
  expect(result.messages).toHaveLength(1)
  expect(result.messages[0].parts).toHaveLength(2)
})

test("returns null for invalid share data", () => {
  expect(transformShareData([])).toBeNull()
  expect(transformShareData([{ type: "message", data: {} as any }])).toBeNull()
  expect(transformShareData([{ type: "session", data: { id: "s" } as any }])).toBeNull() // no messages
})

it.instance("imports local v2 public payload into session_message rows only", () =>
  Effect.gen(function* () {
    const ctx = yield* requireInstance
    const fs = yield* AppFileSystem.Service
    const { db } = yield* Database.Service
    const payload = v2Payload()
    const file = path.join(ctx.directory, "transcript-v2.json")
    yield* fs.writeWithDirs(file, JSON.stringify(payload))

    yield* runImport(file, ctx)

    const session = yield* db.select().from(SessionTable).where(eq(SessionTable.id, sid(payload.session.id))).get()
    expect(session).toMatchObject({
      id: payload.session.id,
      project_id: ctx.project.id,
      directory: ctx.directory,
      path: path.relative(path.resolve(ctx.worktree), ctx.directory).replaceAll("\\", "/"),
      title: payload.session.title,
      version: payload.session.version,
      agent: payload.session.agent,
      model: payload.session.model,
      cost: 0,
      tokens_input: 0,
      tokens_output: 0,
      tokens_reasoning: 0,
      tokens_cache_read: 0,
      tokens_cache_write: 0,
    })
    expect(session?.slug).toBeTruthy()
    expect(session?.workspace_id).toBeNull()
    expect(session?.share_url).toBeNull()

    const rows = yield* db.select().from(SessionMessageTable).where(eq(SessionMessageTable.session_id, sid(payload.session.id))).orderBy(asc(SessionMessageTable.time_created)).all()
    expect(rows.map((row) => row.type)).toStrictEqual(["user", "assistant", "compaction"])
    const user = rows.find((row) => row.type === "user")!
    expect(user.data).toMatchObject({ text: "hello", files: [], agents: [], references: [] })
    const assistant = rows.find((row) => row.type === "assistant")!
    expect(JSON.stringify(assistant.data)).toContain("[redacted]")
    expect(JSON.stringify(assistant.data)).toContain("redacted://file")
    const legacyMessages = yield* db.select().from(MessageTable).where(eq(MessageTable.session_id, sid(payload.session.id))).all()
    const legacyParts = yield* db.select().from(PartTable).where(eq(PartTable.session_id, sid(payload.session.id))).all()
    expect(legacyMessages).toHaveLength(0)
    expect(legacyParts).toHaveLength(0)
  }),
)

it.instance("fails local v2 import on existing session id without writes", () =>
  Effect.gen(function* () {
    const ctx = yield* requireInstance
    const fs = yield* AppFileSystem.Service
    const { db } = yield* Database.Service
    const payload = v2Payload({ sessionID: "ses_import_v2_collision" })
    yield* db.insert(SessionTable).values(sessionRow(ctx, payload.session.id)).run()
    const file = path.join(ctx.directory, "collision.json")
    yield* fs.writeWithDirs(file, JSON.stringify(payload))

    const exit = yield* Effect.exit(runImport(file, ctx))

    expect(String(exit)).toContain("Session already exists")
    expect(yield* db.select().from(SessionMessageTable).where(eq(SessionMessageTable.session_id, sid(payload.session.id))).all()).toHaveLength(0)
    expect(yield* db.select().from(MessageTable).where(eq(MessageTable.session_id, sid(payload.session.id))).all()).toHaveLength(0)
  }),
)

it.instance("fails local v2 import on existing message id before inserting session", () =>
  Effect.gen(function* () {
    const ctx = yield* requireInstance
    const fs = yield* AppFileSystem.Service
    const { db } = yield* Database.Service
    const payload = v2Payload({ sessionID: "ses_import_v2_message_collision" })
    yield* db.insert(SessionTable).values(sessionRow(ctx, "ses_existing_message_owner")).run()
    yield* db.insert(SessionMessageTable).values(v2Row("ses_existing_message_owner", userMessage(payload.messages[0]!.id))).run()
    const file = path.join(ctx.directory, "message-collision.json")
    yield* fs.writeWithDirs(file, JSON.stringify(payload))

    const exit = yield* Effect.exit(runImport(file, ctx))

    expect(String(exit)).toContain("Session message already exists")
    expect(yield* db.select().from(SessionTable).where(eq(SessionTable.id, sid(payload.session.id))).all()).toHaveLength(0)
    expect(yield* db.select().from(MessageTable).where(eq(MessageTable.session_id, sid(payload.session.id))).all()).toHaveLength(0)
  }),
)

it.instance("fails malformed or unsupported local v2 envelopes without fallback writes", () =>
  Effect.gen(function* () {
    const ctx = yield* requireInstance
    const fs = yield* AppFileSystem.Service
    const { db } = yield* Database.Service
    for (const [name, value] of [
      ["malformed", { kind: TranscriptV2PublicPayload.PUBLIC_TRANSCRIPT_KIND, version: 2, session: {}, messages: [] }],
      ["version", { ...v2Payload(), version: 99 }],
      ["kind", { ...v2Payload(), kind: "other.transcript" }],
    ] as const) {
      const file = path.join(ctx.directory, `${name}.json`)
      yield* fs.writeWithDirs(file, JSON.stringify(value))
      const exit = yield* Effect.exit(runImport(file, ctx))
      expect(String(exit)).toContain("Invalid v2 transcript import payload")
    }
    expect(yield* db.select().from(SessionMessageTable).all()).toHaveLength(0)
    expect(yield* db.select().from(MessageTable).all()).toHaveLength(0)
    expect(yield* db.select().from(PartTable).all()).toHaveLength(0)
  }),
)

it.instance("fails envelope-valid v2 payload with invalid session row values without writes", () =>
  Effect.gen(function* () {
    const ctx = yield* requireInstance
    const fs = yield* AppFileSystem.Service
    const { db } = yield* Database.Service
    const payload = v2Payload({ sessionID: "bad_import_v2_session" })
    const file = path.join(ctx.directory, "bad-session-row.json")
    yield* fs.writeWithDirs(file, JSON.stringify(payload))

    const exit = yield* Effect.exit(runImport(file, ctx))

    expect(String(exit)).toContain("Invalid v2 transcript import payload")
    expect(yield* db.select().from(SessionTable).all()).toHaveLength(0)
    expect(yield* db.select().from(SessionMessageTable).all()).toHaveLength(0)
    expect(yield* db.select().from(MessageTable).all()).toHaveLength(0)
    expect(yield* db.select().from(PartTable).all()).toHaveLength(0)
  }),
)

it.instance("fails unknown local shapes and invalid JSON as typed CLI errors", () =>
  Effect.gen(function* () {
    const ctx = yield* requireInstance
    const fs = yield* AppFileSystem.Service
    const { db } = yield* Database.Service
    const unknown = path.join(ctx.directory, "unknown.json")
    const invalid = path.join(ctx.directory, "invalid.json")
    yield* fs.writeWithDirs(unknown, JSON.stringify({ messages: [] }))
    yield* fs.writeWithDirs(invalid, "{ nope")

    for (const file of [unknown, invalid]) {
      const exit = yield* Effect.exit(runImport(file, ctx))
      expect(String(exit)).toContain("CliError")
    }
    expect(yield* db.select().from(SessionTable).all()).toHaveLength(0)
  }),
)

it.instance("keeps legacy local file import on legacy tables", () =>
  Effect.gen(function* () {
    const ctx = yield* requireInstance
    const fs = yield* AppFileSystem.Service
    const { db } = yield* Database.Service
    const file = path.join(ctx.directory, "legacy.json")
    const legacy = legacyPayload()
    yield* fs.writeWithDirs(file, JSON.stringify(legacy))

    yield* runImport(file, ctx)

    expect(yield* db.select().from(MessageTable).where(eq(MessageTable.session_id, sid(legacy.info.id))).all()).toHaveLength(1)
    expect(yield* db.select().from(SessionMessageTable).where(eq(SessionMessageTable.session_id, sid(legacy.info.id))).all()).toHaveLength(0)
  }),
)

it.instance("imports v2 public transcript share URLs into session_message rows only", () =>
  Effect.gen(function* () {
    const ctx = yield* requireInstance
    const { db } = yield* Database.Service
    const payload = v2Payload({ sessionID: "ses_share_v2" })
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify([{ type: "public_transcript_v2", payload }]), { status: 200 }) as never)

    yield* runImport("https://opncd.ai/share/share_v2", ctx)

    expect(fetchSpy).toHaveBeenCalled()
    expect(yield* db.select().from(SessionTable).where(eq(SessionTable.id, sid(payload.session.id))).all()).toHaveLength(1)
    expect(yield* db.select().from(SessionMessageTable).where(eq(SessionMessageTable.session_id, sid(payload.session.id))).all()).toHaveLength(3)
    expect(yield* db.select().from(MessageTable).where(eq(MessageTable.session_id, sid(payload.session.id))).all()).toHaveLength(0)
    expect(yield* db.select().from(PartTable).where(eq(PartTable.session_id, sid(payload.session.id))).all()).toHaveLength(0)
  }),
)

it.instance("fails share URL import when response JSON is not an array", () =>
  Effect.gen(function* () {
    const ctx = yield* requireInstance
    const { db } = yield* Database.Service
    spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ error: "not found" }), { status: 200 }) as never)

    const exit = yield* Effect.exit(runImport("https://opncd.ai/share/not_array", ctx))

    expect(String(exit)).toContain("CliError")
    expect(String(exit)).toContain("Share data was not a valid array")
    expect(yield* db.select().from(SessionTable).all()).toHaveLength(0)
    expect(yield* db.select().from(SessionMessageTable).all()).toHaveLength(0)
    expect(yield* db.select().from(MessageTable).all()).toHaveLength(0)
    expect(yield* db.select().from(PartTable).all()).toHaveLength(0)
  }),
)

function v2Payload(input?: { sessionID?: string }) {
  const sessionID = input?.sessionID ?? "ses_import_v2"
  return {
    kind: TranscriptV2PublicPayload.PUBLIC_TRANSCRIPT_KIND,
    version: TranscriptV2PublicPayload.PUBLIC_TRANSCRIPT_VERSION,
    session: {
      id: sessionID,
      title: "Imported v2",
      version: "2.0.0",
      agent: "build",
      model: model(),
      time: { created: 100, updated: 200 },
    },
    messages: [
      {
        type: "user",
        id: eid("user"),
        text: "hello",
        taskRequests: [{ type: "task-request", id: eid("task"), prompt: "[redacted]", description: "[redacted]", agent: "reviewer", model: model(), command: "[redacted]" }],
        time: { created: 100 },
      },
      {
        type: "assistant",
        id: eid("assistant"),
        agent: "build",
        model: model(),
        content: [
          { type: "text", id: eid("text"), text: "safe answer" },
          { type: "patch", id: eid("patch"), hash: "hash", files: ["redacted-file-1"] },
          {
            type: "tool",
            id: eid("tool"),
            callID: eid("call"),
            name: "bash",
            title: "[redacted]",
            provider: { executed: true },
            state: {
              status: "error",
              input: "[redacted]",
              structured: "[redacted]",
              content: [
                { type: "text", text: "[redacted]" },
                { type: "file", uri: "redacted://file", mime: "text/plain", name: "[redacted]" },
              ],
              error: "[redacted]",
            },
            time: { created: 110, ran: 120, completed: 130 },
          },
        ],
        time: { created: 110, completed: 130 },
      },
      { type: "compaction", id: eid("compaction"), reason: "manual", summary: "[redacted]", include: eid("user"), time: { created: 140 } },
    ],
  } as unknown as TranscriptV2PublicPayload.PublicTranscriptPayloadV2
}

function legacyPayload() {
  return {
    info: {
      id: "ses_import_legacy",
      slug: "legacy",
      projectID: "proj_old",
      directory: "/old",
      path: "old",
      title: "Legacy import",
      version: "1.0.0",
      time: { created: 1, updated: 2 },
    },
    messages: [
      {
        info: {
          id: SessionLegacy.MessageID.make("msg_import_legacy"),
          sessionID: sid("ses_import_legacy"),
          role: "user",
          time: { created: 1 },
          agent: "build",
          model: { providerID: "provider" as SessionLegacy.User["model"]["providerID"], modelID: "model" as SessionLegacy.User["model"]["modelID"] },
        } satisfies SessionLegacy.User,
        parts: [],
      },
    ],
  }
}

function sessionRow(ctx: InstanceContext, sessionID: string): typeof SessionTable.$inferInsert {
  return {
    id: sid(sessionID),
    project_id: ctx.project.id,
    slug: "existing",
    directory: ctx.directory,
    path: path.relative(path.resolve(ctx.worktree), ctx.directory).replaceAll("\\", "/"),
    title: "Existing",
    version: "1.0.0",
    time_created: 1,
    time_updated: 1,
  }
}

function v2Row(sessionID: string, message: SessionMessage.Message): typeof SessionMessageTable.$inferInsert {
  const encoded = encodeMessage(message)
  const { id, type, ...data } = encoded
  return { id: SessionMessage.ID.make(id), session_id: sid(sessionID), type, time_created: DateTime.toEpochMillis(message.time.created), data }
}

function userMessage(messageID: string): SessionMessage.User {
  return new SessionMessage.User({ type: "user", id: EventV2.ID.make(messageID), text: "existing", files: [], agents: [], references: [], time: { created: DateTime.makeUnsafe(1) } })
}

function model() {
  return { providerID: "provider", id: "model", variant: "default" } as unknown as TranscriptV2PublicPayload.PublicAssistantMessage["model"]
}

function sid(id: string) {
  return id as (typeof SessionTable.$inferSelect)["id"]
}

function eid(suffix: string) {
  return EventV2.ID.make(`evt_import_${suffix}`)
}
