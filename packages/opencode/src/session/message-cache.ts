import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionID } from "./schema"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
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

// Message mutation events that make a cached page stale. Web prompts, TUI writes,
// revert cleanup, and streaming all emit one of these, so invalidating on them is
// what keeps this read-through cache coherent without patching cached arrays.
const INVALIDATING_EVENTS = new Set<string>([
  "message.updated",
  "message.removed",
  "message.part.updated",
  "message.part.removed",
  "message.part.delta",
  "session.deleted",
])

export interface Interface {
  readonly get: (sessionID: SessionID, limit: number, before?: string) => Effect.Effect<MessagePage | undefined>
  readonly set: (
    sessionID: SessionID,
    limit: number,
    before: string | undefined,
    page: MessagePage,
  ) => Effect.Effect<void>
  readonly invalidate: (sessionID: SessionID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/MessageCache") {}

export const layer: Layer.Layer<Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    // Plain Map rather than a SynchronizedRef: every cache operation here is a
    // synchronous in-memory mutation with no interleaving await, so the GlobalBus
    // listener below can invalidate directly from its (non-Effect) callback —
    // mirroring the repo's other GlobalBus subscribers (event.ts, global.ts) that
    // mutate state in-line via *Unsafe helpers.
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

    // Event-driven invalidation. Every message write (web, TUI, revert, streaming)
    // publishes one of INVALIDATING_EVENTS on GlobalBus, so dropping the affected
    // session's cached pages here makes the next read re-populate from the DB.
    // acquireRelease binds listener teardown to this layer's scope.
    const listener = (event: GlobalEvent) => {
      const type = event.payload?.type
      if (typeof type !== "string" || !INVALIDATING_EVENTS.has(type)) return
      const sessionID = event.payload?.properties?.sessionID
      if (typeof sessionID !== "string") return
      removeSession(sessionID)
    }
    yield* Effect.acquireRelease(
      Effect.sync(() => GlobalBus.on("event", listener)),
      () => Effect.sync(() => GlobalBus.off("event", listener)),
    )

    return Service.of({ get, set, invalidate })
  }),
)

export const defaultLayer = layer

export * as MessageCache from "./message-cache"
