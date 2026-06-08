import { Effect, Layer, ManagedRuntime, Option, Redacted } from "effect"
import { ServerAuth } from "@/server/auth"
import { CorsConfig, isAllowedRequestOrigin, type CorsOptions } from "@/server/cors"
import { getRawHttpServer } from "@/server/server"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { WsMultiplex } from "@/server/ws/multiplex"
import { registerAll } from "@/server/ws/handlers"
import { registerRemaining } from "@/server/ws/extra-handlers"
import type { Connection } from "@/server/ws/connection"
import { memoMap } from "@opencode-ai/core/effect/memo-map"
import { Session } from "@/session/session"
import { MCP } from "@/mcp"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { Project } from "@/project/project"
import { Todo } from "@/session/todo"
import { SessionStatus } from "@/session/status"
import { Command } from "@/command"
import { Agent } from "@/agent/agent"
import { Skill } from "@/skill"
import { LSP } from "@/lsp/lsp"
import { Format } from "@/format"
import { Vcs } from "@/project/vcs"
import { Permission } from "@/permission"
import { Question } from "@/question"
import { SessionPrompt } from "@/session/prompt"
import { SessionRevert } from "@/session/revert"
import { SessionSummary } from "@/session/summary"
import { SessionShare } from "@/share/session"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Git } from "@/git"
import { Plugin } from "@/plugin"
import { Snapshot } from "@/snapshot"
import { ShareNext } from "@/share/share-next"
import { Reference } from "@/reference/reference"

registerAll()
registerRemaining()

function validateToken(token: string | null, config: ServerAuth.Info): boolean {
  if (!ServerAuth.required(config)) return true
  if (!token) return false
  try {
    const decoded = Buffer.from(token, "base64").toString("utf8")
    const separator = decoded.indexOf(":")
    if (separator === -1) return false
    const credential: ServerAuth.DecodedCredentials = {
      username: decoded.slice(0, separator),
      password: Redacted.make(decoded.slice(separator + 1)),
    }
    return ServerAuth.authorized(credential, config)
  } catch {
    return false
  }
}

function setupAuth(
  io: any,
  cors: CorsOptions | undefined,
  authConfig: Option.Option<ServerAuth.Info>,
) {
  io.use((socket: any, next: (err?: Error) => void) => {
    const headers = socket.handshake?.headers ?? {}
    const origin = headers.origin as string | undefined
    const host = headers.host as string | undefined

    if (!isAllowedRequestOrigin(origin, host, cors)) {
      next(new Error("forbidden_origin"))
      return
    }

    if (Option.isSome(authConfig) && ServerAuth.required(authConfig.value)) {
      const token = (socket.handshake?.auth?.token as string | undefined)
        ?? (socket.handshake?.query?.auth_token as string | undefined)
        ?? null
      if (!validateToken(token, authConfig.value)) {
        next(new Error("unauthorized"))
        return
      }
    }

    next()
  })
}

const handlerLayer = Layer.mergeAll(
  Database.defaultLayer,
  FSUtil.defaultLayer,
  Git.defaultLayer,
  Session.defaultLayer,
  SessionStatus.defaultLayer,
  Todo.defaultLayer,
  MCP.defaultLayer,
  Config.defaultLayer,
  Provider.defaultLayer,
  Project.defaultLayer,
  SessionPrompt.defaultLayer,
  SessionRevert.defaultLayer,
  SessionSummary.defaultLayer,
  SessionShare.defaultLayer,
  Command.defaultLayer,
  Agent.defaultLayer,
  Skill.defaultLayer,
  LSP.defaultLayer,
  Format.defaultLayer,
  Vcs.defaultLayer,
  Permission.defaultLayer,
  Question.defaultLayer,
  Plugin.defaultLayer,
  Snapshot.defaultLayer,
  ShareNext.defaultLayer,
  Reference.defaultLayer,
  InstanceStore.defaultLayer,
).pipe(
  Layer.provide(InstanceBootstrap.defaultLayer),
)

// Shared runtime built with the same memoMap as REST — deduplicates all service instances.
const handlerRuntime = ManagedRuntime.make(handlerLayer, { memoMap })

function setupSocket(socket: any) {
  // Per-socket idempotency cache
  const idempotencyCache = new Map<string, unknown>()
  const subscribed = new Set<string>()

  socket.data.subscribed = subscribed

  // Connection adapter for WsMultiplex.dispatch
  const conn: Connection = {
    push(message) {
      return Effect.promise(() => Promise.resolve(socket.emit("push", message)))
    },
    close(_code, _reason) {
      socket.disconnect()
      return Effect.void
    },
    isOpen: Effect.succeed(socket.connected),
    idempotentGet(id: string) {
      return idempotencyCache.get(id)
    },
    idempotentSet(id: string, response: unknown) {
      idempotencyCache.set(id, response)
    },
    subscribed,
  }

  socket.data.conn = conn

  // Hello
  socket.emit("hello", { serverVersion: "1.0.0", protocolVersion: 2 })

  // --- Event bridge (ported from ws/event-bridge.ts) ---
  const BATCH_MS = 16
  let pending: GlobalEvent[] = []
  let flushTimer: ReturnType<typeof setTimeout> | undefined

  function isSubscribed(event: GlobalEvent): boolean {
    if (subscribed.size === 0) return true
    const props = event.payload?.properties as Record<string, unknown> | undefined
    const sessionID = props?.sessionID as string | undefined
    if (sessionID === undefined) return true
    return subscribed.has(sessionID)
  }

  function flush() {
    const batch = pending
    pending = []
    flushTimer = undefined
    if (batch.length === 0) return

    if (batch.length === 1) {
      const event = batch[0]
      socket.emit("push.event", {
        directory: event.directory,
        project: event.project,
        workspace: event.workspace,
        payload: event.payload,
      })
      return
    }

    socket.emit("push.batch", { events: batch })
  }

  const listener = (event: GlobalEvent) => {
    if (!isSubscribed(event)) return
    pending.push(event)
    if (!flushTimer) flushTimer = setTimeout(flush, BATCH_MS)
  }

  GlobalBus.on("event", listener)

  socket.on("disconnect", () => {
    GlobalBus.off("event", listener)
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = undefined
    pending = []
  })

  // --- RPC handler ---
  socket.on("rpc", async (msg: Record<string, unknown>, ack?: (response: unknown) => void) => {
    // Handle subscribe/unsubscribe locally
    if (msg.type === "session.subscribe") {
      const sessionID = typeof msg.sessionID === "string" ? msg.sessionID : undefined
      if (sessionID) subscribed.add(sessionID)
      if (ack) ack({ ok: true, data: { subscribed: Array.from(subscribed) } })
      return
    }
    if (msg.type === "session.unsubscribe") {
      const sessionID = typeof msg.sessionID === "string" ? msg.sessionID : undefined
      if (sessionID) subscribed.delete(sessionID)
      if (ack) ack({ ok: true, data: { subscribed: Array.from(subscribed) } })
      return
    }

    // Resolve per-request InstanceRef when payload carries 'directory'
    let ctx: unknown = undefined
    if (typeof msg.directory === "string") {
      ctx = await handlerRuntime.runPromise(
        Effect.gen(function* () {
          const store = yield* InstanceStore.Service
          return yield* store.load({ directory: msg.directory as string })
        }),
      ).catch(() => undefined)
    }

    const effect = WsMultiplex.dispatch(msg, conn).pipe(
      ctx ? Effect.provideService(InstanceRef, ctx) : (e) => e as any,
    ) as Effect.Effect<any>

    const response = await handlerRuntime.runPromise(effect).catch((error: unknown) => ({
      type: "response",
      requestID: typeof msg.requestID === "string" ? msg.requestID : "unknown",
      ok: false,
      error: { code: "DISPATCH_ERROR", message: error instanceof Error ? error.message : String(error) },
    }))

    if (response !== undefined && ack) ack(response)
  })

  // Fire-and-forget variant (no ack callback)
  socket.on("send", async (msg: Record<string, unknown>) => {
    let ctx: unknown = undefined
    if (typeof msg.directory === "string") {
      ctx = await handlerRuntime.runPromise(
        Effect.gen(function* () {
          const store = yield* InstanceStore.Service
          return yield* store.load({ directory: msg.directory as string })
        }),
      ).catch(() => undefined)
    }

    const effect = WsMultiplex.dispatch(msg, conn).pipe(
      ctx ? Effect.provideService(InstanceRef, ctx) : (e) => e as any,
    ) as Effect.Effect<any>

    await handlerRuntime.runPromise(effect).catch(() => {})
  })
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const rawServer = getRawHttpServer()
    const cors = yield* CorsConfig
    const authConfig = yield* Effect.serviceOption(ServerAuth.Config)

    const { Server } = yield* Effect.promise(() => import("socket.io"))
    const parser = yield* Effect.promise(() => import("socket.io-msgpack-parser"))
    const io = new Server(rawServer, {
      parser: parser.default,
      path: "/socket.io/",
      transports: ["websocket", "polling"],
    })

    yield* Effect.addFinalizer(() =>
      Effect.promise(() => new Promise<void>((resolve) => {
        io.close()
        resolve()
      })),
    )

    setupAuth(io, cors, authConfig)
    io.on("connection", (socket: any) => setupSocket(socket))

    yield* Effect.logInfo("Socket.IO transport attached")
  }),
)

export * as SocketIoTransport from "./transport"
