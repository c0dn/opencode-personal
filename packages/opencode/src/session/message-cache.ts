import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionID } from "./schema"
import { Effect, SynchronizedRef, Layer, Context } from "effect"

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
  readonly set: (sessionID: SessionID, limit: number, before: string | undefined, page: MessagePage) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/MessageCache") {}

export const layer: Layer.Layer<Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const entries = yield* SynchronizedRef.make(new Map<string, { entry: CacheEntry; at: number }>())

    const evictLRU = Effect.fn("MessageCache.evictLRU")(function* () {
      yield* SynchronizedRef.update(entries, (map) => {
        const remaining = map.size - MAX_ENTRIES
        if (remaining <= 0) return map
        const sorted = [...map.entries()].sort((a, b) => a[1].at - b[1].at)
        const next = new Map(map)
        for (const [key] of sorted.slice(0, remaining)) next.delete(key)
        return next
      })
    })

    const get = Effect.fn("MessageCache.get")(function* (sessionID: SessionID, limit: number, before?: string) {
      const key = cacheKey(sessionID, limit, before)
      const map = yield* SynchronizedRef.get(entries)
      const cached = map.get(key)
      if (!cached) return undefined
      yield* SynchronizedRef.update(entries, (map) => {
        const next = new Map(map)
        next.set(key, { ...cached, at: Date.now() })
        return next
      })
      return cached.entry
    })

    const set = Effect.fn("MessageCache.set")(function* (
      sessionID: SessionID,
      limit: number,
      before: string | undefined,
      page: MessagePage,
    ) {
      yield* evictLRU()
      const key = cacheKey(sessionID, limit, before)
      yield* SynchronizedRef.update(entries, (map) => {
        const next = new Map(map)
        next.set(key, { entry: page, at: Date.now() })
        return next
      })
    })

    return Service.of({ get, set })
  }),
)

export const defaultLayer = layer

export * as MessageCache from "./message-cache"

