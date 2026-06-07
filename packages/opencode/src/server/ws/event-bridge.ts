import { Effect, Scope } from "effect"
import { EventV2 } from "@opencode-ai/core/event"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import type { Connection } from "./connection"

const BATCH_INTERVAL_MS = 16

/**
 * Wire EventV2 events to a WS connection as push.event frames.
 * Returns a scoped effect that manages the subscription lifecycle.
 */
export function bridge(conn: Connection, scope: Scope.Scope) {
  return Effect.gen(function* () {
    const events = yield* EventV2.Service

    const unsubscribe = yield* events.listen((event) =>
      Effect.gen(function* () {
        const payload = EventV2.encodeKnownPayloadForFanout(event)
        if (!payload) return

        const ctx = yield* InstanceRef
        const workspaceID = (yield* WorkspaceRef) ?? event.location?.workspaceID

        yield* conn.push({
          type: "push.event",
          directory: event.location?.directory ?? ctx?.directory,
          project: ctx?.project.id,
          workspace: workspaceID,
          payload: { id: payload.id, type: payload.type, properties: payload.data },
        }).pipe(Effect.catch(() => Effect.void))
      }).pipe(Effect.catch(() => Effect.void)),
    )

    // Clean up subscription when scope closes
    yield* Scope.addFinalizer(scope, unsubscribe)

    yield* Effect.logInfo("WS event bridge started")
  })
}

export * as WsEventBridge from "./event-bridge"
