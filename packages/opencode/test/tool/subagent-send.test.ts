import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { SessionInterAgent } from "@/session/inter-agent"
import { SessionMailbox } from "@opencode-ai/core/session/mailbox"
import { Agent } from "@/agent/agent"
import { Truncate } from "@/tool/truncate"
import { SubagentSendTool } from "@/tool/subagent-send"
import { testEffect } from "../lib/effect"

function makeCtx(sessionID: SessionID) {
  return {
    sessionID,
    messageID: "msg_01" as Session.Info["id"],
    agent: "opencode",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
}

function fakeInterAgent(handlers: {
  send: SessionInterAgent.Interface["send"]
}): SessionInterAgent.Interface {
  return { send: handlers.send }
}

function agentLayer() {
  return Layer.succeed(Agent.Service, Agent.Service.of({
    defaultInfo: () =>
      Effect.succeed({
        name: "opencode",
        description: "",
        model: { providerID: "openai", modelID: "gpt-4" },
        permission: null,
        mode: "primary" as const,
        hidden: false,
        topP: null,
        temperature: null,
        color: null,
        instructions: null,
        tools: null,
        mcp: null,
      } satisfies Agent.Info),
    defaultAgent: () => Effect.succeed("opencode"),
    get: () =>
      Effect.succeed({
        name: "opencode",
        description: "",
        model: { providerID: "openai", modelID: "gpt-4" },
        permission: null,
        mode: "primary" as const,
        hidden: false,
        topP: null,
        temperature: null,
        color: null,
        instructions: null,
        tools: null,
        mcp: null,
      } satisfies Agent.Info),
    list: () => Effect.succeed([]),
  }))
}

function truncateLayer() {
  return Layer.succeed(Truncate.Service, Truncate.Service.of({
    cleanup: () => Effect.void,
    write: (input: any) => Effect.succeed(input),
    output: (_text: string, _opts: any, _agent: any) =>
      Effect.succeed({ content: _text, truncated: false }),
    limits: () => Effect.succeed({}),
  }))
}

// --- test IDs ---

const rootID = SessionID.make("ses_root_A")
const childA_ID = SessionID.make("ses_child_A1")
const childB_ID = SessionID.make("ses_child_A2")
const root2ID = SessionID.make("ses_root_2")

// --- layer helpers ---

function successLayer() {
  return Layer.mergeAll(
    agentLayer(),
    truncateLayer(),
    Layer.succeed(
      SessionInterAgent.Service,
      SessionInterAgent.Service.of(
        fakeInterAgent({
          send: (_input) =>
            Effect.succeed({ mailboxID: "mail_ok" as SessionMailbox.ID }),
        }),
      ),
    ),
  )
}

function selfSendLayer() {
  return Layer.mergeAll(
    agentLayer(),
    truncateLayer(),
    Layer.succeed(
      SessionInterAgent.Service,
      SessionInterAgent.Service.of(
        fakeInterAgent({
          send: (_input) =>
            Effect.fail(
              new SessionInterAgent.SelfSendError({ sessionID: rootID }),
            ),
        }),
      ),
    ),
  )
}

function crossRootLayer() {
  return Layer.mergeAll(
    agentLayer(),
    truncateLayer(),
    Layer.succeed(
      SessionInterAgent.Service,
      SessionInterAgent.Service.of(
        fakeInterAgent({
          send: (_input) =>
            Effect.fail(
              new SessionInterAgent.CrossRootError({
                senderRoot: rootID,
                targetRoot: root2ID,
              }),
            ),
        }),
      ),
    ),
  )
}

function targetNotFoundLayer() {
  return Layer.mergeAll(
    agentLayer(),
    truncateLayer(),
    Layer.succeed(
      SessionInterAgent.Service,
      SessionInterAgent.Service.of(
        fakeInterAgent({
          send: (_input) =>
            Effect.fail(
              new SessionInterAgent.TargetNotFoundError({
                sessionID: SessionID.make("ses_nope"),
              }),
            ),
        }),
      ),
    ),
  )
}

function captureLayer() {
  let captured: SessionInterAgent.SendInput | undefined
  return {
    layer: Layer.mergeAll(
      agentLayer(),
      truncateLayer(),
      Layer.succeed(
        SessionInterAgent.Service,
        SessionInterAgent.Service.of(
          fakeInterAgent({
            send: (input) => {
              captured = input
              return Effect.succeed({ mailboxID: "mail_cap" as SessionMailbox.ID })
            },
          }),
        ),
      ),
    ),
    get captured() {
      return captured
    },
  }
}

describe("subagent_send", () => {
  const success = testEffect(successLayer())
  const selfSend = testEffect(selfSendLayer())
  const crossRoot = testEffect(crossRootLayer())
  const notFound = testEffect(targetNotFoundLayer())

  success.effect("parent→child: sends successfully with default async delivery", () =>
    Effect.gen(function* () {
      const toolInfo = yield* SubagentSendTool
      const tool = yield* toolInfo.init()
      const result = yield* tool.execute(
        { target_session_id: childA_ID, message: "hello from root" },
        makeCtx(rootID),
      )
      expect(result.title).toContain("Message sent")
      const parsed = JSON.parse(result.output)
      expect(parsed.status).toBe("accepted")
      expect(parsed.delivery).toBe("async")
      expect(parsed.target_session_id).toBe(childA_ID)
    }),
  )

  success.effect("child→parent: sends successfully", () =>
    Effect.gen(function* () {
      const toolInfo = yield* SubagentSendTool
      const tool = yield* toolInfo.init()
      const result = yield* tool.execute(
        { target_session_id: rootID, message: "hello parent" },
        makeCtx(childA_ID),
      )
      const parsed = JSON.parse(result.output)
      expect(parsed.status).toBe("accepted")
    }),
  )

  success.effect("sibling→sibling: sends successfully within same tree", () =>
    Effect.gen(function* () {
      const toolInfo = yield* SubagentSendTool
      const tool = yield* toolInfo.init()
      const result = yield* tool.execute(
        { target_session_id: childB_ID, message: "hi sibling" },
        makeCtx(childA_ID),
      )
      const parsed = JSON.parse(result.output)
      expect(parsed.status).toBe("accepted")
    }),
  )

  success.effect("explicit delivery interrupt: accepts and reflects delivery mode", () =>
    Effect.gen(function* () {
      const toolInfo = yield* SubagentSendTool
      const tool = yield* toolInfo.init()
      const result = yield* tool.execute(
        { target_session_id: childA_ID, message: "urgent", delivery: "interrupt" },
        makeCtx(rootID),
      )
      const parsed = JSON.parse(result.output)
      expect(parsed.delivery).toBe("interrupt")
    }),
  )

  selfSend.effect("self-send: rejects with error message", () =>
    Effect.gen(function* () {
      const toolInfo = yield* SubagentSendTool
      const tool = yield* toolInfo.init()
      const result = yield* tool.execute(
        { target_session_id: rootID, message: "to self" },
        makeCtx(rootID),
      )
      expect(result.output).toContain("Cannot send message to yourself")
      expect(result.metadata.error).toBe("self_send")
    }),
  )

  notFound.effect("missing target: returns target not found error", () =>
    Effect.gen(function* () {
      const toolInfo = yield* SubagentSendTool
      const tool = yield* toolInfo.init()
      const result = yield* tool.execute(
        { target_session_id: "ses_nope", message: "hi" },
        makeCtx(rootID),
      )
      expect(result.output).toContain("Target session not found")
      expect(result.metadata.error).toBe("target_not_found")
    }),
  )

  crossRoot.effect("cross-root: rejects with error metadata cross_root", () =>
    Effect.gen(function* () {
      const toolInfo = yield* SubagentSendTool
      const tool = yield* toolInfo.init()
      const result = yield* tool.execute(
        { target_session_id: root2ID, message: "cross root" },
        makeCtx(rootID),
      )
      expect(result.output).toContain("Cross-root messaging not allowed")
      expect(result.metadata.error).toBe("cross_root")
    }),
  )

  // --- fromSessionID derivation (captured in mock) ---

  describe("fromSessionID derivation", () => {
    const capture = captureLayer()

    const capLayer = testEffect(capture.layer)

    capLayer.effect("derives fromSessionID from tool context, not user input", () =>
      Effect.gen(function* () {
        const toolInfo = yield* SubagentSendTool
        const tool = yield* toolInfo.init()
        yield* tool.execute(
          { target_session_id: childA_ID, message: "test" },
          makeCtx(rootID),
        )
        expect(capture.captured).toBeDefined()
        expect(capture.captured!.fromSessionID).toBe(rootID)
        expect(capture.captured!.toSessionID).toBe(childA_ID)
        expect(capture.captured!.message).toBe("test")
      }),
    )

    capLayer.effect("sends correct delivery mode default", () =>
      Effect.gen(function* () {
        const toolInfo = yield* SubagentSendTool
        const tool = yield* toolInfo.init()
        yield* tool.execute(
          { target_session_id: childA_ID, message: "hi" },
          makeCtx(rootID),
        )
        expect(capture.captured!.delivery).toBeUndefined()
      }),
    )
  })
})
