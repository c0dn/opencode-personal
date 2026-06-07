import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { DateTime, Effect, Layer, Schema } from "effect"
import { DataMigrationTable } from "@opencode-ai/core/data-migration.sql"
import { Database } from "@opencode-ai/core/database/database"
import { ModelV2 } from "@opencode-ai/core/model"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { TaskToolMetadataRemediation } from "@opencode-ai/core/session/task-tool-metadata-remediation"
import { MessageTable, PartTable, SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { MessageID, PartID } from "@opencode-ai/core/v1/session"
import { testEffect } from "./lib/effect"

const database = Database.layerFromPath(":memory:")
const it = testEffect(Layer.mergeAll(database))
const created = DateTime.makeUnsafe(1)
const completed = DateTime.makeUnsafe(2)
const model = { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") }
const encodeMessage = Schema.encodeSync(SessionMessage.Message)
const decodeMessage = Schema.decodeUnknownSync(SessionMessage.Message)

describe("TaskToolMetadataRemediation", () => {
  it.effect("repairs running, completed, and error task tools without replacing unrelated structured fields", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_task_metadata_repair")
      yield* setupSession(sessionID)
      yield* insertAssistant(sessionID, [
        runningTool("call-running", { keep: "running", task: { sessionID: "msg_raw" } }),
        completedTool("call-completed", { keep: "completed" }),
        errorTool("call-error", { keep: "error" }),
      ])
      yield* insertLegacyTask(sessionID, "call-running", "running", { sessionId: "ses_child_running", toolcalls: 1 })
      yield* insertLegacyTask(sessionID, "call-completed", "completed", { sessionID: "ses_child_completed", calls: 2 })
      yield* insertLegacyTask(sessionID, "call-error", "error", { sessionID: "ses_child_error" })

      const result = yield* TaskToolMetadataRemediation.ensure({ sessionID })
      const message = yield* readAssistant(sessionID)

      expect(result).toMatchObject({ status: "completed", repaired: 3, already: 0, invalidCanonicalTaskMetadata: 1 })
      expect(taskStructured(message, "call-running")).toEqual({
        keep: "running",
        task: { sessionID: "ses_child_running", toolCalls: 1 },
      })
      expect(taskStructured(message, "call-completed")).toEqual({
        keep: "completed",
        task: { sessionID: "ses_child_completed", toolCalls: 2 },
      })
      expect(taskStructured(message, "call-error")).toEqual({ keep: "error", task: { sessionID: "ses_child_error" } })
      expect(yield* marker(sessionID)).toBeDefined()
    }),
  )

  it.effect("marks already-canonical rows complete and is idempotent", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_task_metadata_done")
      yield* setupSession(sessionID)
      yield* insertAssistant(sessionID, [runningTool("call-ready", { task: { sessionID: "ses_child_ready", toolCalls: 3 } })])

      const first = yield* TaskToolMetadataRemediation.ensure({ sessionID })
      const firstMarker = yield* marker(sessionID)
      const second = yield* TaskToolMetadataRemediation.ensure({ sessionID })
      const secondMarker = yield* marker(sessionID)

      expect(first).toMatchObject({ status: "completed", repaired: 0, already: 1 })
      expect(second).toMatchObject({ status: "already_completed", repaired: 0, already: 0 })
      expect(secondMarker).toEqual(firstMarker)
    }),
  )

  it.effect("skips non-task tools and still marks complete when no task repair is needed", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_task_metadata_non_task")
      yield* setupSession(sessionID)
      yield* insertAssistant(sessionID, [runningTool("call-bash", {}, "bash")])

      const result = yield* TaskToolMetadataRemediation.ensure({ sessionID })

      expect(result).toMatchObject({ status: "completed", repaired: 0, canonicalTaskTools: 0, skippedNonTaskTools: 1 })
      expect(yield* marker(sessionID)).toBeDefined()
    }),
  )

  it.effect("blocks marker when a missing canonical task has no legacy source", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_task_metadata_missing_source")
      yield* setupSession(sessionID)
      yield* insertAssistant(sessionID, [runningTool("call-missing")])

      const result = yield* TaskToolMetadataRemediation.ensure({ sessionID })

      expect(result).toMatchObject({ status: "retryable", repaired: 0, missingLegacySource: 1 })
      expect(result.reasons).toContain("missing_legacy_source")
      expect(yield* marker(sessionID)).toBeUndefined()
    }),
  )

  it.effect("blocks marker and updates nothing when canonical task call IDs are duplicated", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_task_metadata_duplicate_canonical")
      yield* setupSession(sessionID)
      yield* insertAssistant(sessionID, [runningTool("call-dupe"), completedTool("call-dupe")])
      yield* insertLegacyTask(sessionID, "call-dupe", "running", { sessionID: "ses_child_dupe" })

      const result = yield* TaskToolMetadataRemediation.ensure({ sessionID })
      const message = yield* readAssistant(sessionID)

      expect(result).toMatchObject({ status: "retryable", repaired: 0, duplicateCanonicalTaskCallIDs: 1 })
      expect(taskStructured(message, "call-dupe")).toEqual({})
      expect(yield* marker(sessionID)).toBeUndefined()
    }),
  )

  it.effect("blocks marker and updates nothing when duplicate legacy sources match a call ID", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_task_metadata_duplicate_legacy")
      yield* setupSession(sessionID)
      yield* insertAssistant(sessionID, [runningTool("call-dupe")])
      yield* insertLegacyTask(sessionID, "call-dupe", "running", { sessionID: "ses_child_one" }, "prt_legacy_one")
      yield* insertLegacyTask(sessionID, "call-dupe", "completed", { sessionID: "ses_child_two" }, "prt_legacy_two")

      const result = yield* TaskToolMetadataRemediation.ensure({ sessionID })
      const message = yield* readAssistant(sessionID)

      expect(result).toMatchObject({ status: "retryable", repaired: 0, duplicateLegacySources: 1 })
      expect(taskStructured(message, "call-dupe")).toEqual({})
      expect(yield* marker(sessionID)).toBeUndefined()
    }),
  )

  it.effect("blocks marker on invalid legacy metadata and ignores top-level part metadata", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_task_metadata_invalid_legacy")
      yield* setupSession(sessionID)
      yield* insertAssistant(sessionID, [runningTool("call-invalid")])
      yield* insertLegacyTask(sessionID, "call-invalid", "completed", { model: "raw" }, "prt_invalid", {
        sessionID: "ses_top_level_must_not_leak",
        jobId: "job_raw",
      })

      const result = yield* TaskToolMetadataRemediation.ensure({ sessionID })
      const message = yield* readAssistant(sessionID)

      expect(result).toMatchObject({ status: "retryable", repaired: 0, invalidLegacyMetadata: 1 })
      expect(taskStructured(message, "call-invalid")).toEqual({})
      expect(JSON.stringify(message)).not.toContain("ses_top_level_must_not_leak")
      expect(JSON.stringify(message)).not.toContain("job_raw")
      expect(yield* marker(sessionID)).toBeUndefined()
    }),
  )
})

function setupSession(sessionID: SessionV2.ID) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({ id: sessionID, project_id: Project.ID.global, slug: sessionID, directory: "/project", title: sessionID, version: "test" })
      .run()
      .pipe(Effect.orDie)
  })
}

function insertAssistant(sessionID: SessionV2.ID, content: SessionMessage.AssistantContent[]) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const messageID = SessionMessage.ID.make(`msg_${sessionID}_assistant`)
    const message = new SessionMessage.Assistant({
      id: messageID,
      type: "assistant",
      agent: "build",
      model,
      content,
      time: { created },
    })
    const encoded = encodeMessage(message)
    const { id: _, type, ...data } = encoded
    yield* db
      .insert(SessionMessageTable)
      .values({ id: messageID, session_id: sessionID, type, seq: 1, time_created: 1, time_updated: 1, data })
      .run()
      .pipe(Effect.orDie)
  })
}

function insertLegacyTask(
  sessionID: SessionV2.ID,
  callID: string,
  status: "running" | "completed" | "error",
  metadata: Record<string, unknown> | undefined,
  partID = `prt_${callID.replace(/[^A-Za-z0-9_]/g, "_")}`,
  topLevelMetadata?: Record<string, unknown>,
) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const messageID = MessageID.make(`msg_${partID}`)
    yield* db
      .insert(MessageTable)
      .values({
        id: messageID,
        session_id: sessionID,
        time_created: 1,
        time_updated: 1,
        data: { role: "assistant", time: { created: 1 } } as (typeof MessageTable.$inferInsert)["data"],
      })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(PartTable)
      .values({
        id: PartID.make(partID),
        message_id: messageID,
        session_id: sessionID,
        time_created: 1,
        time_updated: 1,
        data: legacyTaskData(callID, status, metadata, topLevelMetadata),
      })
      .run()
      .pipe(Effect.orDie)
  })
}

function legacyTaskData(
  callID: string,
  status: "running" | "completed" | "error",
  metadata: Record<string, unknown> | undefined,
  topLevelMetadata?: Record<string, unknown>,
): (typeof PartTable.$inferInsert)["data"] {
  const state =
    status === "running"
      ? { status, input: {}, time: { start: 1 }, metadata }
      : status === "completed"
        ? { status, input: {}, output: "", title: "task", time: { start: 1, end: 2 }, metadata }
        : { status, input: {}, error: "failed", time: { start: 1, end: 2 }, metadata }
  return { type: "tool", callID, tool: "task", state, metadata: topLevelMetadata } as (typeof PartTable.$inferInsert)["data"]
}

function runningTool(id: string, structured: Record<string, unknown> = {}, name = "task") {
  return new SessionMessage.AssistantTool({
    type: "tool",
    id,
    name,
    time: { created },
    state: new SessionMessage.ToolStateRunning({ status: "running", input: {}, structured, content: [] }),
  })
}

function completedTool(id: string, structured: Record<string, unknown> = {}, name = "task") {
  return new SessionMessage.AssistantTool({
    type: "tool",
    id,
    name,
    time: { created, completed },
    state: new SessionMessage.ToolStateCompleted({ status: "completed", input: {}, structured, content: [] }),
  })
}

function errorTool(id: string, structured: Record<string, unknown> = {}, name = "task") {
  return new SessionMessage.AssistantTool({
    type: "tool",
    id,
    name,
    time: { created, completed },
    state: new SessionMessage.ToolStateError({
      status: "error",
      input: {},
      structured,
      content: [],
      error: { type: "unknown", message: "failed" },
    }),
  })
}

function readAssistant(sessionID: SessionV2.ID) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const row = yield* db
      .select()
      .from(SessionMessageTable)
      .where(eq(SessionMessageTable.session_id, sessionID))
      .get()
      .pipe(Effect.orDie)
    if (!row) return yield* Effect.die("missing assistant")
    const message = decodeMessage({ ...row.data, id: row.id, type: row.type })
    if (message.type !== "assistant") return yield* Effect.die("expected assistant")
    return message
  })
}

function taskStructured(message: SessionMessage.Assistant, callID: string) {
  const tool = message.content.find((item) => item.type === "tool" && item.id === callID)
  if (!tool || tool.type !== "tool" || tool.state.status === "pending") throw new Error(`missing tool ${callID}`)
  return tool.state.structured
}

function marker(sessionID: SessionV2.ID) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    return yield* db
      .select()
      .from(DataMigrationTable)
      .where(eq(DataMigrationTable.name, `legacy-session-message-backfill/v3/task-tool-metadata/${sessionID}`))
      .get()
      .pipe(Effect.orDie)
  })
}
