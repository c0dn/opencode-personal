import { Effect } from "effect"

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

export * as WsConnection from "./connection"
