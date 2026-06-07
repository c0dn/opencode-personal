import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { Connection } from "../../src/server/ws/connection"
import { WsMultiplex } from "../../src/server/ws/multiplex"

/**
 * Creates a lightweight mock Connection for multiplex testing.
 */
function createMockConnection(): Connection {
  const idempotencyCache = new Map<string, unknown>()
  const pushed: unknown[] = []

  return {
    push: (message: unknown) =>
      Effect.sync(() => {
        pushed.push(message)
      }),
    close: (_code?: number, _reason?: string) => Effect.void,
    isOpen: Effect.succeed(true),
    idempotentGet: (id: string) => idempotencyCache.get(id),
    idempotentSet: (id: string, response: unknown) => {
      idempotencyCache.set(id, response)
    },
    subscribed: new Set(),
  }
}

// Clear registered handlers between tests to avoid cross-test pollution
afterEach(() => {
  // The multiplex module uses a module-level Map for handlers.
  // We can't easily clear it without exporting a reset function.
  // Instead, we rely on the fact that tests register unique types
  // and the dispatch table is additive.
})

describe("WsMultiplex", () => {
  describe("handler registration and dispatch", () => {
    test("dispatches to a registered handler", () =>
      Effect.gen(function* () {
        const conn = createMockConnection()

        WsMultiplex.register("test.echo", (msg) =>
          Effect.succeed({ echoed: msg.data }),
        )

        const result = yield* WsMultiplex.dispatch(
          { type: "test.echo", requestID: "req-1", data: "hello" },
          conn,
        )

        expect(result).toEqual({
          type: "response",
          requestID: "req-1",
          ok: true,
          data: { echoed: "hello" },
        })
      }).pipe(Effect.runPromise) as any)

    test("handler receives full message object", () =>
      Effect.gen(function* () {
        const conn = createMockConnection()

        WsMultiplex.register("test.fullmsg", (msg) =>
          Effect.succeed({ receivedType: msg.type, gotExtra: msg.extra }),
        )

        const result = yield* WsMultiplex.dispatch(
          { type: "test.fullmsg", requestID: "req-2", extra: "bonus" },
          conn,
        )

        expect(result).toEqual({
          type: "response",
          requestID: "req-2",
          ok: true,
          data: { receivedType: "test.fullmsg", gotExtra: "bonus" },
        })
      }).pipe(Effect.runPromise) as any)
  })

  describe("unknown type", () => {
    test("returns UNKNOWN_TYPE error for unregistered message type", () =>
      Effect.gen(function* () {
        const conn = createMockConnection()

        const result = yield* WsMultiplex.dispatch(
          { type: "nonexistent.type", requestID: "req-3" },
          conn,
        )

        expect(result).toEqual({
          type: "response",
          requestID: "req-3",
          ok: false,
          error: {
            code: "UNKNOWN_TYPE",
            message: "No handler for message type: nonexistent.type",
          },
        })
      }).pipe(Effect.runPromise) as any)

    test("returns UNKNOWN_TYPE for missing type field", () =>
      Effect.gen(function* () {
        const conn = createMockConnection()

        const result = yield* WsMultiplex.dispatch(
          { requestID: "req-4" },
          conn,
        )

        expect(result).toEqual({
          type: "response",
          requestID: "req-4",
          ok: false,
          error: {
            code: "UNKNOWN_TYPE",
            message: "No handler for message type: missing",
          },
        })
      }).pipe(Effect.runPromise) as any)
  })

  describe("idempotency", () => {
    test("duplicate idempotencyID returns cached response", () =>
      Effect.gen(function* () {
        const conn = createMockConnection()
        let callCount = 0

        WsMultiplex.register("test.counter", (_msg) => {
          callCount++
          return Effect.succeed({ count: callCount })
        })

        // First request
        const first = yield* WsMultiplex.dispatch(
          { type: "test.counter", requestID: "req-5", idempotencyID: "idem-1" },
          conn,
        )
        expect(first).toEqual({
          type: "response",
          requestID: "req-5",
          ok: true,
          data: { count: 1 },
        })
        expect(callCount).toBe(1)

        // Second request with same idempotencyID — should return cached
        const second = yield* WsMultiplex.dispatch(
          { type: "test.counter", requestID: "req-6", idempotencyID: "idem-1" },
          conn,
        )
        expect(second).toEqual({
          type: "response",
          requestID: "req-5", // original requestID from cached response
          ok: true,
          data: { count: 1 },
        })
        expect(callCount).toBe(1) // Not called again
      }).pipe(Effect.runPromise) as any)

    test("different idempotencyIDs produce separate calls", () =>
      Effect.gen(function* () {
        const conn = createMockConnection()
        let callCount = 0

        WsMultiplex.register("test.separate", (_msg) => {
          callCount++
          return Effect.succeed({ call: callCount })
        })

        const first = yield* WsMultiplex.dispatch(
          { type: "test.separate", requestID: "req-a", idempotencyID: "idem-a" },
          conn,
        )
        const second = yield* WsMultiplex.dispatch(
          { type: "test.separate", requestID: "req-b", idempotencyID: "idem-b" },
          conn,
        )

        expect(callCount).toBe(2)
        expect((first as any).data.call).toBe(1)
        expect((second as any).data.call).toBe(2)
      }).pipe(Effect.runPromise) as any)

    test("UNKNOWN_TYPE errors are also cached for idempotency", () =>
      Effect.gen(function* () {
        const conn = createMockConnection()

        // First call to unknown type
        const first = yield* WsMultiplex.dispatch(
          { type: "still.missing", requestID: "req-c", idempotencyID: "idem-c" },
          conn,
        )

        // Second call should return cached error
        const second = yield* WsMultiplex.dispatch(
          { type: "still.missing", requestID: "req-d", idempotencyID: "idem-c" },
          conn,
        )

        expect(first).toEqual(second)
        expect((first as any).error.code).toBe("UNKNOWN_TYPE")
      }).pipe(Effect.runPromise) as any)
  })

  describe("error handling", () => {
    test("Effect.fail in handler produces INTERNAL_ERROR (not caught by JS try/catch)", () =>
      Effect.gen(function* () {
        const conn = createMockConnection()

        WsMultiplex.register("test.fail", (_msg) =>
          Effect.fail(new Error("boom!")),
        )

        const result = yield* WsMultiplex.dispatch(
          { type: "test.fail", requestID: "req-fail" },
          conn,
        )

        // The inner try/catch in dispatch() cannot catch Effect failures —
        // they propagate through the Effect runtime. The outer .pipe(Effect.catch(...))
        // converts them to INTERNAL_ERROR.
        expect(result).toEqual({
          type: "response",
          requestID: "req-fail",
          ok: false,
          error: { code: "INTERNAL_ERROR", message: "Handler failed" },
        })
      }).pipe(Effect.runPromise) as any)

    test("synchronous throw in handler produces HANDLER_ERROR", () =>
      Effect.gen(function* () {
        const conn = createMockConnection()

        WsMultiplex.register("test.sync-throw", (_msg) => {
          throw new Error("sync boom!")
        })

        const result = yield* WsMultiplex.dispatch(
          { type: "test.sync-throw", requestID: "req-sync" },
          conn,
        )

        // Synchronous JS throws ARE caught by the inner try/catch
        expect(result).toEqual({
          type: "response",
          requestID: "req-sync",
          ok: false,
          error: { code: "HANDLER_ERROR", message: "sync boom!" },
        })
      }).pipe(Effect.runPromise) as any)

    test("Effect.fail errors are NOT idempotently cached (outer catch runs first)", () =>
      Effect.gen(function* () {
        const conn = createMockConnection()
        let calls = 0

        WsMultiplex.register("test.fail-cache", (_msg) => {
          calls++
          return Effect.fail(new Error(`fail ${calls}`))
        })

        yield* WsMultiplex.dispatch(
          { type: "test.fail-cache", requestID: "req-f1", idempotencyID: "idem-fail" },
          conn,
        )

        yield* WsMultiplex.dispatch(
          { type: "test.fail-cache", requestID: "req-f2", idempotencyID: "idem-fail" },
          conn,
        )

        // The outer Effect.catch catches the failure after the gen completes,
        // so the idempotentSet inside the try block never runs.
        // The handler is called twice because no response was cached.
        expect(calls).toBe(2)
      }).pipe(Effect.runPromise) as any)
  })

  describe("fire-and-forget", () => {
    test("handler returning undefined yields no response", () =>
      Effect.gen(function* () {
        const conn = createMockConnection()

        WsMultiplex.register("test.void", (_msg) => Effect.void)

        const result = yield* WsMultiplex.dispatch(
          { type: "test.void", requestID: "req-void" },
          conn,
        )

        expect(result).toBeUndefined()
      }).pipe(Effect.runPromise) as any)
  })

  describe("requestID handling", () => {
    test("defaults to 'unknown' when requestID is missing", () =>
      Effect.gen(function* () {
        const conn = createMockConnection()

        WsMultiplex.register("test.noid", (msg) =>
          Effect.succeed({ got: msg.x }),
        )

        const result = yield* WsMultiplex.dispatch(
          { type: "test.noid", x: 42 },
          conn,
        )

        expect((result as any).requestID).toBe("unknown")
      }).pipe(Effect.runPromise) as any)
  })

  describe("re-registration", () => {
    test("re-registering a handler overwrites the previous one", () =>
      Effect.gen(function* () {
        const conn = createMockConnection()

        WsMultiplex.register("test.overwrite", (_msg) =>
          Effect.succeed({ version: 1 }),
        )
        WsMultiplex.register("test.overwrite", (_msg) =>
          Effect.succeed({ version: 2 }),
        )

        const result = yield* WsMultiplex.dispatch(
          { type: "test.overwrite", requestID: "req-ov" },
          conn,
        )

        expect(result).toEqual({
          type: "response",
          requestID: "req-ov",
          ok: true,
          data: { version: 2 },
        })
      }).pipe(Effect.runPromise) as any)
  })
})
