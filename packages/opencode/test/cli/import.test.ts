import { test, expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionMessageTable } from "@opencode-ai/core/session/sql"
import { asc, eq } from "drizzle-orm"
import { DateTime, Effect } from "effect"
import {
  decodeLocalImportData,
  importTranscriptV2,
  isTranscriptV2ImportPayload,
  parseShareUrl,
  shouldAttachShareAuthHeaders,
  transformShareData,
  type ShareData,
} from "../../src/cli/cmd/import"
import type { InstanceContext } from "../../src/project/instance-context"
import { SessionID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

const it = testEffect(Database.layerFromPath(":memory:"))

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

test("recognizes canonical local v2 transcript payloads", () => {
  const payload = v2Payload()
  const result = decodeLocalImportData(payload)

  expect(isTranscriptV2ImportPayload(payload)).toBe(true)
  expect(isTranscriptV2ImportPayload({ version: 2 })).toBe(false)
  expect(result.type).toBe("v2")
  if (result.type === "v2") {
    expect(result.payload.info.id).toBe(SessionID.make("ses_import_v2"))
    expect(DateTime.toEpochMillis(result.payload.messages[0].time.created)).toBe(3)
  }
})

test("treats non-v2 local data as legacy import data", () => {
  const legacy = { info: { id: "ses_legacy" }, messages: [] }
  const result = decodeLocalImportData(legacy)

  expect(result.type).toBe("legacy")
  if (result.type === "legacy") expect(result.data as unknown).toEqual(legacy)
})

it.effect("appends v2 local imports after existing canonical messages", () =>
  Effect.gen(function* () {
    const sessionID = SessionID.make("ses_import_v2_existing")
    const ctx = testContext()
    yield* insertProject(ctx)

    yield* importTranscriptV2(decodedV2Payload(v2Payload({ sessionID, messageID: "msg_import_existing" })), ctx)
    yield* importTranscriptV2(decodedV2Payload(v2Payload({ sessionID, messageID: "msg_import_existing" })), ctx)
    yield* importTranscriptV2(decodedV2Payload(v2Payload({ sessionID, messageID: "msg_import_new" })), ctx)

    const { db } = yield* Database.Service
    const rows = yield* db
      .select({ id: SessionMessageTable.id, seq: SessionMessageTable.seq })
      .from(SessionMessageTable)
      .where(eq(SessionMessageTable.session_id, sessionID))
      .orderBy(asc(SessionMessageTable.seq))
      .all()
      .pipe(Effect.orDie)

    expect(rows).toEqual([
      { id: SessionMessage.ID.make("msg_import_existing"), seq: 1 },
      { id: SessionMessage.ID.make("msg_import_new"), seq: 2 },
    ])
  }),
)

function v2Payload(input?: { sessionID?: SessionID; messageID?: string }) {
  const sessionID = input?.sessionID ?? SessionID.make("ses_import_v2")
  const messageID = input?.messageID ?? "msg_import_v2"
  return {
    version: 2,
    info: {
      id: sessionID,
      slug: "import-v2",
      projectID: ProjectV2.ID.global,
      directory: "/old/project",
      title: "V2 import",
      version: "test",
      time: { created: 1, updated: 2 },
    },
    messages: [
      {
        id: SessionMessage.ID.make(messageID),
        type: "user",
        text: "hello",
        files: [],
        agents: [],
        references: [],
        time: { created: 3 },
      },
    ],
  }
}

function decodedV2Payload(input: unknown) {
  const result = decodeLocalImportData(input)
  if (result.type === "v2") return result.payload
  throw new Error("expected v2 payload")
}

function testContext() {
  const worktree = AbsolutePath.make("/project")
  return {
    project: { id: ProjectV2.ID.global, worktree, time: { created: 1, updated: 1 }, sandboxes: [] },
    directory: worktree,
    worktree,
  }
}

function insertProject(ctx: InstanceContext) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const row: typeof ProjectTable.$inferInsert = {
      id: ctx.project.id,
      worktree: AbsolutePath.make(ctx.worktree),
      sandboxes: [],
      time_created: 1,
      time_updated: 1,
    }
    yield* db.insert(ProjectTable).values(row).onConflictDoNothing().run().pipe(Effect.orDie)
  })
}
