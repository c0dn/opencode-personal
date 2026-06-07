import { Schema } from "effect"
import { SessionSchema } from "./schema"

export const Metadata = Schema.Struct({
  sessionID: SessionSchema.ID,
  toolCalls: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)).pipe(Schema.optional),
}).annotate({ identifier: "Session.TaskTool.Metadata" })
export type Metadata = typeof Metadata.Type

export function sanitize(input: unknown): Metadata | undefined {
  const direct = sanitizeRecord(input)
  if (direct) return direct
  if (!isRecord(input)) return undefined
  if (isRecord(input.task)) return sanitizeRecord(input.task)
  if (!isRecord(input.structured)) return undefined
  return sanitizeRecord(input.structured.task)
}

export function mergeIntoStructured(structured: Record<string, unknown>, input: unknown) {
  const task = sanitize(input)
  const { task: _, ...rest } = structured
  if (!task) return rest
  return { ...rest, task }
}

function sanitizeRecord(input: unknown): Metadata | undefined {
  if (!isRecord(input)) return undefined
  const sessionID = sessionIDValue(input)
  if (!sessionID) return undefined
  const toolCalls = toolCallsValue(input)
  return toolCalls === undefined ? { sessionID } : { sessionID, toolCalls }
}

function sessionIDValue(input: Record<string, unknown>) {
  const value = typeof input.sessionID === "string" ? input.sessionID : typeof input.sessionId === "string" ? input.sessionId : undefined
  if (!value) return undefined
  if (value.startsWith("msg_") || value.startsWith("prt_")) return undefined
  return Schema.is(SessionSchema.ID)(value) ? SessionSchema.ID.make(value) : undefined
}

function toolCallsValue(input: Record<string, unknown>) {
  const value = input.toolCalls ?? input.toolcalls ?? input.calls
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export * as TaskToolMetadata from "./task-tool-metadata"
