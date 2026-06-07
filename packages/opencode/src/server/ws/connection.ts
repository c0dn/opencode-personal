import { Effect, Queue, Ref, Scope } from "effect"
import * as Socket from "effect/unstable/socket/Socket"
import * as Protocol from "./protocol"
import { isProtocolError } from "./protocol"

/** Maximum outbound frames queued before backpressure triggers. */
export const OUTBOUND_QUEUE_CAPACITY = 256

/** How often the server sends a ping to keep the connection alive. */
export const PING_INTERVAL_MS = 15_000

export interface Connection {
  readonly push: (message: unknown) => Effect.Effect<void>
  readonly close: (code?: number, reason?: string) => Effect.Effect<void>
  readonly isOpen: Effect.Effect<boolean>
  /** Check/store idempotent request response. Returns cached response or undefined. */
  readonly idempotentGet: (id: string) => unknown | undefined
  readonly idempotentSet: (id: string, response: unknown) => void
  /** Sessions this connection is subscribed to for event pre-fetch. Empty set = receive all. */
  readonly subscribed: Set<string>
}

interface ConnectionState {
  closed: boolean
}

const IDEMPOTENCY_TTL_MS = 5 * 60 * 1000 // 5 minutes

type WriterFn = (chunk: Uint8Array | string | Socket.CloseEvent) => Effect.Effect<void>

export function create(socket: Socket.Socket, scope: Scope.Scope): Effect.Effect<Connection, never, Scope.Scope> {
  return Effect.gen(function* () {
    const writeFn = yield* (socket.writer as Effect.Effect<WriterFn, never, Scope.Scope>)
    const outbound = yield* Queue.bounded<Uint8Array>(OUTBOUND_QUEUE_CAPACITY)
    const state = yield* Ref.make<ConnectionState>({ closed: false })
    const idempotencyCache = new Map<string, { response: unknown; timestamp: number }>()
    const subscribed = new Set<string>()

    // Background: drain outbound queue → socket writer
    yield* Effect.forkIn(
      Effect.gen(function* () {
        while (true) {
          const frame = yield* Queue.take(outbound)
          yield* writeFn(frame as unknown as string).pipe(
            Effect.catch(() => Effect.void),
          )
        }
      }),
      scope,
    )

    // Background: heartbeat ping
    yield* Effect.forkIn(
      Effect.gen(function* () {
        while (true) {
          yield* Effect.sleep(PING_INTERVAL_MS)
          const current = yield* Ref.get(state)
          if (current.closed) return
          yield* Effect.promise(() =>
            Protocol.encodeOrThrow({ type: "ping" }).then((frame) =>
              Effect.runPromise(writeFn(frame).pipe(Effect.catch(() => Effect.void))),
            ),
          ).pipe(Effect.catch(() => Effect.void))
        }
      }),
      scope,
    )

    const push = (message: unknown): Effect.Effect<void> =>
      Effect.gen(function* () {
        const current = yield* Ref.get(state)
        if (current.closed) return
        const encoded = yield* Effect.promise(() => Protocol.encode(message))
        if (isProtocolError(encoded)) return
        const offered = yield* Queue.offer(outbound, encoded)
        if (!offered) {
          yield* Effect.logWarning("WS outbound queue full")
          yield* doClose(writeFn, state)
        }
      }).pipe(Effect.catch(() => Effect.void)) as Effect.Effect<void>

    const close = (code?: number, reason?: string) => doClose(writeFn, state, code, reason)

    const isOpen = Ref.get(state).pipe(Effect.map((s) => !s.closed)) as Effect.Effect<boolean>

    const idempotentGet = (id: string): unknown | undefined => {
      const entry = idempotencyCache.get(id)
      if (!entry) return undefined
      if (Date.now() - entry.timestamp > IDEMPOTENCY_TTL_MS) {
        idempotencyCache.delete(id)
        return undefined
      }
      return entry.response
    }

    const idempotentSet = (id: string, response: unknown): void => {
      // Clean expired entries periodically (probabilistic)
      if (idempotencyCache.size > 1000) {
        const now = Date.now()
        for (const [key, entry] of idempotencyCache) {
          if (now - entry.timestamp > IDEMPOTENCY_TTL_MS) idempotencyCache.delete(key)
        }
      }
      idempotencyCache.set(id, { response, timestamp: Date.now() })
    }

    return { push, close, isOpen, idempotentGet, idempotentSet, subscribed } as Connection
  })
}

function doClose(
  writeFn: WriterFn,
  state: Ref.Ref<ConnectionState>,
  code?: number,
  reason?: string,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const current = yield* Ref.get(state)
    if (current.closed) return
    yield* Ref.set(state, { closed: true })
    yield* writeFn(new Socket.CloseEvent(code ?? 1000, reason)).pipe(
      Effect.catch(() => Effect.void),
    )
  })
}

export * as WsConnection from "./connection"
