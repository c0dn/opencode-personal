import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionID } from "./schema"
import { Effect, Layer, Context } from "effect"

type CacheEntry = {
  items: SessionV1.WithParts[]
  cursor?: string | null
}

export interface MessagePage {
  items: SessionV1.WithParts[]
  cursor?: string | null
}

function cacheKey(sessionID: SessionID, limit: number, before?: string) {
  return `${String(sessionID)}:${limit}:${before ?? "latest"}`
}

const MAX_ENTRIES = 200

export interface Interface {
  readonly get: (sessionID: SessionID, limit: number, before?: string) => Effect.Effect<MessagePage | undefined>
  readonly set: (
    sessionID: SessionID,
    limit: number,
    before: string | undefined,
    page: MessagePage,
  ) => Effect.Effect<void>
  // Public invalidation seam. The server transport drives this on message
  // mutations so this module stays transport- and event-source agnostic.
  readonly invalidate: (sessionID: SessionID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/MessageCache") {}

export const layer: Layer.Layer<Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    // Plain Map store: every cache operation is a synchronous in-memory mutation
    // with no interleaving await, so invalidate is a pure synchronous Effect the
    // server can run with runSync from a bus callback.
    const entries = new Map<string, { entry: CacheEntry; at: number }>()

    const evictLRU = () => {
      const remaining = entries.size - MAX_ENTRIES
      if (remaining <= 0) return
      const sorted = [...entries.entries()].sort((a, b) => a[1].at - b[1].at)
      for (const [key] of sorted.slice(0, remaining)) entries.delete(key)
    }

    // Drop every cached page for one session. Deleting during key iteration is
    // well-defined for Map, so this stays a single pass.
    const removeSession = (sessionID: string) => {
      const prefix = `${sessionID}:`
      for (const key of entries.keys()) {
        if (key.startsWith(prefix)) entries.delete(key)
      }
    }

    const get = Effect.fn("MessageCache.get")(function* (sessionID: SessionID, limit: number, before?: string) {
      const key = cacheKey(sessionID, limit, before)
      const cached = entries.get(key)
      if (!cached) return undefined
      cached.at = Date.now()
      return cached.entry
    })

    const set = Effect.fn("MessageCache.set")(function* (
      sessionID: SessionID,
      limit: number,
      before: string | undefined,
      page: MessagePage,
    ) {
      evictLRU()
      const key = cacheKey(sessionID, limit, before)
      entries.set(key, { entry: page, at: Date.now() })
    })

    const invalidate = Effect.fn("MessageCache.invalidate")(function* (sessionID: SessionID) {
      removeSession(String(sessionID))
    })

    return Service.of({ get, set, invalidate })
  }),
)

export const defaultLayer = layer

export * as MessageCache from "./message-cache"
