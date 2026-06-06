import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionV2 } from "@opencode-ai/core/session"
import { Effect, Schema } from "effect"
import { Session } from "./session"
import { SessionID } from "./schema"

export const Payload = Schema.Struct({
  version: Schema.Literal(2),
  info: Session.Info,
  messages: Schema.Array(SessionMessage.Message),
}).annotate({ identifier: "TranscriptV2Public.Payload" })
export type Payload = typeof Payload.Type
export type EncodedPayload = typeof Payload.Encoded

export const decode = Schema.decodeUnknownSync(Payload)
export const encode = Schema.encodeUnknownSync(Payload)

export const load = Effect.fn("TranscriptV2Public.load")(function* (sessionID: SessionID) {
  const sessions = yield* Session.Service
  const sessionsV2 = yield* SessionV2.Service
  const info = yield* sessions.get(sessionID)
  const messages = yield* sessionsV2.messages({ sessionID, order: "asc" })

  return { version: 2 as const, info, messages }
})

export * as TranscriptV2Public from "./transcript-v2-public"
