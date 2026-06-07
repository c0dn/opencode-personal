export * as TaskToolMetadataRemediation from "./task-tool-metadata-remediation"

import { and, asc, eq } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { DataMigrationTable } from "../data-migration.sql"
import { Database } from "../database/database"
import { SessionSchema } from "./schema"
import { SessionMessage } from "./message"
import { MessageTable, PartTable, SessionMessageTable } from "./sql"
import { TaskToolMetadata } from "./task-tool-metadata"

export type Status = "already_completed" | "completed" | "retryable"

export type Result = {
  status: Status
  marker: string
  repaired: number
  already: number
  canonicalTaskTools: number
  skippedNonTaskTools: number
  missingLegacySource: number
  duplicateCanonicalTaskCallIDs: number
  duplicateLegacySources: number
  invalidLegacyMetadata: number
  malformedCanonicalRows: number
  malformedLegacySources: number
  invalidCanonicalTaskMetadata: number
  reasons: string[]
}

type CanonicalTaskTool = {
  row: typeof SessionMessageTable.$inferSelect
  message: SessionMessage.Assistant
  tool: SessionMessage.AssistantTool
  task: TaskToolMetadata.Metadata | undefined
  taskInvalid: boolean
}

type LegacyTaskSource = {
  partID: string
  callID: string
  metadata: TaskToolMetadata.Metadata | undefined
}
type StructuredToolState = Extract<SessionMessage.ToolState, { status: "running" | "completed" | "error" }>
type StructuredTaskTool = SessionMessage.AssistantTool & { state: StructuredToolState }
type LegacyTaskRows = { part: typeof PartTable.$inferSelect; message: typeof MessageTable.$inferSelect }[]

const decodeMessage = Schema.decodeUnknownSync(SessionMessage.Message)
const encodeMessage = Schema.encodeSync(SessionMessage.Message)

export const ensure = Effect.fn("Session.TaskToolMetadataRemediation.ensure")(function* (input: {
  sessionID: SessionSchema.ID
}) {
  const { db } = yield* Database.Service
  const marker = markerKey(input.sessionID)

  return yield* db.transaction(
    () =>
      Effect.gen(function* () {
        const marked = yield* db.select().from(DataMigrationTable).where(eq(DataMigrationTable.name, marker)).get()
        if (marked) return emptyResult("already_completed", marker)

        const canonicalRows = yield* db
          .select()
          .from(SessionMessageTable)
          .where(and(eq(SessionMessageTable.session_id, input.sessionID), eq(SessionMessageTable.type, "assistant")))
          .orderBy(asc(SessionMessageTable.seq))
          .all()
        const canonical = readCanonicalTasks(canonicalRows)
        const duplicateCanonicalTaskCallIDs = duplicateCount(canonical.tasks.map((task) => task.tool.id))
        const needed = canonical.tasks.filter((task) => task.task === undefined)
        const legacyRows = needed.length === 0 ? [] : yield* readLegacyTaskRows(input.sessionID)
        const legacy = readLegacySources(legacyRows)
        const relevantLegacy = legacy.sources.filter((source) => needed.some((task) => task.tool.id === source.callID))
        const duplicateLegacySources = duplicateCount(relevantLegacy.map((source) => source.callID))
        const missingLegacySource = needed.filter(
          (task) => relevantLegacy.filter((source) => source.callID === task.tool.id).length === 0,
        ).length
        const invalidLegacyMetadata = relevantLegacy.filter((source) => source.metadata === undefined).length
        const reasons = blockingReasons({
          malformedCanonicalRows: canonical.malformedRows,
          duplicateCanonicalTaskCallIDs,
          malformedLegacySources: legacy.malformedSources,
          duplicateLegacySources,
          missingLegacySource,
          invalidLegacyMetadata,
        })

        if (reasons.length > 0) {
          return {
            status: "retryable" as const,
            marker,
            repaired: 0,
            already: canonical.tasks.length - needed.length,
            canonicalTaskTools: canonical.tasks.length,
            skippedNonTaskTools: canonical.skippedNonTaskTools,
            missingLegacySource,
            duplicateCanonicalTaskCallIDs,
            duplicateLegacySources,
            invalidLegacyMetadata,
            malformedCanonicalRows: canonical.malformedRows,
            malformedLegacySources: legacy.malformedSources,
            invalidCanonicalTaskMetadata: canonical.tasks.filter((task) => task.taskInvalid).length,
            reasons,
          }
        }

        const repairs = needed.map((task) => {
          const source = relevantLegacy.find((source) => source.callID === task.tool.id)
          return { task, metadata: source?.metadata }
        })

        const repairGroups = new Map<string, { task: CanonicalTaskTool; metadata: TaskToolMetadata.Metadata }[]>()
        for (const repair of repairs) {
          if (!repair.metadata) continue
          const group = repairGroups.get(repair.task.row.id) ?? []
          group.push({ task: repair.task, metadata: repair.metadata })
          repairGroups.set(repair.task.row.id, group)
        }
        for (const group of repairGroups.values()) {
          yield* updateTaskTools(group)
        }

        yield* db.insert(DataMigrationTable).values({ name: marker, time_completed: Date.now() }).onConflictDoNothing().run()

        return {
          status: "completed" as const,
          marker,
          repaired: repairs.length,
          already: canonical.tasks.length - needed.length,
          canonicalTaskTools: canonical.tasks.length,
          skippedNonTaskTools: canonical.skippedNonTaskTools,
          missingLegacySource,
          duplicateCanonicalTaskCallIDs,
          duplicateLegacySources,
          invalidLegacyMetadata,
          malformedCanonicalRows: canonical.malformedRows,
          malformedLegacySources: legacy.malformedSources,
          invalidCanonicalTaskMetadata: canonical.tasks.filter((task) => task.taskInvalid).length,
          reasons: [],
        }
      }),
    { behavior: "immediate" },
  )
})

function markerKey(sessionID: SessionSchema.ID) {
  return `legacy-session-message-backfill/v3/task-tool-metadata/${sessionID}`
}

function emptyResult(status: Status, marker: string): Result {
  return {
    status,
    marker,
    repaired: 0,
    already: 0,
    canonicalTaskTools: 0,
    skippedNonTaskTools: 0,
    missingLegacySource: 0,
    duplicateCanonicalTaskCallIDs: 0,
    duplicateLegacySources: 0,
    invalidLegacyMetadata: 0,
    malformedCanonicalRows: 0,
    malformedLegacySources: 0,
    invalidCanonicalTaskMetadata: 0,
    reasons: [],
  }
}

function readCanonicalTasks(rows: (typeof SessionMessageTable.$inferSelect)[]) {
  const tasks: CanonicalTaskTool[] = []
  let malformedRows = 0
  let skippedNonTaskTools = 0

  for (const row of rows) {
    const message = decodeRow(row)
    if (!message) {
      malformedRows++
      continue
    }
    if (message.type !== "assistant") continue
    for (const item of message.content) {
      if (item.type !== "tool") continue
      if (!hasStructuredState(item)) continue
      if (item.name !== "task") {
        skippedNonTaskTools++
        continue
      }
      const task = canonicalTaskMetadata(item.state.structured.task)
      tasks.push({ row, message, tool: item, task: task.metadata, taskInvalid: task.invalid })
    }
  }

  return { tasks, malformedRows, skippedNonTaskTools }
}

function decodeRow(row: typeof SessionMessageTable.$inferSelect): SessionMessage.Message | undefined {
  try {
    return decodeMessage({ ...row.data, id: row.id, type: row.type })
  } catch {
    return undefined
  }
}

function canonicalTaskMetadata(input: unknown) {
  if (input === undefined) return { metadata: undefined, invalid: false }
  const metadata = TaskToolMetadata.sanitize(input)
  if (!metadata) return { metadata: undefined, invalid: true }
  if (!isCanonicalTaskMetadata(input, metadata)) return { metadata: undefined, invalid: true }
  return { metadata, invalid: false }
}

function isCanonicalTaskMetadata(input: unknown, metadata: TaskToolMetadata.Metadata) {
  if (!isRecord(input)) return false
  const keys = Object.keys(input)
  if (keys.some((key) => key !== "sessionID" && key !== "toolCalls")) return false
  if (input.sessionID !== metadata.sessionID) return false
  if (metadata.toolCalls === undefined) return input.toolCalls === undefined
  return input.toolCalls === metadata.toolCalls
}

function readLegacyTaskRows(sessionID: SessionSchema.ID) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    return yield* db
      .select()
      .from(PartTable)
      .innerJoin(MessageTable, eq(PartTable.message_id, MessageTable.id))
      .where(and(eq(PartTable.session_id, sessionID), eq(MessageTable.session_id, sessionID)))
      .orderBy(asc(PartTable.id))
      .all()
  })
}

function readLegacySources(rows: LegacyTaskRows) {
  const sources: LegacyTaskSource[] = []
  let malformedSources = 0

  for (const row of rows) {
    const part: unknown = row.part.data
    if (!isRecord(part)) {
      malformedSources++
      continue
    }
    if (part.type !== "tool" || part.tool !== "task") continue
    if (!isRecord(part.state)) {
      malformedSources++
      continue
    }
    if (!supportsStructured(part.state.status)) {
      if (typeof part.state.status !== "string") malformedSources++
      continue
    }
    if (typeof part.callID !== "string") {
      malformedSources++
      continue
    }
    sources.push({ partID: row.part.id, callID: part.callID, metadata: TaskToolMetadata.sanitize(part.state.metadata) })
  }

  return { sources, malformedSources }
}

function updateTaskTools(repairs: { task: CanonicalTaskTool; metadata: TaskToolMetadata.Metadata }[]) {
  const first = repairs[0]
  const nextMessage = new SessionMessage.Assistant({
    ...first.task.message,
    content: first.task.message.content.map((item) => {
      if (item.type !== "tool" || !hasStructuredState(item)) return item
      const repair = repairs.find((repair) => repair.task.tool === item)
      if (!repair) return item
      return taskToolWithMetadata(item, repair.metadata)
    }),
  })
  const encoded = encodeMessage(nextMessage)
  const { id: _, type, ...data } = encoded

  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .update(SessionMessageTable)
      .set({ type, data, time_created: first.task.row.time_created, time_updated: first.task.row.time_updated })
      .where(
        and(eq(SessionMessageTable.id, first.task.row.id), eq(SessionMessageTable.session_id, first.task.row.session_id)),
      )
      .run()
  })
}

function taskToolWithMetadata(tool: StructuredTaskTool, metadata: TaskToolMetadata.Metadata) {
  const structured = TaskToolMetadata.mergeIntoStructured(tool.state.structured, metadata)
  if (tool.state.status === "running") {
    const state = new SessionMessage.ToolStateRunning({ ...tool.state, structured })
    return new SessionMessage.AssistantTool({ ...tool, state })
  }
  if (tool.state.status === "completed") {
    const state = new SessionMessage.ToolStateCompleted({ ...tool.state, structured })
    return new SessionMessage.AssistantTool({ ...tool, state })
  }
  const state = new SessionMessage.ToolStateError({ ...tool.state, structured })
  return new SessionMessage.AssistantTool({ ...tool, state })
}

function supportsStructured(status: unknown): status is StructuredToolState["status"] {
  return status === "running" || status === "completed" || status === "error"
}

function hasStructuredState(tool: SessionMessage.AssistantTool): tool is StructuredTaskTool {
  return supportsStructured(tool.state.status)
}

function duplicateCount(values: string[]) {
  const counts = new Map<string, number>()
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return [...counts.values()].filter((count) => count > 1).length
}

function blockingReasons(input: {
  malformedCanonicalRows: number
  duplicateCanonicalTaskCallIDs: number
  malformedLegacySources: number
  duplicateLegacySources: number
  missingLegacySource: number
  invalidLegacyMetadata: number
}) {
  const reasons: string[] = []
  if (input.malformedCanonicalRows > 0) reasons.push("malformed_canonical_rows")
  if (input.duplicateCanonicalTaskCallIDs > 0) reasons.push("duplicate_canonical_task_call_ids")
  if (input.malformedLegacySources > 0) reasons.push("malformed_legacy_sources")
  if (input.duplicateLegacySources > 0) reasons.push("duplicate_legacy_sources")
  if (input.missingLegacySource > 0) reasons.push("missing_legacy_source")
  if (input.invalidLegacyMetadata > 0) reasons.push("invalid_legacy_metadata")
  return reasons
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
