import { Effect, Exit, Layer, Option, Redacted, Scope } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import * as Socket from "effect/unstable/socket/Socket"
import { ServerAuth } from "@/server/auth"
import * as Protocol from "./protocol"
import { isProtocolError } from "./protocol"
import { WsConnection } from "./connection"
import { WsEventBridge } from "./event-bridge"
import { WsMultiplex } from "./multiplex"
import { registerAll } from "./handlers"
import { registerRemaining } from "./extra-handlers"
import { CorsConfig, isAllowedRequestOrigin } from "@/server/cors"
import { handlerRuntime } from "./runtime"

const AUTH_TOKEN_QUERY = "auth_token"
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

export const layer = HttpRouter.use((router) =>
  router.add("GET", "/ws", (request: HttpServerRequest.HttpServerRequest) =>
    Effect.gen(function* () {
      const cors = yield* CorsConfig
      const authConfig = yield* Effect.serviceOption(ServerAuth.Config)
      const url = new URL(request.url, "http://localhost")

      if (!isAllowedRequestOrigin(request.headers.origin, request.headers.host, cors))
        return HttpServerResponse.empty({ status: 403 })

      const needsAuth = Option.isSome(authConfig) && ServerAuth.required(authConfig.value)
      if (needsAuth) {
        const token = url.searchParams.get(AUTH_TOKEN_QUERY)
        if (!token || !validateToken(token, authConfig.value))
          return HttpServerResponse.empty({ status: 401, headers: { "www-authenticate": 'Basic realm="Secure Area"' } })
      }

      const socket = yield* Effect.orDie(request.upgrade)
      const scope = yield* Scope.make()
      const conn = yield* WsConnection.create(socket, scope)

      // Wire EventV2 → WS push events through the connection scope
      yield* Effect.promise(() =>
        handlerRuntime.runPromise(
          WsEventBridge.bridge(conn, scope) as Effect.Effect<any>,
        ),
      ).pipe(Effect.catch(() => Effect.void))

      // Clean up scope when connection ends (prevents fiber leaks)
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.succeed(undefined)))

      yield* conn.push({ type: "hello", serverVersion: "1.0.0", protocolVersion: 2 }).pipe(
        Effect.catch(() => Effect.void),
      )

      // socket.runRaw callbacks run outside the Effect fiber context,
      // so we dispatch through a pre-built runtime that has all services.
      yield* socket.runRaw(
        (message) =>
          Effect.gen(function* () {
            if (typeof message === "string") return

            const decoded = yield* Effect.promise(() => Protocol.decode(message))
            if (isProtocolError(decoded)) {
              yield* conn.push({
                type: "response", requestID: "unknown", ok: false,
                error: { code: decoded._tag, message: decoded.message },
              }).pipe(Effect.catch(() => Effect.void))
              return
            }

            const msg = decoded as Record<string, unknown>
            if (msg.type === "ping") {
              yield* conn.push({ type: "pong" }).pipe(Effect.catch(() => Effect.void))
              return
            }

            const response = yield* Effect.promise(() =>
              handlerRuntime.runPromise(
                WsMultiplex.dispatch(msg, conn) as Effect.Effect<any>,
              ),
            )
            if (response !== undefined)
              yield* conn.push(response).pipe(Effect.catch(() => Effect.void))
          }).pipe(Effect.catch(() => Effect.logError("WS handler error"))),
        { onOpen: Effect.logInfo("WS connection opened") },
      ).pipe(
        Effect.catchReason("SocketError", "SocketCloseError", () =>
          Effect.logInfo("WS connection closed"),
        ),
        Effect.catch(() => Effect.logError("WS socket error")),
      )

      return HttpServerResponse.empty()
    }),
  ),
)
