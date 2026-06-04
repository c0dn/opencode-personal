import { afterEach, describe, expect } from "bun:test"
import { SessionLegacy } from "@opencode-ai/core/session/legacy"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Effect, Fiber, Layer, Queue } from "effect"
import { Agent } from "../../src/agent/agent"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Question } from "../../src/question"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { Session } from "../../src/session/session"
import { PlanExitTool } from "../../src/tool/plan"
import type * as Tool from "../../src/tool/tool"
import { Truncate } from "../../src/tool/truncate"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { disposeAllInstances } from "../fixture/fixture"
import { ProviderTest } from "../fake/provider"
import { testEffect } from "../lib/effect"

const sessionID = SessionID.make("ses_plan_exit_test")
const messageID = MessageID.make("msg_plan_exit_test")
const defaultRef = {
  providerID: ProviderV2.ID.make("default-provider"),
  modelID: ProviderV2.ModelID.make("default-model"),
}
const priorRef = {
  providerID: ProviderV2.ID.make("prior-provider"),
  modelID: ProviderV2.ModelID.make("prior-model"),
}
const contextModel = ProviderTest.model({
  providerID: ProviderV2.ID.make("context-provider"),
  id: ProviderV2.ModelID.make("context-model"),
})
const contextVariant = "high-reasoning"
const alternateModel = ProviderTest.model({
  providerID: ProviderV2.ID.make("alternate-provider"),
  id: ProviderV2.ModelID.make("alternate-model"),
})

let updatedMessages: SessionLegacy.Info[] = []

const provider = ProviderTest.fake({ model: ProviderTest.model({ providerID: defaultRef.providerID, id: defaultRef.modelID }) })

const sessionLayer = Layer.succeed(
  Session.Service,
  Session.Service.of({
    get: Effect.fn("PlanExitToolTest.Session.get")(() =>
      Effect.succeed({
        id: sessionID,
        slug: "plan-exit-test",
        model: { providerID: contextModel.providerID, id: contextModel.id, variant: contextVariant },
        time: { created: 1, updated: 1 },
      } as Session.Info),
    ),
    messages: Effect.fn("PlanExitToolTest.Session.messages")(() =>
      Effect.die(new Error("plan_exit should not read legacy transcript messages")),
    ),
    updateMessage: Effect.fn("PlanExitToolTest.Session.updateMessage")((msg) =>
      Effect.sync(() => {
        updatedMessages.push(msg)
        return msg
      }),
    ),
    updatePart: Effect.fn("PlanExitToolTest.Session.updatePart")((part) => Effect.succeed(part)),
  } as unknown as Session.Interface),
)

const layer = Layer.mergeAll(
  Agent.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
  EventV2Bridge.defaultLayer,
  provider.layer,
  Question.layer.pipe(Layer.provideMerge(EventV2Bridge.defaultLayer)),
  sessionLayer,
  Truncate.defaultLayer,
)

const it = testEffect(layer)

afterEach(async () => {
  updatedMessages = []
  await disposeAllInstances()
})

describe("tool.plan", () => {
  it.instance("plan_exit uses active ctx.extra.model instead of a prior transcript model", () =>
    Effect.gen(function* () {
      const result = yield* executeApprovedPlanExit({ model: contextModel })

      expect(result.title).toBe("Switching to build agent")
      expect(createdBuildUser()?.model).toEqual({
        providerID: contextModel.providerID,
        modelID: contextModel.id,
        variant: contextVariant,
      })
    }),
  )

  it.instance("plan_exit falls back to provider.defaultModel() when ctx.extra.model is absent", () =>
    Effect.gen(function* () {
      yield* executeApprovedPlanExit()

      expect(createdBuildUser()?.model).toEqual(defaultRef)
    }),
  )

  it.instance("plan_exit does not preserve a stale session variant when ctx.extra.model differs", () =>
    Effect.gen(function* () {
      yield* executeApprovedPlanExit({ model: alternateModel })

      expect(createdBuildUser()?.model).toEqual({
        providerID: alternateModel.providerID,
        modelID: alternateModel.id,
      })
    }),
  )

  it.instance("plan_exit falls back to provider.defaultModel() when ctx.extra.model is invalid", () =>
    Effect.gen(function* () {
      yield* executeApprovedPlanExit({ model: { providerID: contextModel.providerID } } as Tool.Context["extra"])

      expect(createdBuildUser()?.model).toEqual(defaultRef)
    }),
  )
})

const executeApprovedPlanExit = Effect.fn("PlanExitToolTest.executeApprovedPlanExit")(function* (
  extra?: Tool.Context["extra"],
) {
  const question = yield* Question.Service
  const toolInfo = yield* PlanExitTool
  const tool = yield* toolInfo.init()

  const fiber = yield* tool.execute({}, makeContext(extra)).pipe(Effect.forkScoped)
  const item = yield* pending(question)
  yield* question.reply({ requestID: item.id, answers: [["Yes"]] })
  return yield* Fiber.join(fiber)
})

const pending = Effect.fn("PlanExitToolTest.pending")(function* (question: Question.Interface) {
  const events = yield* EventV2Bridge.Service
  const asked = yield* Queue.unbounded<void>()
  const off = yield* events.listen((event) => {
    if (event.type === Question.Event.Asked.type) Queue.offerUnsafe(asked, undefined)
    return Effect.void
  })
  yield* Effect.addFinalizer(() => off)

  for (;;) {
    const items = yield* question.list()
    const item = items[0]
    if (item) return item
    yield* Queue.take(asked).pipe(Effect.timeout("2 seconds"))
  }
})

function makeContext(extra?: Tool.Context["extra"]): Tool.Context {
  return {
    sessionID,
    messageID,
    callID: "plan-exit-call",
    agent: "plan",
    abort: AbortSignal.any([]),
    extra,
    messages: [
      {
        info: {
          id: MessageID.ascending(),
          sessionID,
          role: "user",
          agent: "plan",
          model: priorRef,
          time: { created: Date.now() },
        },
        parts: [
          {
            id: PartID.ascending(),
            sessionID,
            messageID: MessageID.ascending(),
            type: "text",
            text: "prior transcript message with a different model",
          },
        ],
      },
    ],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
}

function createdBuildUser() {
  return updatedMessages.find((msg): msg is SessionLegacy.User => msg.role === "user" && msg.agent === "build")
}
