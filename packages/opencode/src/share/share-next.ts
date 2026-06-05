import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { Effect, Exit, Layer, Option, Schema, Scope, Context } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { Account } from "@/account/account"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceState } from "@/effect/instance-state"

import { Session } from "@/session/session"
import type { SessionID } from "@/session/schema"
import { Database } from "@opencode-ai/core/database/database"
import { eq } from "drizzle-orm"
import { Config } from "@/config/config"
import * as Log from "@opencode-ai/core/util/log"
import { SessionShareTable } from "@opencode-ai/core/share/sql"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { TranscriptV2PublicExport } from "@/session/transcript-v2-public-export"
import { TranscriptV2PublicShare } from "./transcript-v2-public-share"

const log = Log.create({ service: "share-next" })
const disabled = process.env["OPENCODE_DISABLE_SHARE"] === "true" || process.env["OPENCODE_DISABLE_SHARE"] === "1"
const sessionNextShareSyncDefinitions = [
  SessionEvent.Prompted,
  SessionEvent.AgentSwitched,
  SessionEvent.ModelSwitched,
  SessionEvent.Synthetic,
  SessionEvent.Shell.Started,
  SessionEvent.Shell.Ended,
  SessionEvent.Step.Started,
  SessionEvent.Step.Ended,
  SessionEvent.Step.Failed,
  SessionEvent.Text.Started,
  SessionEvent.Text.Ended,
  SessionEvent.Reasoning.Started,
  SessionEvent.Reasoning.Ended,
  SessionEvent.Tool.Input.Started,
  SessionEvent.Tool.Input.Ended,
  SessionEvent.Tool.Called,
  SessionEvent.Tool.MetadataUpdated,
  SessionEvent.Tool.Success,
  SessionEvent.Tool.Failed,
  SessionEvent.Retried,
  SessionEvent.Compaction.Started,
  SessionEvent.Compaction.Ended,
] as const
type SessionNextShareSyncDefinition = (typeof sessionNextShareSyncDefinitions)[number]
type SessionNextShareSyncData = EventV2.Data<SessionNextShareSyncDefinition>

export type Api = {
  create: string
  sync: (shareID: string) => string
  remove: (shareID: string) => string
  data: (shareID: string) => string
}

export type Req = {
  headers: Record<string, string>
  api: Api
  baseUrl: string
}

const ShareSchema = Schema.Struct({
  id: Schema.String,
  url: Schema.String,
  secret: Schema.String,
})
export type Share = typeof ShareSchema.Type

type State = {
  queue: Set<SessionID>
  scope: Scope.Closeable
  shared: Map<SessionID, Share | null>
}

export interface Interface {
  readonly init: () => Effect.Effect<void, unknown>
  readonly url: () => Effect.Effect<string, unknown>
  readonly request: () => Effect.Effect<Req, unknown>
  readonly create: (sessionID: SessionID) => Effect.Effect<Share, unknown>
  readonly remove: (sessionID: SessionID) => Effect.Effect<void, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ShareNext") {}

export const use = serviceUse(Service)

function api(resource: string): Api {
  return {
    create: `/api/${resource}`,
    sync: (shareID) => `/api/${resource}/${shareID}/sync`,
    remove: (shareID) => `/api/${resource}/${shareID}`,
    data: (shareID) => `/api/${resource}/${shareID}/data`,
  }
}

const legacyApi = api("share")
const consoleApi = api("shares")

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const account = yield* Account.Service
    const events = yield* EventV2Bridge.Service
    const cfg = yield* Config.Service
    const database = yield* Database.Service
    const { db } = database
    const http = yield* HttpClient.HttpClient
    const httpOk = HttpClient.filterStatusOk(http)
    const session = yield* Session.Service

    function loadPublicPayload(sessionID: SessionID) {
      return TranscriptV2PublicExport.loadPublicTranscriptPayloadV2(sessionID).pipe(
        Effect.provideService(Database.Service, database),
        Effect.provideService(Session.Service, session),
      )
    }

    function sync(sessionID: SessionID) {
      return Effect.gen(function* () {
        if (disabled) return
        const share = yield* getCached(sessionID)
        if (!share) return

        const s = yield* InstanceState.get(state)
        if (s.queue.has(sessionID)) return
        s.queue.add(sessionID)
        yield* flush(sessionID).pipe(
          Effect.delay(1000),
          Effect.catchCause((cause) =>
            Effect.sync(() => {
              log.error("share flush failed", { sessionID, cause })
            }),
          ),
          Effect.forkIn(s.scope),
        )
      })
    }

    const state: InstanceState.InstanceState<State> = yield* InstanceState.make<State>(
      Effect.fn("ShareNext.state")(function* (_ctx) {
        const cache: State = { queue: new Set(), scope: yield* Scope.make(), shared: new Map() }

        yield* Effect.addFinalizer(() =>
          Scope.close(cache.scope, Exit.void).pipe(
            Effect.andThen(
              Effect.sync(() => {
                cache.queue.clear()
                cache.shared.clear()
              }),
            ),
          ),
        )

        if (disabled) return cache

        const watch = <D extends EventV2.Definition>(
          def: D,
          fn: (data: EventV2.Data<D>) => Effect.Effect<void, unknown>,
        ) =>
          Effect.gen(function* () {
            const unsubscribe = yield* events.listen((event) => {
              if (event.type !== def.type || event.location?.directory !== _ctx.directory) return Effect.void
              return fn(event.data as EventV2.Data<D>).pipe(
                Effect.catchCause((cause) =>
                  Effect.sync(() => log.error("share subscriber failed", { type: def.type, cause })),
                ),
              )
            })
            yield* Effect.addFinalizer(() => unsubscribe)
          })

        const watchSessionNext = (def: SessionNextShareSyncDefinition) =>
          watch(def, (data: SessionNextShareSyncData) => sync(data.sessionID))

        yield* watch(Session.Event.Updated, (data) =>
          Effect.gen(function* () {
            const info = data.info
            yield* sync(info.id)
          }),
        )
        yield* Effect.forEach(sessionNextShareSyncDefinitions, watchSessionNext, { discard: true })
        yield* watch(Session.Event.Diff, (data) => sync(data.sessionID))
        yield* watch(Session.Event.Deleted, (data) => remove(data.sessionID))

        return cache
      }),
    )

    const request = Effect.fn("ShareNext.request")(function* () {
      const headers: Record<string, string> = {}
      const active = yield* account.active()
      if (Option.isNone(active) || !active.value.active_org_id) {
        const baseUrl = (yield* cfg.get()).enterprise?.url ?? "https://opncd.ai"
        return { headers, api: legacyApi, baseUrl } satisfies Req
      }

      const token = yield* account.token(active.value.id)
      if (Option.isNone(token)) {
        throw new Error("No active account token available for sharing")
      }

      headers.authorization = `Bearer ${token.value}`
      headers["x-org-id"] = active.value.active_org_id
      return { headers, api: consoleApi, baseUrl: active.value.url } satisfies Req
    })

    const get = Effect.fnUntraced(function* (sessionID: SessionID) {
      const row = yield* db
        .select()
        .from(SessionShareTable)
        .where(eq(SessionShareTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      if (!row) return
      return { id: row.id, secret: row.secret, url: row.url } satisfies Share
    })

    const getCached = Effect.fnUntraced(function* (sessionID: SessionID) {
      const s = yield* InstanceState.get(state)
      if (s.shared.has(sessionID)) {
        const cached = s.shared.get(sessionID)
        return cached === null ? undefined : cached
      }

      const share = yield* get(sessionID)
      s.shared.set(sessionID, share ?? null)
      return share
    })

    const flush = Effect.fn("ShareNext.flush")(function* (sessionID: SessionID) {
      if (disabled) return
      const s = yield* InstanceState.get(state)
      if (!s.queue.has(sessionID)) return

      s.queue.delete(sessionID)

      const share = yield* getCached(sessionID)
      if (!share) return
      const payload = yield* loadPublicPayload(sessionID)
      const body = TranscriptV2PublicShare.toPublicTranscriptShareSyncBodyV2(share.secret, payload)

      const req = yield* request()
      const res = yield* HttpClientRequest.post(`${req.baseUrl}${req.api.sync(share.id)}`).pipe(
        HttpClientRequest.setHeaders(req.headers),
        HttpClientRequest.bodyJson(body),
        Effect.flatMap((r) => http.execute(r)),
      )

      if (res.status >= 400) {
        log.warn("failed to sync share", { sessionID, shareID: share.id, status: res.status })
      }
    })

    const full = Effect.fn("ShareNext.full")(function* (sessionID: SessionID) {
      log.info("full sync", { sessionID })
      const share = yield* getCached(sessionID)
      if (!share) return
      const payload = yield* loadPublicPayload(sessionID)
      const body = TranscriptV2PublicShare.toPublicTranscriptShareSyncBodyV2(share.secret, payload)
      const req = yield* request()
      const res = yield* HttpClientRequest.post(`${req.baseUrl}${req.api.sync(share.id)}`).pipe(
        HttpClientRequest.setHeaders(req.headers),
        HttpClientRequest.bodyJson(body),
        Effect.flatMap((r) => http.execute(r)),
      )
      if (res.status >= 400) {
        log.warn("failed to full sync share", { sessionID, shareID: share.id, status: res.status })
      }
    })

    const init = Effect.fn("ShareNext.init")(function* () {
      if (disabled) return
      yield* InstanceState.get(state)
    })

    const url = Effect.fn("ShareNext.url")(function* () {
      return (yield* request()).baseUrl
    })

    const create = Effect.fn("ShareNext.create")(function* (sessionID: SessionID) {
      if (disabled) return { id: "", url: "", secret: "" }
      log.info("creating share", { sessionID })
      const req = yield* request()
      const result = yield* HttpClientRequest.post(`${req.baseUrl}${req.api.create}`).pipe(
        HttpClientRequest.setHeaders(req.headers),
        HttpClientRequest.bodyJson({ sessionID }),
        Effect.flatMap((r) => httpOk.execute(r)),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(ShareSchema)),
      )
      yield* db
        .insert(SessionShareTable)
        .values({ session_id: sessionID, id: result.id, secret: result.secret, url: result.url })
        .onConflictDoUpdate({
          target: SessionShareTable.session_id,
          set: { id: result.id, secret: result.secret, url: result.url },
        })
        .run()
        .pipe(Effect.orDie)
      const s = yield* InstanceState.get(state)
      s.shared.set(sessionID, result)
      yield* full(sessionID).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            log.error("share full sync failed", { sessionID, cause })
          }),
        ),
        Effect.forkIn(s.scope),
      )
      return result
    })

    const remove = Effect.fn("ShareNext.remove")(function* (sessionID: SessionID) {
      if (disabled) return
      log.info("removing share", { sessionID })
      const s = yield* InstanceState.get(state)
      const share = yield* getCached(sessionID)
      if (!share) {
        s.shared.delete(sessionID)
        s.queue.delete(sessionID)
        return
      }

      const req = yield* request()
      yield* HttpClientRequest.delete(`${req.baseUrl}${req.api.remove(share.id)}`).pipe(
        HttpClientRequest.setHeaders(req.headers),
        HttpClientRequest.bodyJson({ secret: share.secret }),
        Effect.flatMap((r) => httpOk.execute(r)),
      )

      yield* db.delete(SessionShareTable).where(eq(SessionShareTable.session_id, sessionID)).run().pipe(Effect.orDie)
      s.shared.delete(sessionID)
      s.queue.delete(sessionID)
    })

    return Service.of({ init, url, request, create, remove })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(Account.defaultLayer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(Session.defaultLayer),
)

export * as ShareNext from "./share-next"
