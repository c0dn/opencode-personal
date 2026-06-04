import { describe, expect, test } from "bun:test"
import { EventV2 } from "@opencode-ai/core/event"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { AgentAttachment, FileAttachment, ReferenceAttachment } from "@opencode-ai/core/session/prompt"
import { ToolOutput } from "@opencode-ai/core/tool-output"
import type { SessionMessage as WireSessionMessage } from "@opencode-ai/sdk/v2"
import { DateTime } from "effect"
import { TranscriptV2Display } from "../../src/session/transcript-v2-display"

const model = {
  providerID: ProviderV2.ID.make("provider"),
  id: ModelV2.ID.make("model"),
  variant: ModelV2.VariantID.make("default"),
}

describe("session.transcript-v2-display", () => {
  test("orders messages by canonical created time then ID and preserves assistant content order", () => {
    const later = user("later", 2)
    const sameB = user("same_b", 1)
    const sameA = assistant("same_a", 1, [text("z"), reasoning("a"), patch("m"), text("b")])

    const output = TranscriptV2Display.toDisplayTranscriptV2([later, sameB, sameA], { status: "ready" })

    expect(output.map((message) => message.id)).toStrictEqual([id("same_a"), id("same_b"), id("later")])
    expect(output[0]).toMatchObject({
      type: "assistant",
      content: [
        { type: "text", id: id("text_z") },
        { type: "reasoning", id: id("reasoning_a") },
        { type: "patch", id: id("patch_m") },
        { type: "text", id: id("text_b") },
      ],
    })
  })

  test("readiness fails closed unless explicitly ready", () => {
    const messages = [user("ready", 1)]
    const failures: Array<TranscriptV2Display.DisplayReadiness | undefined> = [
      undefined,
      { status: "upgrade_pending", reason: "partial" },
      { status: "upgrade_unavailable", reason: "missing-source" },
      { status: "aborted", reason: "mixed_cutoff_ambiguous" },
      { status: "failure", reason: "backfill_failed" },
      { status: "not-ready", reason: "unknown" },
      { status: "future-status" },
    ]

    expect(TranscriptV2Display.toDisplayTranscriptV2(messages, { status: "ready" })).toHaveLength(1)
    for (const readiness of failures) {
      expect(() => TranscriptV2Display.requireReady(readiness)).toThrow(TranscriptV2Display.DisplayTranscriptNotReadyError)
      expect(() => TranscriptV2Display.toDisplayTranscriptV2(messages, readiness)).toThrow(
        TranscriptV2Display.DisplayTranscriptNotReadyError,
      )
    }
  })

  test("covers current display variants while omitting unsafe metadata by default", () => {
    const messages: SessionMessage.Message[] = [
      new SessionMessage.ModelSwitched({
        type: "model-switched",
        id: id("model_switch"),
        model,
        metadata: { raw: "msg_model_metadata" },
        time: { created: time(1) },
      }),
      new SessionMessage.AgentSwitched({
        type: "agent-switched",
        id: id("agent_switch"),
        agent: "build",
        metadata: { raw: "prt_agent_metadata" },
        time: { created: time(2) },
      }),
      user("request", 3, {
        text: "open files",
        files: [new FileAttachment({ uri: "file:///README.md", mime: "text/markdown", name: "README.md" })],
        agents: [new AgentAttachment({ name: "build" })],
        references: [new ReferenceAttachment({ name: "README.md", kind: "local", uri: "file:///README.md" })],
        taskRequests: [
          new SessionMessage.UserTaskRequest({
            type: "task-request",
            id: id("task_request"),
            prompt: "review this",
            description: "review",
            agent: "reviewer",
            model,
            command: "review",
          }),
        ],
        metadata: { raw: "msg_user_metadata" },
      }),
      assistant("answer", 4, [
        text("answer_text", "Done"),
        reasoning("answer_reasoning", "Thinking"),
        tool("pending", new SessionMessage.ToolStatePending({ status: "pending", input: "raw input" })),
        tool(
          "running",
          new SessionMessage.ToolStateRunning({
            status: "running",
            input: { cmd: "ls" },
            structured: { ok: true },
            content: [new ToolOutput.TextContent({ type: "text", text: "running" })],
          }),
        ),
        tool(
          "completed",
          new SessionMessage.ToolStateCompleted({
            status: "completed",
            input: { cmd: "pwd" },
            structured: { cwd: "/work" },
            content: [
              new ToolOutput.TextContent({ type: "text", text: "ok" }),
              new ToolOutput.FileContent({ type: "file", uri: "file:///out.txt", mime: "text/plain", name: "out.txt" }),
            ],
          }),
        ),
        tool(
          "error",
          new SessionMessage.ToolStateError({
            status: "error",
            input: { cmd: "false" },
            structured: {},
            content: [],
            error: { type: "unknown", message: "failed" },
          }),
        ),
        patch("answer_patch"),
      ], {
        snapshot: { start: "before", end: "after" },
        finish: "stop",
        cost: 1.5,
        retries: [
          new SessionMessage.AssistantRetry({
            attempt: 1,
            error: { message: "retry", isRetryable: true },
            time: { created: time(5) },
          }),
        ],
        tokens: { input: 10, output: 20, reasoning: 3, cache: { read: 1, write: 2 } },
        error: { type: "unknown", message: "terminal error" },
        metadata: { raw: "msg_assistant_metadata" },
        time: { created: time(4), completed: time(6) },
      }),
      new SessionMessage.Shell({
        type: "shell",
        id: id("shell"),
        callID: "shell-call",
        command: "echo hi",
        output: "hi",
        metadata: { raw: "prt_shell_metadata" },
        time: { created: time(7), completed: time(8) },
      }),
      new SessionMessage.Synthetic({
        type: "synthetic",
        id: id("synthetic"),
        sessionID: SessionV2.ID.make("ses_child"),
        text: "background result",
        metadata: { raw: "msg_synthetic_metadata" },
        time: { created: time(9) },
      }),
      new SessionMessage.Compaction({
        type: "compaction",
        id: id("compaction"),
        reason: "manual",
        summary: "summary",
        include: id("request"),
        metadata: { raw: "prt_compaction_metadata" },
        time: { created: time(10) },
      }),
    ]

    const output = TranscriptV2Display.toDisplayTranscriptV2(messages.slice().reverse(), { status: "ready" })

    expect(output.map((message) => message.type)).toStrictEqual([
      "model-switched",
      "agent-switched",
      "user",
      "assistant",
      "shell",
      "synthetic",
      "compaction",
    ])
    expect(output[2]).toMatchObject({
      type: "user",
      id: id("request"),
      text: "open files",
      taskRequests: [{ type: "task-request", id: id("task_request"), prompt: "review this", command: "review" }],
    })
    const assistantOutput = output[3]
    expect(assistantOutput).toMatchObject({
      type: "assistant",
      id: id("answer"),
      finish: "stop",
      error: { type: "unknown", message: "terminal error" },
    })
    const retry = assistantOutput.type === "assistant" ? assistantOutput.retries?.[0] : undefined
    expect(retry?.attempt).toBe(1)
    expect(retry?.error).toMatchObject({ message: "retry", isRetryable: true })
    expect(assistantOutput.type === "assistant" ? assistantOutput.content : []).toHaveLength(7)
    if (assistantOutput.type !== "assistant") throw new Error("expected assistant output")
    expect(assistantOutput.content[0]).toMatchObject({ type: "text", id: id("text_answer_text"), text: "Done" })
    expect(assistantOutput.content[1]).toMatchObject({ type: "reasoning", id: id("reasoning_answer_reasoning"), text: "Thinking" })
    expect(assistantOutput.content[2]).toMatchObject({
      type: "tool",
      id: id("tool_pending"),
      provider: { executed: true },
      state: { status: "pending" },
    })
    expect(assistantOutput.content[3]).toMatchObject({ type: "tool", id: id("tool_running"), state: { status: "running" } })
    expect(assistantOutput.content[4]).toMatchObject({ type: "tool", id: id("tool_completed"), state: { status: "completed" } })
    expect(assistantOutput.content[5]).toMatchObject({
      type: "tool",
      id: id("tool_error"),
      state: { status: "error", error: { type: "unknown", message: "failed" } },
    })
    expect(assistantOutput.content[6]).toMatchObject({ type: "patch", id: id("patch_answer_patch"), hash: "hash-answer_patch", files: ["README.md"] })
    expect(output[4]).toMatchObject({ type: "shell", id: id("shell"), command: "echo hi", output: "hi" })
    expect(output[5]).toMatchObject({ type: "synthetic", id: id("synthetic"), sessionID: "ses_child" })
    expect(output[6]).toMatchObject({ type: "compaction", id: id("compaction"), include: id("request") })
    expectNoLegacyIDs(output)

    const json = JSON.stringify(output)
    expect(json).not.toContain("metadata")
    expect(json).not.toContain("resultMetadata")
    expect(json).not.toContain("msg_")
    expect(json).not.toContain("prt_")
  })

  test("unknown message, assistant content, and tool state variants fail closed", () => {
    expect(() =>
      TranscriptV2Display.toDisplayTranscriptV2([{ ...user("unknown_message", 1), type: "future" } as unknown as SessionMessage.Message], {
        status: "ready",
      }),
    ).toThrow(TranscriptV2Display.DisplayTranscriptUnsupportedError)

    expect(() =>
      TranscriptV2Display.toDisplayTranscriptV2(
        [assistantRaw("unknown_content", 1, [{ type: "future", id: id("future_content") } as unknown as SessionMessage.AssistantContent])],
        { status: "ready" },
      ),
    ).toThrow(TranscriptV2Display.DisplayTranscriptUnsupportedError)

    expect(() =>
      TranscriptV2Display.toDisplayTranscriptV2(
        [assistantRaw("unknown_tool", 1, [toolRaw("future", { status: "future", input: {} } as unknown as SessionMessage.ToolState)])],
        { status: "ready" },
      ),
    ).toThrow(TranscriptV2Display.DisplayTranscriptUnsupportedError)
  })

  test("legacy-looking IDs fail closed instead of leaking raw message or part IDs", () => {
    expect(() =>
      TranscriptV2Display.toDisplayTranscriptV2([user("safe", 1, { id: EventV2.ID.make("msg_legacy") })], { status: "ready" }),
    ).toThrow(TranscriptV2Display.DisplayTranscriptUnsupportedError)

    expect(() =>
      TranscriptV2Display.toDisplayTranscriptV2([assistant("legacy_part", 1, [text("legacy", "oops", EventV2.ID.make("prt_legacy"))])], {
        status: "ready",
      }),
    ).toThrow(TranscriptV2Display.DisplayTranscriptUnsupportedError)
  })

  test("decodes SDK-wire v2 rows to display messages with numeric times and canonical ordering", () => {
    const output = TranscriptV2Display.toDisplayTranscriptV2FromWire(wireMessages(), { status: "ready" })

    expect(output.map((message) => message.type)).toStrictEqual(["user", "assistant", "compaction"])
    expect(output.map((message) => message.id)).toStrictEqual([id("wire_user"), id("wire_assistant"), id("wire_compaction")])
    expect(output[0]).toMatchObject({ type: "user", time: { created: 1000 }, text: "wire prompt" })
    expect(output[2]).toMatchObject({ type: "compaction", time: { created: 3000 }, include: id("wire_user") })

    const assistantOutput = output[1]
    if (assistantOutput.type !== "assistant") throw new Error("expected assistant output")
    expect(assistantOutput.time).toStrictEqual({ created: 2000, completed: 2600 })
    expect(assistantOutput.content).toMatchObject([
      { type: "text", id: id("wire_text"), text: "wire answer" },
      { type: "tool", id: id("wire_tool"), state: { status: "completed" } },
    ])
    const toolOutput = assistantOutput.content[1]
    if (toolOutput.type !== "tool") throw new Error("expected tool output")
    expect(toolOutput.time).toStrictEqual({ created: 2100, ran: 2200, completed: 2300, pruned: 2400 })
    expect(toolOutput.state).toMatchObject({
      status: "completed",
      input: { command: "pwd" },
      structured: { ok: true },
      content: [{ type: "text", text: "/work" }],
    })
    expectNoLegacyIDs(output)
  })

  test("wire display readiness is checked before malformed rows", () => {
    expect(() => TranscriptV2Display.toDisplayTranscriptV2FromWire([{ type: "not-valid" }], { status: "upgrade_pending" })).toThrow(
      TranscriptV2Display.DisplayTranscriptNotReadyError,
    )
  })

  test("malformed ready wire rows fail with a display decode error", () => {
    expect(() => TranscriptV2Display.toDisplayTranscriptV2FromWire([{ type: "not-valid" }], { status: "ready" })).toThrow(
      TranscriptV2Display.DisplayTranscriptDecodeError,
    )
  })

  test("legacy-looking SDK-wire IDs fail closed at the display boundary", () => {
    const [message] = wireMessages()
    expect(() => TranscriptV2Display.toDisplayTranscriptV2FromWire([{ ...message, id: "msg_legacy" }], { status: "ready" })).toThrow(
      TranscriptV2Display.DisplayTranscriptUnsupportedError,
    )

    const assistantMessage = wireMessages()[1]
    if (assistantMessage.type !== "assistant") throw new Error("expected assistant wire message")
    expect(() =>
      TranscriptV2Display.toDisplayTranscriptV2FromWire(
        [{ ...assistantMessage, content: [{ type: "text", id: "prt_legacy", text: "oops" }] }],
        { status: "ready" },
      ),
    ).toThrow(TranscriptV2Display.DisplayTranscriptUnsupportedError)
  })

  test("source-purity guard does not import legacy readers or database services", async () => {
    const source = await Bun.file(new URL("../../src/session/transcript-v2-display.ts", import.meta.url)).text()

    for (const blocked of ["MessageV2", "SessionLegacy", "MessageTable", "PartTable", "database service", "Database.Service"]) {
      expect(source).not.toContain(blocked)
    }
  })
})

function id(suffix: string) {
  return EventV2.ID.make(`evt_display_${suffix}`)
}

function time(value: number) {
  return DateTime.makeUnsafe(value)
}

function user(suffix: string, created: number, input?: Partial<SessionMessage.User>): SessionMessage.User {
  return new SessionMessage.User({
    type: "user",
    id: id(suffix),
    text: suffix,
    files: [],
    agents: [],
    references: [],
    time: { created: time(created) },
    ...input,
  })
}

function assistant(
  suffix: string,
  created: number,
  content: SessionMessage.AssistantContent[],
  input?: Partial<SessionMessage.Assistant>,
): SessionMessage.Assistant {
  return new SessionMessage.Assistant({
    type: "assistant",
    id: id(suffix),
    agent: "build",
    model,
    content,
    time: { created: time(created) },
    ...input,
  })
}

function assistantRaw(
  suffix: string,
  created: number,
  content: SessionMessage.AssistantContent[],
): SessionMessage.Assistant {
  return {
    type: "assistant",
    id: id(suffix),
    agent: "build",
    model,
    content,
    time: { created: time(created) },
  } as SessionMessage.Assistant
}

function text(suffix: string, value = suffix, overrideID?: EventV2.ID) {
  return new SessionMessage.AssistantText({ type: "text", id: overrideID ?? id(`text_${suffix}`), text: value })
}

function reasoning(suffix: string, value = suffix) {
  return new SessionMessage.AssistantReasoning({
    type: "reasoning",
    id: id(`reasoning_${suffix}`),
    reasoningID: `reasoning-${suffix}`,
    text: value,
  })
}

function patch(suffix: string) {
  return new SessionMessage.AssistantPatch({ type: "patch", id: id(`patch_${suffix}`), hash: `hash-${suffix}`, files: ["README.md"] })
}

function tool(suffix: string, state: SessionMessage.ToolState) {
  return new SessionMessage.AssistantTool({
    type: "tool",
    id: id(`tool_${suffix}`),
    callID: `call-${suffix}`,
    name: "bash",
    title: `Tool ${suffix}`,
    provider: {
      executed: true,
      metadata: { provider: { secret: `msg_provider_${suffix}` } },
      resultMetadata: { provider: { secret: `prt_provider_${suffix}` } },
    },
    state,
    time: { created: time(4), ran: time(5), completed: time(6), pruned: time(7) },
  })
}

function toolRaw(suffix: string, state: SessionMessage.ToolState) {
  return {
    type: "tool",
    id: id(`tool_${suffix}`),
    callID: `call-${suffix}`,
    name: "bash",
    state,
    time: { created: time(4) },
  } as SessionMessage.AssistantTool
}

function wireMessages() {
  return [
    {
      type: "compaction",
      id: id("wire_compaction"),
      reason: "manual",
      summary: "wire summary",
      include: id("wire_user"),
      metadata: { secret: "msg_metadata" },
      time: { created: 3000 },
    },
    {
      type: "assistant",
      id: id("wire_assistant"),
      agent: "build",
      model: { providerID: "provider", id: "model", variant: "default" },
      content: [
        { type: "text", id: id("wire_text"), text: "wire answer" },
        {
          type: "tool",
          id: id("wire_tool"),
          callID: "call-wire",
          name: "bash",
          title: "Run pwd",
          provider: {
            executed: true,
            metadata: { secret: "msg_provider" },
            resultMetadata: { secret: "prt_provider" },
          },
          state: {
            status: "completed",
            input: { command: "pwd" },
            structured: { ok: true },
            content: [{ type: "text", text: "/work" }],
          },
          time: { created: 2100, ran: 2200, completed: 2300, pruned: 2400 },
        },
      ],
      retries: [{ attempt: 1, error: { message: "retry", isRetryable: true }, time: { created: 2050 } }],
      time: { created: 2000, completed: 2600 },
    },
    {
      type: "user",
      id: id("wire_user"),
      text: "wire prompt",
      files: [],
      agents: [],
      references: [],
      taskRequests: [
        {
          type: "task-request",
          id: id("wire_task"),
          prompt: "delegate",
          description: "delegate work",
          agent: "build",
          command: "task",
        },
      ],
      metadata: { secret: "prt_metadata" },
      time: { created: 1000 },
    },
  ] satisfies WireSessionMessage[]
}

function expectNoLegacyIDs(value: unknown) {
  const json = JSON.stringify(value)
  expect(json).not.toContain("msg_")
  expect(json).not.toContain("prt_")
}
