import { Effect, Layer, Context, Schema } from "effect"
import { Session } from "./session"
import { SessionMailbox } from "@opencode-ai/core/session/mailbox"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionRunState } from "./run-state"
import { SessionStatus } from "./status"
import { SessionID, MessageID, PartID } from "./schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

export class CrossRootError extends Schema.TaggedErrorClass<CrossRootError>()("SessionInterAgent.CrossRootError", {
  senderRoot: Schema.String,
  targetRoot: Schema.String,
}) {}

export class SelfSendError extends Schema.TaggedErrorClass<SelfSendError>()("SessionInterAgent.SelfSendError", {
  sessionID: SessionID,
}) {}

export class TargetNotFoundError extends Schema.TaggedErrorClass<TargetNotFoundError>()(
  "SessionInterAgent.TargetNotFoundError",
  { sessionID: SessionID },
) {}

export const SendInput = Schema.Struct({
  fromSessionID: SessionID,
  toSessionID: SessionID,
  message: Schema.String,
  delivery: Schema.optional(SessionMailbox.Delivery),
})
export type SendInput = Schema.Schema.Type<typeof SendInput>

export interface Interface {
  readonly send: (input: SendInput) => Effect.Effect<
    { mailboxID: SessionMailbox.ID },
    CrossRootError | SelfSendError | TargetNotFoundError
  >
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionInterAgent") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const session = yield* Session.Service
    const mailbox = yield* SessionMailbox.Service
    const runState = yield* SessionRunState.Service
    const execution = yield* SessionExecution.Service

    const findRoot = Effect.fn("SessionInterAgent.findRoot")(function* (startID: string) {
      let rootID = startID
      let currentID: string | undefined = startID
      let depth = 0
      while (currentID && depth < 100) {
        rootID = currentID
        const info = yield* session.get(SessionID.make(currentID)).pipe(Effect.orDie)
        currentID = info.parentID
        depth++
      }
      if (depth >= 100) {
        return yield* Effect.die(new Error(`findRoot exceeded max depth at ${startID}: possible parentID cycle`))
      }
      return rootID
    })

    const notifyRoot = Effect.fn("SessionInterAgent.notifyRoot")(function* (
      rootSessionID: SessionID,
      fromID: SessionID,
      toID: SessionID,
      message: string,
    ) {
      const rootInfo = yield* session.get(rootSessionID).pipe(Effect.orDie)

      const msgID = MessageID.ascending()
      const userMsg: SessionV1.User = {
        id: msgID,
        role: "user" as const,
        sessionID: rootSessionID,
        time: { created: Date.now() },
        agent: rootInfo.agent ?? "opencode",
        model: {
          providerID: ProviderV2.ID.make(rootInfo.model?.providerID ?? "unknown"),
          modelID: ModelV2.ID.make(rootInfo.model?.id ?? "unknown"),
          variant: rootInfo.model?.variant ?? undefined,
        },
      }
      yield* session.updateMessage(userMsg)

      const partID = PartID.ascending()
      const textPart: SessionV1.TextPart = {
        id: partID,
        sessionID: rootSessionID,
        messageID: msgID,
        type: "text" as const,
        text: `<inter_agent_relay from="${fromID}" to="${toID}">\n${message}\n</inter_agent_relay>`,
        synthetic: true,
      }
      yield* session.updatePart(textPart)
    })

    const send = Effect.fn("SessionInterAgent.send")(function* (input: SendInput) {
      if (input.fromSessionID === input.toSessionID) {
        return yield* new SelfSendError({ sessionID: input.fromSessionID })
      }

      const targetInfo = yield* session.get(input.toSessionID).pipe(
        Effect.mapError(() => new TargetNotFoundError({ sessionID: input.toSessionID })),
      )

      const senderRoot = yield* findRoot(input.fromSessionID)
      const targetRoot = yield* findRoot(input.toSessionID)

      if (senderRoot !== targetRoot) {
        return yield* new CrossRootError({ senderRoot, targetRoot })
      }

      const delivery = input.delivery ?? "async"

      if (delivery === "interrupt") {
        yield* runState.cancel(input.toSessionID).pipe(Effect.catchCause(() => Effect.void))
      }

      const mailboxMsg = yield* mailbox.enqueue({
        fromSessionID: input.fromSessionID,
        toSessionID: input.toSessionID,
        rootSessionID: SessionID.make(senderRoot),
        kind: "inter_agent" as const,
        delivery,
        text: input.message,
      })

      const msgID = MessageID.ascending()
      const userMsg: SessionV1.User = {
        id: msgID,
        role: "user" as const,
        sessionID: input.toSessionID,
        time: { created: Date.now() },
        agent: targetInfo.agent ?? "opencode",
        model: {
          providerID: ProviderV2.ID.make(targetInfo.model?.providerID ?? "unknown"),
          modelID: ModelV2.ID.make(targetInfo.model?.id ?? "unknown"),
          variant: targetInfo.model?.variant ?? undefined,
        },
      }
      yield* session.updateMessage(userMsg)

      const partID = PartID.ascending()
      const textPart: SessionV1.TextPart = {
        id: partID,
        sessionID: input.toSessionID,
        messageID: msgID,
        type: "text" as const,
        text: `<inter_agent_message from="${input.fromSessionID}">\n${input.message}\n</inter_agent_message>`,
        synthetic: true,
      }
      yield* session.updatePart(textPart)

      // Notify root session when neither sender nor target is the root
      // (so the user can see sibling→sibling communication in the parent transcript)
      const rootID = SessionID.make(senderRoot)
      if (input.fromSessionID !== rootID && input.toSessionID !== rootID) {
        yield* notifyRoot(rootID, input.fromSessionID, input.toSessionID, input.message)
      }

      yield* execution.wake(input.toSessionID).pipe(Effect.catchCause(() => Effect.void))

      return { mailboxID: mailboxMsg.id }
    })

    return Service.of({ send })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Session.defaultLayer),
  Layer.provide(SessionMailbox.defaultLayer),
  Layer.provide(SessionRunState.defaultLayer),
  Layer.provide(SessionStatus.defaultLayer),
  Layer.provide(SessionExecution.noopLayer),
)

export * as SessionInterAgent from "./inter-agent"
