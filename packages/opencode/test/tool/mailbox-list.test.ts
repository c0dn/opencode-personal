import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { SessionMailbox } from "@opencode-ai/core/session/mailbox"
import { Agent } from "@/agent/agent"
import { Truncate } from "@/tool/truncate"
import { SessionStatus } from "@/session/status"
import { MailboxListTool } from "@/tool/mailbox-list"
import { testEffect } from "../lib/effect"

function makeCtx(sessionID: SessionID) {
  return {
    sessionID,
    messageID: "msg_01" as any,
    agent: "opencode",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
}

function fakeMailbox(messages: SessionMailbox.Message[]): SessionMailbox.Interface {
  return {
    enqueue: () => Effect.succeed({} as SessionMailbox.Message),
    claim: () => Effect.succeed([]),
    delivered: () => Effect.succeed({} as SessionMailbox.Message),
    failed: () => Effect.succeed({} as SessionMailbox.Message),
    cancel: () => Effect.succeed({} as SessionMailbox.Message),
    get: () => Effect.fail(new SessionMailbox.NotFoundError({ id: "x" as SessionMailbox.ID })),
    list: (input) => {
      const filtered = messages.filter((m) => {
        if (input?.toSessionID && m.toSessionID !== input.toSessionID) return false
        if (input?.state && m.state !== input.state) return false
        if (input?.kind && m.kind !== input.kind) return false
        return true
      })
      return Effect.succeed(filtered.slice(0, input?.limit ?? 100))
    },
  }
}

const sid = SessionID.make("ses_test")

function testLayer(messages: SessionMailbox.Message[]) {
  return Layer.mergeAll(
    Layer.succeed(SessionMailbox.Service, SessionMailbox.Service.of(fakeMailbox(messages))),
    Layer.succeed(Agent.Service, Agent.Service.of({
      defaultInfo: () => Effect.succeed({ name: "test", description: "", model: { providerID: "x", modelID: "y" }, permission: null, mode: "primary" as const, hidden: false, topP: null, temperature: null, color: null, instructions: null, tools: null, mcp: null } as any),
      defaultAgent: () => Effect.succeed("test"),
      get: () => Effect.succeed({ name: "test" } as any),
      list: () => Effect.succeed([]),
    })),
    Layer.succeed(Truncate.Service, Truncate.Service.of({
      cleanup: () => Effect.void,
      write: (input: any) => Effect.succeed(input),
      output: (text: string) => Effect.succeed({ content: text, truncated: false }),
      limits: () => Effect.succeed({}),
    })),
  )
}

function makeMsg(overrides: Partial<SessionMailbox.Message> & { id: string; toSessionID: string }): SessionMailbox.Message {
  return {
    id: overrides.id as SessionMailbox.ID,
    fromSessionID: undefined,
    toSessionID: overrides.toSessionID,
    rootSessionID: undefined,
    kind: "inter_agent",
    delivery: "async",
    state: "queued",
    text: "",
    time: { created: 1, updated: 1 },
    ...overrides,
  }
}

describe("mailbox_list", () => {
  const t = testEffect(testLayer([
    makeMsg({ id: "mail_1", toSessionID: sid, state: "queued", text: "msg 1" }),
    makeMsg({ id: "mail_2", toSessionID: sid, state: "delivered", text: "msg 2" }),
    makeMsg({ id: "mail_3", toSessionID: sid, state: "processing", text: "msg 3" }),
    makeMsg({ id: "mail_4", toSessionID: "ses_other" as SessionID, state: "queued", text: "other" }),
  ]))

  const empty = testEffect(testLayer([]))

  t.effect("lists only messages for caller session", () =>
    Effect.gen(function* () {
      const toolInfo = yield* MailboxListTool
      const tool = yield* toolInfo.init()
      const result = yield* tool.execute({}, makeCtx(sid))
      const parsed = JSON.parse(result.output)
      expect(parsed.count).toBe(3)
      expect(parsed.messages.length).toBe(3)
      expect(parsed.messages.find((m: any) => m.to === "ses_other")).toBeUndefined()
    }),
  )

  t.effect("filters by state", () =>
    Effect.gen(function* () {
      const toolInfo = yield* MailboxListTool
      const tool = yield* toolInfo.init()
      const result = yield* tool.execute({ state: "queued" }, makeCtx(sid))
      const parsed = JSON.parse(result.output)
      expect(parsed.count).toBe(1)
      expect(parsed.messages[0].state).toBe("queued")
    }),
  )

  t.effect("returns by_state summary", () =>
    Effect.gen(function* () {
      const toolInfo = yield* MailboxListTool
      const tool = yield* toolInfo.init()
      const result = yield* tool.execute({}, makeCtx(sid))
      const parsed = JSON.parse(result.output)
      expect(parsed.by_state.queued).toBe(1)
      expect(parsed.by_state.delivered).toBe(1)
      expect(parsed.by_state.processing).toBe(1)
    }),
  )

  empty.effect("empty mailbox returns zero count", () =>
    Effect.gen(function* () {
      const toolInfo = yield* MailboxListTool
      const tool = yield* toolInfo.init()
      const result = yield* tool.execute({}, makeCtx(sid))
      const parsed = JSON.parse(result.output)
      expect(parsed.count).toBe(0)
    }),
  )
})
