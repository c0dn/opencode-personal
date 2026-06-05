import { NodeFileSystem } from "@effect/platform-node"
import { beforeEach, describe, expect } from "bun:test"
import { DateTime, Effect, Exit, Layer, Option } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"

import { AccessToken, AccountID, OrgID, RefreshToken } from "../../src/account/schema"
import { Account } from "../../src/account/account"
import { AccountRepo } from "../../src/account/repo"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Config } from "@/config/config"
import { Session } from "@/session/session"
import type { SessionID } from "../../src/session/schema"
import { ShareNext } from "@/share/share-next"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionShareTable } from "@opencode-ai/core/share/sql"
import { Database } from "@opencode-ai/core/database/database"
import { eq } from "drizzle-orm"
import { provideTmpdirInstance } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { testEffect } from "../lib/effect"

const env = Layer.mergeAll(
  Session.defaultLayer,
  AccountRepo.defaultLayer,
  Database.defaultLayer,
  NodeFileSystem.layer,
  CrossSpawnSpawner.defaultLayer,
)
const it = testEffect(env)

const json = (req: Parameters<typeof HttpClientResponse.fromWeb>[0], body: unknown, status = 200) =>
  HttpClientResponse.fromWeb(
    req,
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  )

const none = HttpClient.make(() => Effect.die("unexpected http call"))

function live(client: HttpClient.HttpClient) {
  const http = Layer.succeed(HttpClient.HttpClient, client)
  return ShareNext.layer.pipe(
    Layer.provide(EventV2Bridge.defaultLayer),
    Layer.provide(Account.layer.pipe(Layer.provide(AccountRepo.defaultLayer), Layer.provide(http))),
    Layer.provide(Config.defaultLayer),
    Layer.provide(Database.defaultLayer),
    Layer.provide(http),
    Layer.provide(Session.defaultLayer),
  )
}

function wired(client: HttpClient.HttpClient) {
  const http = Layer.succeed(HttpClient.HttpClient, client)
  return Layer.mergeAll(
    EventV2Bridge.defaultLayer,
    ShareNext.layer,
    Session.defaultLayer,
    AccountRepo.defaultLayer,
    Database.defaultLayer,
    NodeFileSystem.layer,
    CrossSpawnSpawner.defaultLayer,
  ).pipe(
    Layer.provide(EventV2Bridge.defaultLayer),
    Layer.provide(Account.layer.pipe(Layer.provide(AccountRepo.defaultLayer), Layer.provide(http))),
    Layer.provide(Config.defaultLayer),
    Layer.provide(http),
  )
}

const share = (id: SessionID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return yield* db
      .select()
      .from(SessionShareTable)
      .where(eq(SessionShareTable.session_id, id))
      .get()
      .pipe(Effect.orDie)
  })

const seed = (url: string, org?: string) =>
  AccountRepo.Service.use((repo) =>
    repo.persistAccount({
      id: AccountID.make("account-1"),
      email: "user@example.com",
      url,
      accessToken: AccessToken.make("st_test_token"),
      refreshToken: RefreshToken.make("rt_test_token"),
      expiry: Date.now() + 10 * 60_000,
      orgID: org ? Option.some(OrgID.make(org)) : Option.none(),
    }),
  )

beforeEach(async () => {
  await resetDatabase()
})

describe("ShareNext", () => {
  it.live("request uses legacy share API without active org account", () =>
    provideTmpdirInstance(
      () =>
        ShareNext.Service.use((svc) =>
          Effect.gen(function* () {
            const req = yield* svc.request()

            expect(req.api.create).toBe("/api/share")
            expect(req.api.sync("shr_123")).toBe("/api/share/shr_123/sync")
            expect(req.api.remove("shr_123")).toBe("/api/share/shr_123")
            expect(req.api.data("shr_123")).toBe("/api/share/shr_123/data")
            expect(req.baseUrl).toBe("https://legacy-share.example.com")
            expect(req.headers).toEqual({})
          }),
        ).pipe(Effect.provide(live(none))),
      { config: { enterprise: { url: "https://legacy-share.example.com" } } },
    ),
  )

  it.live("request uses default URL when no enterprise config", () =>
    provideTmpdirInstance(() =>
      ShareNext.Service.use((svc) =>
        Effect.gen(function* () {
          const req = yield* svc.request()

          expect(req.baseUrl).toBe("https://opncd.ai")
          expect(req.api.create).toBe("/api/share")
          expect(req.headers).toEqual({})
        }),
      ).pipe(Effect.provide(live(none))),
    ),
  )

  it.live("request uses org share API with auth headers when account is active", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* seed("https://control.example.com", "org-1")

        const req = yield* ShareNext.use.request().pipe(Effect.provide(live(none)))

        expect(req.api.create).toBe("/api/shares")
        expect(req.api.sync("shr_123")).toBe("/api/shares/shr_123/sync")
        expect(req.api.remove("shr_123")).toBe("/api/shares/shr_123")
        expect(req.api.data("shr_123")).toBe("/api/shares/shr_123/data")
        expect(req.baseUrl).toBe("https://control.example.com")
        expect(req.headers).toEqual({
          authorization: "Bearer st_test_token",
          "x-org-id": "org-1",
        })
      }),
    ),
  )

  it.live("create posts share, persists it, and returns the result", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const session = yield* Session.use.create({ title: "test" })
          const seen: HttpClientRequest.HttpClientRequest[] = []
          const client = HttpClient.make((req) => {
            seen.push(req)
            if (req.url.endsWith("/api/share")) {
              return Effect.succeed(
                json(req, {
                  id: "shr_abc",
                  url: "https://legacy-share.example.com/share/abc",
                  secret: "sec_123",
                }),
              )
            }
            return Effect.succeed(json(req, { ok: true }))
          })

          const result = yield* ShareNext.use.create(session.id).pipe(Effect.provide(live(client)))

          expect(result.id).toBe("shr_abc")
          expect(result.url).toBe("https://legacy-share.example.com/share/abc")
          expect(result.secret).toBe("sec_123")

          const row = yield* share(session.id)
          expect(row?.id).toBe("shr_abc")
          expect(row?.url).toBe("https://legacy-share.example.com/share/abc")
          expect(row?.secret).toBe("sec_123")

          expect(seen).toHaveLength(1)
          expect(seen[0].method).toBe("POST")
          expect(seen[0].url).toBe("https://legacy-share.example.com/api/share")
        }),
      { config: { enterprise: { url: "https://legacy-share.example.com" } } },
    ),
  )

  it.live("remove deletes the persisted share and calls the delete endpoint", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const session = yield* Session.use.create({ title: "test" })
          const seen: HttpClientRequest.HttpClientRequest[] = []
          const client = HttpClient.make((req) => {
            seen.push(req)
            if (req.method === "POST") {
              return Effect.succeed(
                json(req, {
                  id: "shr_abc",
                  url: "https://legacy-share.example.com/share/abc",
                  secret: "sec_123",
                }),
              )
            }
            return Effect.succeed(HttpClientResponse.fromWeb(req, new Response(null, { status: 200 })))
          })

          yield* Effect.gen(function* () {
            yield* ShareNext.use.create(session.id)
            yield* ShareNext.use.remove(session.id)
          }).pipe(Effect.provide(live(client)))

          expect(yield* share(session.id)).toBeUndefined()
          expect(seen.map((req) => [req.method, req.url])).toEqual([
            ["POST", "https://legacy-share.example.com/api/share"],
            ["DELETE", "https://legacy-share.example.com/api/share/shr_abc"],
          ])
        }),
      { config: { enterprise: { url: "https://legacy-share.example.com" } } },
    ),
  )

  it.live("create fails on a non-ok response and does not persist a share", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const session = yield* Session.use.create({ title: "test" })
        const client = HttpClient.make((req) => Effect.succeed(json(req, { error: "bad" }, 500)))

        const exit = yield* ShareNext.Service.use((svc) => Effect.exit(svc.create(session.id))).pipe(
          Effect.provide(live(client)),
        )

        expect(Exit.isFailure(exit)).toBe(true)
        expect(yield* share(session.id)).toBeUndefined()
      }),
    ),
  )

  it.live("ShareNext coalesces rapid canonical v2 session events into one public transcript sync", () =>
    provideTmpdirInstance(
      () => {
        const seen: Array<{ url: string; body: string }> = []
        const client = HttpClient.make((req) => {
          if (req.url.endsWith("/sync") && req.body._tag === "Uint8Array") {
            seen.push({ url: req.url, body: new TextDecoder().decode(req.body.body) })
          }
          return Effect.succeed(json(req, { ok: true }))
        })

        return Effect.gen(function* () {
          const events = yield* EventV2Bridge.Service
          const share = yield* ShareNext.Service
          const session = yield* Session.Service

          const info = yield* session.create({ title: "first" })
          yield* share.init()
          yield* Effect.sleep(50)
          const { db } = yield* Database.Service
          yield* db
            .insert(SessionShareTable)
            .values({
              session_id: info.id,
              id: "shr_abc",
              url: "https://legacy-share.example.com/share/abc",
              secret: "sec_123",
            })
            .run()
            .pipe(Effect.orDie)

          yield* events.publish(SessionEvent.Prompted, {
            sessionID: info.id,
            timestamp: DateTime.makeUnsafe(1_000),
            prompt: new Prompt({ text: "hello from v2" }),
          })
          yield* events.publish(SessionEvent.AgentSwitched, {
            sessionID: info.id,
            timestamp: DateTime.makeUnsafe(1_001),
            agent: "build",
          })
          yield* Effect.sleep(1_250)

          expect(seen).toHaveLength(1)
          expect(seen[0].url).toBe("https://legacy-share.example.com/api/share/shr_abc/sync")

          const body = JSON.parse(seen[0].body) as {
            secret: string
            data: Array<{
              type: string
              payload: {
                kind: string
                version: number
                session: { id: string; title: string }
                messages: unknown[]
              }
            }>
          }
          expect(body.secret).toBe("sec_123")
          expect(body.data).toHaveLength(1)
          expect(body.data[0].type).toBe("public_transcript_v2")
          expect(body.data[0].payload).toMatchObject({
            kind: "opencode.transcript",
            version: 2,
            session: { id: info.id, title: "first" },
          })
          expect(body.data[0].payload.messages).toMatchObject([{ type: "user", text: "hello from v2" }])
          for (const legacyType of ["session", "message", "part", "session_diff", "model"]) {
            expect(body.data.map((item) => item.type)).not.toContain(legacyType)
          }
        }).pipe(Effect.provide(wired(client)))
      },
      { config: { enterprise: { url: "https://legacy-share.example.com" } } },
    ),
  )

  it.live("ShareNext ignores canonical v2 session events from another directory", () =>
    provideTmpdirInstance(
      (dir) => {
        const seen: Array<{ url: string; body: string }> = []
        const client = HttpClient.make((req) => {
          if (req.url.endsWith("/sync") && req.body._tag === "Uint8Array") {
            seen.push({ url: req.url, body: new TextDecoder().decode(req.body.body) })
          }
          return Effect.succeed(json(req, { ok: true }))
        })

        return Effect.gen(function* () {
          const events = yield* EventV2Bridge.Service
          const share = yield* ShareNext.Service
          const session = yield* Session.Service

          const info = yield* session.create({ title: "first" })
          yield* share.init()
          const { db } = yield* Database.Service
          yield* db
            .insert(SessionShareTable)
            .values({
              session_id: info.id,
              id: "shr_abc",
              url: "https://legacy-share.example.com/share/abc",
              secret: "sec_123",
            })
            .run()
            .pipe(Effect.orDie)

          yield* events.publish(
            SessionEvent.Prompted,
            {
              sessionID: info.id,
              timestamp: DateTime.makeUnsafe(1_000),
              prompt: new Prompt({ text: "hello from elsewhere" }),
            },
            { location: { directory: AbsolutePath.make(`${dir}-other`) } },
          )
          yield* Effect.sleep(1_250)

          expect(seen).toHaveLength(0)
        }).pipe(Effect.provide(wired(client)))
      },
      { config: { enterprise: { url: "https://legacy-share.example.com" } } },
    ),
  )
})
