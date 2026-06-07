import { Effect, Scope } from "effect"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import type { Connection } from "./connection"

/**
 * Wire GlobalBus events to a WS connection as batched push.batch / push.event frames.
 * Events accumulate synchronously in a native array and are drained every 16ms
 * via setTimeout — avoiding O(N²) Ref array copying and per-event fiber overhead.
 *
 * When the connection has active subscriptions, only events for subscribed sessions
 * (or global events with no sessionID) are pushed.
 */
export function bridge(conn: Connection, scope: Scope.Scope) {
  return Effect.gen(function* () {
    const BATCH_MS = 16
    let pending: GlobalEvent[] = []
    let flushTimer: ReturnType<typeof setTimeout> | undefined

    function isSubscribed(event: GlobalEvent): boolean {
      if (conn.subscribed.size === 0) return true
      const props = event.payload?.properties as Record<string, unknown> | undefined
      const sessionID = props?.sessionID as string | undefined
      if (sessionID === undefined) return true
      return conn.subscribed.has(sessionID)
    }

    function flush() {
      const batch = pending
      pending = []
      flushTimer = undefined
      if (batch.length === 0) return

      const payload = batch.length === 1
        ? { type: "push.event", ...batch[0] }
        : { type: "push.batch", events: batch }

      Effect.runPromise(conn.push(payload)).catch(() => {})
    }

    // Listener runs in native EventEmitter context on the main thread.
    // Synchronous array push is O(1) and safe because Node.js is single-threaded.
    const listener = (event: GlobalEvent) => {
      if (!isSubscribed(event)) return
      pending.push(event)
      if (!flushTimer) flushTimer = setTimeout(flush, BATCH_MS)
    }

    GlobalBus.on("event", listener)

    // Clean up on scope close: remove listener and cancel pending timer
    yield* Scope.addFinalizer(scope, Effect.sync(() => {
      GlobalBus.off("event", listener)
      if (flushTimer) clearTimeout(flushTimer)
    }))

    yield* Effect.logInfo("WS event bridge started")
  })
}

export * as WsEventBridge from "./event-bridge"
