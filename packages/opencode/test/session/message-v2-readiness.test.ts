import { describe, expect, test } from "bun:test"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { AgentAttachment } from "@opencode-ai/core/session/prompt"
import { DateTime } from "effect"
import { MessageV2Readiness } from "../../src/session/message-v2-readiness"

const model = {
  providerID: ProviderV2.ID.make("provider"),
  id: ModelV2.ID.make("model"),
  variant: ModelV2.VariantID.make("default"),
}

function id(suffix: string) {
  return SessionMessage.ID.make(`msg_${suffix}`)
}

function ids(messages: SessionMessage.Message[]) {
  return messages.map((message) => message.id)
}

function agent(name: string) {
  return new AgentAttachment({ name })
}

function user(suffix: string, time: number, input?: Partial<SessionMessage.User>): SessionMessage.User {
  return new SessionMessage.User({
    id: id(suffix),
    type: "user",
    text: suffix,
    files: [],
    agents: [],
    references: [],
    time: { created: DateTime.makeUnsafe(time) },
    ...input,
  })
}

function assistant(
  suffix: string,
  time: number,
  input?: Partial<SessionMessage.Assistant>,
): SessionMessage.Assistant {
  return new SessionMessage.Assistant({
    id: id(suffix),
    type: "assistant",
    agent: "build",
    model,
    content: [],
    time: { created: DateTime.makeUnsafe(time) },
    ...input,
  })
}

function compaction(
  suffix: string,
  time: number,
  input?: Partial<SessionMessage.Compaction>,
): SessionMessage.Compaction {
  return new SessionMessage.Compaction({
    id: id(suffix),
    type: "compaction",
    reason: "manual",
    summary: "",
    time: { created: DateTime.makeUnsafe(time) },
    ...input,
  })
}

function tool(
  suffix: string,
  state: SessionMessage.ToolState,
  input?: Partial<SessionMessage.AssistantTool>,
): SessionMessage.AssistantTool {
  return new SessionMessage.AssistantTool({
    id: `call-${suffix}`,
    type: "tool",
    name: "bash",
    time: { created: DateTime.makeUnsafe(2), completed: DateTime.makeUnsafe(3) },
    state,
    ...input,
  })
}

function pendingTool() {
  return tool("pending", new SessionMessage.ToolStatePending({ status: "pending", input: "{}" }))
}

function runningTool() {
  return tool(
    "running",
    new SessionMessage.ToolStateRunning({ status: "running", input: {}, structured: {}, content: [] }),
  )
}

function completedTool() {
  return tool(
    "completed",
    new SessionMessage.ToolStateCompleted({ status: "completed", input: {}, structured: {}, content: [] }),
  )
}

function erroredTool() {
  return tool(
    "error",
    new SessionMessage.ToolStateError({
      status: "error",
      input: {},
      structured: {},
      content: [],
      error: { type: "unknown", message: "failed" },
    }),
  )
}

describe("session.message-v2-readiness.promptProviderReadiness", () => {
  test("is ready for simple user-only v2 context", () => {
    const first = user("first", 1)

    expect(MessageV2Readiness.promptProviderReadiness([first])).toStrictEqual({
      type: "ready",
      mode: "new-turn",
      messages: [first],
    })
  })

  test("is ready for follow-up user after terminal assistant", () => {
    const first = user("first", 1)
    const finished = assistant("finished", 2, { finish: "stop" })
    const next = user("next", 3)

    const readiness = MessageV2Readiness.promptProviderReadiness([next, finished, first])

    expect(readiness.type).toBe("ready")
    if (readiness.type !== "ready") return
    expect(readiness.mode).toBe("new-turn")
    expect(ids(readiness.messages)).toStrictEqual([first.id, finished.id, next.id])
  })

  test("blocks when no user exists", () => {
    const finished = assistant("finished", 1, { finish: "stop" })

    expect(MessageV2Readiness.promptProviderReadiness([finished])).toStrictEqual({
      type: "blocked",
      reason: "no-user",
    })
  })

  test("blocks pending user agent task after latest finished assistant", () => {
    const first = user("first", 1)
    const finished = assistant("finished", 2, { finish: "stop" })
    const pending = user("pending", 3, { agents: [agent("reviewer")] })

    expect(MessageV2Readiness.promptProviderReadiness([pending, finished, first])).toStrictEqual({
      type: "blocked",
      reason: "pending-task",
    })
  })

  test("blocks pending compaction task after latest finished assistant", () => {
    const first = user("first", 1)
    const finished = assistant("finished", 2, { finish: "stop" })
    const pending = compaction("pending", 3)

    expect(MessageV2Readiness.promptProviderReadiness([pending, finished, first])).toStrictEqual({
      type: "blocked",
      reason: "pending-task",
    })
  })

  test("blocks latest non-terminal assistant", () => {
    const first = user("first", 1)
    const running = assistant("running", 2)

    expect(MessageV2Readiness.promptProviderReadiness([running, first])).toStrictEqual({
      type: "blocked",
      reason: "assistant-not-terminal",
    })
  })

  test("blocks assistant tool content with pending or running state", () => {
    const first = user("first", 1)
    const withPendingTool = assistant("pending_tool", 2, { finish: "tool-calls", content: [pendingTool()] })
    const withRunningTool = assistant("running_tool", 3, { finish: "tool-calls", content: [runningTool()] })

    expect(MessageV2Readiness.promptProviderReadiness([withPendingTool, first])).toStrictEqual({
      type: "blocked",
      reason: "tool-not-terminal",
    })
    expect(MessageV2Readiness.promptProviderReadiness([withRunningTool, first])).toStrictEqual({
      type: "blocked",
      reason: "tool-not-terminal",
    })
  })

  test("allows tool continuation when latest assistant finished tool-calls with terminal tools", () => {
    const first = user("first", 1)
    const finished = assistant("finished", 2, { finish: "tool-calls", content: [completedTool(), erroredTool()] })

    const readiness = MessageV2Readiness.promptProviderReadiness([finished, first])

    expect(readiness.type).toBe("ready")
    if (readiness.type !== "ready") return
    expect(readiness.mode).toBe("tool-continuation")
    expect(readiness.messages).toStrictEqual([first, finished])
  })

  test("settles terminal assistant stop with no newer user or tool continuation", () => {
    const first = user("first", 1)
    const finished = assistant("finished", 2, { finish: "stop" })

    expect(MessageV2Readiness.promptProviderReadiness([finished, first])).toStrictEqual({
      type: "settled",
      reason: "assistant-finished",
    })
  })
})

describe("session.message-v2-readiness.compactionProviderReadiness", () => {
  test("is ready with sorted selected candidate history", () => {
    const first = user("first", 1)
    const finished = assistant("finished", 2, { finish: "stop" })
    const next = user("next", 3)

    const readiness = MessageV2Readiness.compactionProviderReadiness([next, finished, first])

    expect(readiness.type).toBe("ready")
    if (readiness.type !== "ready") return
    expect(readiness.messages).toStrictEqual([first, finished, next])
  })

  test("blocks empty or no-user selected candidates", () => {
    const assistantOnly = assistant("assistant_only", 1, { finish: "stop" })

    expect(MessageV2Readiness.compactionProviderReadiness([])).toStrictEqual({ type: "blocked", reason: "no-user" })
    expect(MessageV2Readiness.compactionProviderReadiness([assistantOnly])).toStrictEqual({
      type: "blocked",
      reason: "no-user",
    })
  })

  test("blocks non-terminal selected assistant", () => {
    const first = user("first", 1)
    const running = assistant("running", 2)

    expect(MessageV2Readiness.compactionProviderReadiness([running, first])).toStrictEqual({
      type: "blocked",
      reason: "assistant-not-terminal",
    })
  })

  test("blocks unsettled tools in selected candidates", () => {
    const first = user("first", 1)
    const pending = assistant("pending", 2, { finish: "tool-calls", content: [pendingTool()] })
    const running = assistant("running", 3, { finish: "tool-calls", content: [runningTool()] })

    expect(MessageV2Readiness.compactionProviderReadiness([pending, first])).toStrictEqual({
      type: "blocked",
      reason: "tool-not-terminal",
    })
    expect(MessageV2Readiness.compactionProviderReadiness([running, first])).toStrictEqual({
      type: "blocked",
      reason: "tool-not-terminal",
    })
  })

  test("is ready with terminal tools in selected candidates", () => {
    const first = user("first", 1)
    const finished = assistant("finished", 2, { finish: "tool-calls", content: [completedTool(), erroredTool()] })

    const readiness = MessageV2Readiness.compactionProviderReadiness([finished, first])

    expect(readiness.type).toBe("ready")
    if (readiness.type !== "ready") return
    expect(readiness.messages).toStrictEqual([first, finished])
  })
})

test("implementation is pure and has no runtime provider dependency", async () => {
  const source = await Bun.file(new URL("../../src/session/message-v2-readiness.ts", import.meta.url)).text()

  expect(source).not.toContain("SessionMessageTable")
  expect(source).not.toContain("MessageTable")
  expect(source).not.toContain("PartTable")
  expect(source).not.toContain("Database")
  expect(source).not.toContain("@opencode-ai/core/session/sql")
  expect(source).not.toContain("@opencode-ai/core/session/session")
  expect(source).not.toContain("@opencode-ai/core/v1/session")
  expect(source).not.toContain("provider")
  expect(source).not.toContain("./message-v2-compaction")
  expect(source).not.toContain("@opencode-ai/llm")
  expect(source).not.toContain("llm.stream")
})
