import { Effect, Queue, Ref, Scope } from "effect"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import type { Connection } from "./connection"

/**
 * Wire GlobalBus events to a WS connection as batched push.batch / push.event frames.
 * Events are accumulated and flushed every 16ms.
 * When the connection has active subscriptions, only events for subscribed sessions
 * (or global events with no sessionID) are pushed.
 * Returns a scoped effect that manages the subscription lifecycle.
 */
export function bridge(conn: Connection, scope: Scope.Scope) {
  return Effect.gen(function* () {
    const batch = yield* Ref.make<GlobalEvent[]>([])

    function isSubscribed(event: GlobalEvent): boolean {
      if (conn.subscribed.size === 0) return true
      const props = event.payload?.properties as Record<string, unknown> | undefined
      const sessionID = props?.sessionID as string | undefined
      if (sessionID === undefined) return true
      return conn.subscribed.has(sessionID)
    }

    const listener = (event: GlobalEvent) => {
      if (!isSubscribed(event)) return
      // Fire-and-forget: append to batch outside Effect fiber
      Effect.runPromise(
        Ref.update(batch, (arr) => [...arr, event]),
      ).catch(() => {})
    }

    GlobalBus.on("event", listener)

    // Flusher: drain batch every 16ms
    yield* Effect.forkIn(
      Effect.gen(function* () {
        while (true) {
          yield* Effect.sleep(16)
          const items = yield* Ref.getAndSet(batch, [])
          if (items.length === 0) continue
          if (items.length === 1) {
            yield* conn.push({ type: "push.event", ...items[0] }).pipe(Effect.catch(() => Effect.void))
          } else {
            yield* conn.push({ type: "push.batch", events: items }).pipe(Effect.catch(() => Effect.void))
          }
        }
      }),
      scope,
    )

    yield* Scope.addFinalizer(scope, Effect.sync(() => {
      GlobalBus.off("event", listener)
    }))

    yield* Effect.logInfo("WS event bridge started")
  })
}

export * as WsEventBridge from "./event-bridge"
