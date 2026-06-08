import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Exit, Scope } from "effect"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import type { Connection } from "../../src/server/ws/connection"
import { WsEventBridge } from "../../src/server/ws/event-bridge"

const run = (effect: Effect.Effect<any, any, any>) => Effect.runPromise(effect as any)

/**
 * Creates a mock Connection that captures push calls in a shared array.
 * `subscribed` is a mutable Set that the bridge reads synchronously,
 * so we can manipulate it between emits.
 */
function createMockConnection(): {
  conn: Connection
  frames: Array<Record<string, unknown>>
} {
  const frames: Array<Record<string, unknown>> = []
  const conn: Connection = {
    push: (message: unknown) =>
      Effect.sync(() => {
        frames.push(message as Record<string, unknown>)
      }),
    close: () => Effect.void,
    isOpen: Effect.succeed(true),
    idempotentGet: () => undefined,
    idempotentSet: () => {},
    subscribed: new Set(),
  }
  return { conn, frames }
}

/** Helper: build a GlobalEvent with a sessionID property. */
function sessionEvent(sessionID: string): GlobalEvent {
  return {
    directory: "/test",
    payload: {
      id: "evt-test-" + sessionID,
      type: "session.updated",
      properties: { sessionID },
    },
  }
}

/** Helper: build a GlobalEvent without a sessionID (global event). */
function globalEvent(type: string = "workspace.updated"): GlobalEvent {
  return {
    directory: "/test",
    payload: {
      id: "evt-global-" + type,
      type,
      properties: {},
    },
  }
}

/**
 * Wait long enough for the 16ms setTimeout flush in bridge() to fire.
 * Uses a raw Promise+setTimeout so it works outside Effect time.
 */
function waitForFlush(ms: number = 50): Effect.Effect<void> {
  return Effect.promise(() => new Promise((resolve) => setTimeout(resolve, ms)))
}

// Clean up any lingering GlobalBus listeners between test groups.
// bridge() registers on "event" and removes via Scope finalizer, but
// if a test crashes before scope closes, we need a safety net.
afterEach(() => {
  GlobalBus.removeAllListeners("event")
})

describe("WsEventBridge.bridge()", () => {
  describe("subscription filtering", () => {
    test("empty subscribed set — all session events are forwarded", () =>
      Effect.gen(function* () {
        const { conn, frames } = createMockConnection()
        // subscribed is empty by default
        const scope = yield* Scope.make()

        yield* WsEventBridge.bridge(conn, scope)

        GlobalBus.emit("event", sessionEvent("session-a"))
        yield* waitForFlush()

        expect(frames.length).toBeGreaterThan(0)
        const frame = frames[0]
        expect(frame.type).toBe("push.event")
        yield* Scope.close(scope, Exit.void)
      }).pipe(run))

    test("empty subscribed set — global events are forwarded", () =>
      Effect.gen(function* () {
        const { conn, frames } = createMockConnection()
        const scope = yield* Scope.make()

        yield* WsEventBridge.bridge(conn, scope)

        GlobalBus.emit("event", globalEvent())
        yield* waitForFlush()

        expect(frames.length).toBe(1)
        expect(frames[0].type).toBe("push.event")
        yield* Scope.close(scope, Exit.void)
      }).pipe(run))

    test("non-empty subscribed set — matching session event is forwarded", () =>
      Effect.gen(function* () {
        const { conn, frames } = createMockConnection()
        conn.subscribed.add("session-a")
        conn.subscribed.add("session-b")
        const scope = yield* Scope.make()

        yield* WsEventBridge.bridge(conn, scope)

        GlobalBus.emit("event", sessionEvent("session-a"))
        yield* waitForFlush()

        expect(frames.length).toBe(1)
        expect(frames[0].type).toBe("push.event")
        expect((frames[0].payload as any).properties.sessionID).toBe("session-a")
        yield* Scope.close(scope, Exit.void)
      }).pipe(run))

    test("non-empty subscribed set — global/no-session event is always forwarded", () =>
      Effect.gen(function* () {
        const { conn, frames } = createMockConnection()
        conn.subscribed.add("session-a")
        const scope = yield* Scope.make()

        yield* WsEventBridge.bridge(conn, scope)

        GlobalBus.emit("event", globalEvent("tool.installed"))
        yield* waitForFlush()

        expect(frames.length).toBe(1)
        expect(frames[0].type).toBe("push.event")
        expect((frames[0].payload as any).type).toBe("tool.installed")
        yield* Scope.close(scope, Exit.void)
      }).pipe(run))

    test("non-matching session event is filtered out", () =>
      Effect.gen(function* () {
        const { conn, frames } = createMockConnection()
        conn.subscribed.add("session-a")
        conn.subscribed.add("session-b")
        const scope = yield* Scope.make()

        yield* WsEventBridge.bridge(conn, scope)

        // Emit an event for a session the connection is NOT subscribed to
        GlobalBus.emit("event", sessionEvent("session-c"))
        yield* waitForFlush()

        // Should not have been forwarded
        expect(frames.length).toBe(0)
        yield* Scope.close(scope, Exit.void)
      }).pipe(run))

    test("mixed events — only matching and global are forwarded", () =>
      Effect.gen(function* () {
        const { conn, frames } = createMockConnection()
        conn.subscribed.add("session-a")
        const scope = yield* Scope.make()

        yield* WsEventBridge.bridge(conn, scope)

        GlobalBus.emit("event", sessionEvent("session-a")) // matching
        GlobalBus.emit("event", sessionEvent("session-b")) // non-matching
        GlobalBus.emit("event", globalEvent("some.global")) // global, always
        yield* waitForFlush()

        // Should have pushed a batch with exactly 2 events
        expect(frames.length).toBe(1)
        const batch = frames[0]
        expect(batch.type).toBe("push.batch")
        const events = batch.events as GlobalEvent[]
        expect(events.length).toBe(2)

        // Verify the two forwarded events are the matching and global ones
        const types = events.map((e) => (e.payload.properties as Record<string, unknown>).sessionID ?? "global")
        expect(types).toContain("session-a")
        expect(types).toContain("global")
        yield* Scope.close(scope, Exit.void)
      }).pipe(run))
  })

  describe("batching", () => {
    test("multiple events in one 16ms window → single push.batch", () =>
      Effect.gen(function* () {
        const { conn, frames } = createMockConnection()
        const scope = yield* Scope.make()

        yield* WsEventBridge.bridge(conn, scope)

        // Emit several events synchronously before the setTimeout fires
        GlobalBus.emit("event", sessionEvent("session-a"))
        GlobalBus.emit("event", sessionEvent("session-b"))
        GlobalBus.emit("event", globalEvent("config.changed"))
        yield* waitForFlush()

        expect(frames.length).toBe(1)
        const batch = frames[0]
        expect(batch.type).toBe("push.batch")
        expect(batch.events).toBeArray()
        expect((batch.events as any[]).length).toBe(3)
        yield* Scope.close(scope, Exit.void)
      }).pipe(run))

    test("single event after a flush → push.event", () =>
      Effect.gen(function* () {
        const { conn, frames } = createMockConnection()
        const scope = yield* Scope.make()

        yield* WsEventBridge.bridge(conn, scope)

        // First batch: emit and wait
        GlobalBus.emit("event", sessionEvent("session-a"))
        yield* waitForFlush()

        // Second batch: single event after flush
        GlobalBus.emit("event", sessionEvent("session-b"))
        yield* waitForFlush()

        expect(frames.length).toBe(2)
        expect(frames[0].type).toBe("push.event")
        expect(frames[1].type).toBe("push.event")
        // Verify the payloads carry the right sessionIDs
        expect((frames[0].payload as any).properties.sessionID).toBe("session-a")
        expect((frames[1].payload as any).properties.sessionID).toBe("session-b")
        yield* Scope.close(scope, Exit.void)
      }).pipe(run))

    test("events within the same tick are batched together", () =>
      Effect.gen(function* () {
        const { conn, frames } = createMockConnection()
        const scope = yield* Scope.make()

        yield* WsEventBridge.bridge(conn, scope)

        // Emit many events synchronously
        for (let i = 0; i < 5; i++) {
          GlobalBus.emit("event", sessionEvent("session-" + i))
        }
        yield* waitForFlush()

        expect(frames.length).toBe(1)
        expect(frames[0].type).toBe("push.batch")
        expect((frames[0].events as any[]).length).toBe(5)
        yield* Scope.close(scope, Exit.void)
      }).pipe(run))
  })

  describe("cleanup", () => {
    test("scope close removes the GlobalBus listener", () =>
      Effect.gen(function* () {
        const { conn, frames } = createMockConnection()
        const scope = yield* Scope.make()

        yield* WsEventBridge.bridge(conn, scope)

        // Verify listener is active
        GlobalBus.emit("event", sessionEvent("session-a"))
        yield* waitForFlush()
        expect(frames.length).toBe(1)

        // Close scope (removes listener)
        yield* Scope.close(scope, Exit.void)
        // Wait for the scope finalizer to execute
        yield* Effect.sleep(10)

        // After close, emit another event — should not be forwarded
        const framesBefore = frames.length
        GlobalBus.emit("event", sessionEvent("session-b"))
        yield* waitForFlush()

        expect(frames.length).toBe(framesBefore)
      }).pipe(run))

    test("scope close cancels pending flush timer", () =>
      Effect.gen(function* () {
        const { conn, frames } = createMockConnection()
        const scope = yield* Scope.make()

        yield* WsEventBridge.bridge(conn, scope)

        // Emit an event to start the 16ms timer, but close scope before it fires
        GlobalBus.emit("event", sessionEvent("session-a"))

        // Close scope immediately — should cancel the pending timer
        yield* Scope.close(scope, Exit.void)
        yield* Effect.sleep(10)

        // Wait past the 16ms window
        yield* Effect.sleep(30)

        // The event should not have been flushed because the timer was canceled
        expect(frames.length).toBe(0)
      }).pipe(run))
  })
})
