import { describe, expect, test } from "bun:test"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { AgentAttachment } from "@opencode-ai/core/session/prompt"
import type { ModelMessage } from "ai"
import { DateTime } from "effect"
import { MessageV2Compaction } from "../../src/session/message-v2-compaction"
import { MessageV2Provider } from "../../src/session/message-v2-provider"

const model = {
  providerID: ProviderV2.ID.make("provider"),
  id: ModelV2.ID.make("model"),
  variant: ModelV2.VariantID.make("default"),
}

const converted: ModelMessage[] = [{ role: "user", content: [{ type: "text", text: "converted" }] }]

function id(suffix: string) {
  return SessionMessage.ID.make(`msg_${suffix}`)
}

function ids(messages: SessionMessage.Message[]) {
  return messages.map((message) => message.id)
}

function agent(name: string) {
  return new AgentAttachment({ name })
}

function captureConverter(output: ModelMessage[] = converted) {
  const calls: SessionMessage.Message[][] = []
  return {
    calls,
    convert: async (messages: SessionMessage.Message[]) => {
      calls.push(messages)
      return output
    },
  }
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

describe("session.message-v2-provider.preparePromptProviderMessages", () => {
  test("converts ready new-turn messages once after readiness ordering", async () => {
    const first = user("first", 1)
    const finished = assistant("finished", 2, { finish: "stop" })
    const next = user("next", 3)
    const converter = captureConverter()

    const result = await MessageV2Provider.preparePromptProviderMessages({
      messages: [next, finished, first],
      convert: converter.convert,
    })

    expect(result.type).toBe("ready")
    if (result.type !== "ready") return
    expect(result.mode).toBe("new-turn")
    expect(result.modelMessages).toBe(converted)
    expect(converter.calls).toHaveLength(1)
    expect(ids(converter.calls[0])).toStrictEqual([first.id, finished.id, next.id])
  })

  test("converts ready tool-continuation messages once", async () => {
    const first = user("first", 1)
    const finished = assistant("finished", 2, { finish: "tool-calls", content: [completedTool()] })
    const converter = captureConverter()

    const result = await MessageV2Provider.preparePromptProviderMessages({
      messages: [finished, first],
      convert: converter.convert,
    })

    expect(result.type).toBe("ready")
    if (result.type !== "ready") return
    expect(result.mode).toBe("tool-continuation")
    expect(result.modelMessages).toBe(converted)
    expect(converter.calls).toHaveLength(1)
    expect(ids(converter.calls[0])).toStrictEqual([first.id, finished.id])
  })

  test("does not convert settled histories", async () => {
    const converter = captureConverter()

    const result = await MessageV2Provider.preparePromptProviderMessages({
      messages: [assistant("finished", 2, { finish: "stop" }), user("first", 1)],
      convert: converter.convert,
    })

    expect(result).toStrictEqual({ type: "settled", reason: "assistant-finished" })
    expect(converter.calls).toHaveLength(0)
  })

  test("does not convert blocked prompt histories", async () => {
    const finished = assistant("finished", 2, { finish: "stop" })
    const cases = [
      {
        messages: [finished],
        reason: "no-user",
      },
      {
        messages: [user("task", 3, { agents: [agent("reviewer")] }), finished, user("first", 1)],
        reason: "pending-task",
      },
      {
        messages: [assistant("running", 2), user("first", 1)],
        reason: "assistant-not-terminal",
      },
      {
        messages: [assistant("tool", 2, { finish: "tool-calls", content: [pendingTool()] }), user("first", 1)],
        reason: "tool-not-terminal",
      },
    ] as const

    for (const item of cases) {
      const converter = captureConverter()
      const result = await MessageV2Provider.preparePromptProviderMessages({
        messages: item.messages,
        convert: converter.convert,
      })

      expect(result).toStrictEqual({ type: "blocked", reason: item.reason })
      expect(converter.calls).toHaveLength(0)
    }
  })
})

describe("session.message-v2-provider.prepareCompactionProviderMessages", () => {
  test("converts supplied selected candidates in canonical order without anchor slicing", async () => {
    const first = user("first", 1)
    const finished = assistant("finished", 2, { finish: "stop" })
    const next = user("next", 3)
    const converter = captureConverter()

    const result = await MessageV2Provider.prepareCompactionProviderMessages({
      messages: [next, finished, first],
      convert: converter.convert,
    })

    expect(result.type).toBe("ready")
    if (result.type !== "ready") return
    expect(result.modelMessages).toBe(converted)
    expect(converter.calls).toHaveLength(1)
    expect(ids(converter.calls[0])).toStrictEqual([first.id, finished.id, next.id])
  })

  test("converts candidates selected by the compaction selector composition", async () => {
    const first = user("first", 1)
    const firstAssistant = assistant("first_assistant", 2, { finish: "stop" })
    const completed = compaction("completed", 3, { summary: "summary", include: first.id })
    const second = user("second", 4)
    const secondAssistant = assistant("second_assistant", 5, { finish: "stop" })
    const third = user("third", 6)
    const thirdAssistant = assistant("third_assistant", 7, { finish: "stop" })
    const selected = await MessageV2Compaction.select({
      messages: [thirdAssistant, third, secondAssistant, second, completed, firstAssistant, first],
      anchor: { id: id("future"), time: DateTime.makeUnsafe(8) },
      tailTurns: 1,
      preserveRecentTokens: 2,
      estimate: (messages) => messages.length,
    })

    expect(selected.type).toBe("selected")
    if (selected.type !== "selected") return

    const converter = captureConverter()
    const result = await MessageV2Provider.prepareCompactionProviderMessages({
      messages: selected.messages,
      convert: converter.convert,
    })

    expect(result.type).toBe("ready")
    if (result.type !== "ready") return
    expect(result.modelMessages).toBe(converted)
    expect(converter.calls).toHaveLength(1)
    expect(ids(converter.calls[0])).toStrictEqual([first.id, firstAssistant.id, second.id, secondAssistant.id])
  })

  test("does not convert blocked compaction histories", async () => {
    const first = user("first", 1)
    const finished = assistant("finished", 2, { finish: "stop" })
    const runningAssistant = assistant("running", 2)
    const pendingAssistant = assistant("pending_tool", 2, { finish: "tool-calls", content: [runningTool()] })
    const cases = [
      {
        messages: [finished],
        reason: "no-user",
      },
      {
        messages: [runningAssistant, first],
        reason: "assistant-not-terminal",
      },
      {
        messages: [pendingAssistant, first],
        reason: "tool-not-terminal",
      },
    ] as const

    for (const item of cases) {
      const converter = captureConverter()
      const result = await MessageV2Provider.prepareCompactionProviderMessages({
        messages: item.messages,
        convert: converter.convert,
      })

      expect(result).toStrictEqual({ type: "blocked", reason: item.reason })
      expect(converter.calls).toHaveLength(0)
    }
  })
})

test("implementation is a pure gate-before-convert leaf", async () => {
  const source = await Bun.file(new URL("../../src/session/message-v2-provider.ts", import.meta.url)).text()
  const forbiddenImports = [
    "@opencode-ai/core/session/sql",
    "@opencode-ai/core/session/session",
    "@opencode-ai/core/v1/session",
    "@opencode-ai/llm",
    "./message-v2",
    "./message-v2-compaction",
    "./prompt",
    "./compaction",
  ]
  const forbiddenSymbols = [
    "SessionMessageTable",
    "MessageTable",
    "PartTable",
    "Database",
    "SessionV2",
    "SessionV1",
    "LLM",
    "llm.stream",
    "MessageV2Context.context",
    "MessageV2Context.filterCompacted",
  ]

  for (const specifier of forbiddenImports) {
    const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    expect(source).not.toMatch(new RegExp(`from\\s+["']${escaped}["']|import\\(["']${escaped}["']\\)`))
  }
  for (const symbol of forbiddenSymbols) {
    expect(source).not.toContain(symbol)
  }
})
