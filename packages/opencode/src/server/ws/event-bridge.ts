import { Effect, Ref, Scope } from "effect"
import { EventV2 } from "@opencode-ai/core/event"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import type { Connection } from "./connection"

interface BatchedEvent {
  directory?: string
  project?: string
  workspace?: string
  payload: { id: string; type: string; properties: Record<string, unknown> }
}

interface MetaPatch {
  sessionID: string
  deleted?: boolean
  status?: Record<string, unknown>
  title?: string
  time?: { created: number; updated: number; archived?: number }
  preview?: string
  messageCount?: number
  model?: string
  agent?: string
}

const META_EVENT_TYPES = new Set(["session.created", "session.updated", "session.deleted", "session.status"])

function extractMetaPatch(eventType: string, data: Record<string, unknown>): MetaPatch | undefined {
  const sessionID = (data.sessionID as string) ?? (data.info as Record<string, unknown> | undefined)?.id as string
  if (!sessionID) return undefined
  const info = data.info as Record<string, unknown> | undefined
  const patch: MetaPatch = { sessionID }
  if (eventType === "session.deleted" || (info?.time as Record<string, unknown> | undefined)?.archived !== undefined) {
    patch.deleted = true
  }
  const status = data.status as Record<string, unknown> | undefined
  if (status) {
    patch.status = status
  }
  if (info) {
    const title = info.title as string | undefined
    if (title) patch.title = title
    const time = info.time as { created: number; updated: number; archived?: number } | undefined
    if (time) patch.time = time
    const model = info.model as string | undefined
    if (model) patch.model = model
    const agent = info.agent as string | undefined
    if (agent) patch.agent = agent
  }
  return patch
}

/**
 * Wire EventV2 events to a WS connection as batched push.batch or push.event frames.
 * Accumulates events and flushes them every 16ms instead of pushing each event individually.
 * Simultaneously accumulates session metadata patches and flushes them as push.meta frames.
 * Returns a scoped effect that manages the subscription and flusher lifecycle.
 */
export function bridge(conn: Connection, scope: Scope.Scope) {
  return Effect.gen(function* () {
    const events = yield* EventV2.Service
    const batch = yield* Ref.make<BatchedEvent[]>([])
    const metas = yield* Ref.make<MetaPatch[]>([])

    const unsubscribe = yield* events.listen((event) =>
      Effect.gen(function* () {
        const payload = EventV2.encodeKnownPayloadForFanout(event)
        if (!payload) return
        const ctx = yield* InstanceRef
        const workspaceID = (yield* WorkspaceRef) ?? event.location?.workspaceID
        yield* Ref.update(batch, (arr) => [
          ...arr,
          {
            directory: event.location?.directory ?? ctx?.directory,
            project: ctx?.project.id,
            workspace: workspaceID,
            payload: { id: payload.id, type: payload.type, properties: payload.data },
          },
        ])
        if (META_EVENT_TYPES.has(payload.type)) {
          const patch = extractMetaPatch(payload.type, payload.data)
          if (patch) {
            yield* Ref.update(metas, (arr) => [...arr.filter((m) => m.sessionID !== patch.sessionID), patch])
          }
        }
      }).pipe(Effect.catch(() => Effect.void)),
    )

    // Flusher: drain batch and metas every 16ms
    yield* Effect.forkIn(
      Effect.gen(function* () {
        while (true) {
          yield* Effect.sleep(16)
          const items = yield* Ref.getAndSet(batch, [])
          if (items.length > 0) {
            if (items.length === 1) {
              yield* conn.push({ type: "push.event", ...items[0] }).pipe(Effect.catch(() => Effect.void))
            } else {
              yield* conn.push({ type: "push.batch", events: items }).pipe(Effect.catch(() => Effect.void))
            }
          }
          const metaItems = yield* Ref.getAndSet(metas, [])
          if (metaItems.length > 0) {
            yield* conn
              .push({
                type: "push.meta",
                sessions: Object.fromEntries(metaItems.map((m) => [m.sessionID, m])),
              })
              .pipe(Effect.catch(() => Effect.void))
          }
        }
      }),
      scope,
    )

    yield* Scope.addFinalizer(scope, unsubscribe)
    yield* Effect.logInfo("WS event bridge started")
  })
}

export * as WsEventBridge from "./event-bridge"
