import { Effect } from "effect"
import type { Connection } from "./connection"

/**
 * A request handler receives the decoded message object and the connection.
 * Returns a response payload (or void for fire-and-forget messages).
 */
export type Handler = (msg: Record<string, unknown>, conn: Connection) => Effect.Effect<any, any, any>

/**
 * Dispatch table mapping message type to handler.
 */
const handlers = new Map<string, Handler>()

/**
 * Register a handler for a message type.
 */
export function register(type: string, handler: Handler): void {
  handlers.set(type, handler)
}

/**
 * Dispatch a decoded message to the registered handler.
 * Returns a response object (or undefined for fire-and-forget).
 */
export function dispatch(
  msg: Record<string, unknown>,
  conn: Connection,
): Effect.Effect<any, any, any> {
  return Effect.gen(function* () {
    const type = typeof msg.type === "string" ? msg.type : undefined
    const requestID = typeof msg.requestID === "string" ? msg.requestID : undefined
    const idempotencyID = typeof msg.idempotencyID === "string" ? msg.idempotencyID : undefined

    // Check idempotency cache for mutating requests
    if (idempotencyID) {
      const cached = conn.idempotentGet(idempotencyID)
      if (cached !== undefined) return cached
    }

    const handler = type ? handlers.get(type) : undefined

    if (!handler) {
      const errorResponse = {
        type: "response",
        requestID: requestID ?? "unknown",
        ok: false,
        error: { code: "UNKNOWN_TYPE", message: `No handler for message type: ${type ?? "missing"}` },
      }
      if (idempotencyID) conn.idempotentSet(idempotencyID, errorResponse)
      return errorResponse
    }

    try {
      const result = yield* handler(msg, conn)
      if (result === undefined) return undefined

      const response = {
        type: "response",
        requestID: requestID ?? "unknown",
        ok: true,
        data: result,
      }
      if (idempotencyID) conn.idempotentSet(idempotencyID, response)
      return response
    } catch (error) {
      const errorResponse = {
        type: "response",
        requestID: requestID ?? "unknown",
        ok: false,
        error: { code: "HANDLER_ERROR", message: error instanceof Error ? error.message : String(error) },
      }
      if (idempotencyID) conn.idempotentSet(idempotencyID, errorResponse)
      return errorResponse
    }
  }).pipe(Effect.catch(() =>
    Effect.succeed({
      type: "response",
      requestID: typeof msg.requestID === "string" ? msg.requestID : "unknown",
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "Handler failed" },
    }),
  ))
}

export * as WsMultiplex from "./multiplex"
