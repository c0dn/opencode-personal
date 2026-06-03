import { describe, expect, test } from "bun:test"
import { EventV2 } from "@opencode-ai/core/event"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { FileAttachment } from "@opencode-ai/core/session/prompt"
import { ToolOutput } from "@opencode-ai/core/tool-output"
import { DateTime } from "effect"
import type { CompactionV2Context } from "../../src/session/compaction-v2-context"
import { CompactionV2Prompt, SUMMARY_TEMPLATE, TOOL_OUTPUT_MAX_CHARS } from "../../src/session/compaction-v2-prompt"

const model = {
  providerID: ProviderV2.ID.make("provider"),
  id: ModelV2.ID.make("model"),
  variant: ModelV2.VariantID.make("default"),
}

function id(suffix: string) {
  return EventV2.ID.make(`evt_${suffix}`)
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
  content: SessionMessage.AssistantContent[],
  input?: Partial<SessionMessage.Assistant>,
): SessionMessage.Assistant {
  return new SessionMessage.Assistant({
    id: id(suffix),
    type: "assistant",
    agent: "build",
    model,
    content,
    time: { created: DateTime.makeUnsafe(time) },
    ...input,
  })
}

function text(suffix: string, value: string): SessionMessage.AssistantText {
  return new SessionMessage.AssistantText({ id: id(suffix), type: "text", text: value })
}

function patch(suffix: string): SessionMessage.AssistantPatch {
  return new SessionMessage.AssistantPatch({ id: id(suffix), type: "patch", hash: suffix, files: ["README.md"] })
}

function completedTool(input?: Partial<SessionMessage.AssistantTool>): SessionMessage.AssistantTool {
  return new SessionMessage.AssistantTool({
    id: id("tool"),
    type: "tool",
    callID: "call-1",
    name: "bash",
    time: { created: DateTime.makeUnsafe(2), completed: DateTime.makeUnsafe(3) },
    state: new SessionMessage.ToolStateCompleted({
      status: "completed",
      input: { cmd: "run" },
      structured: {},
      content: [new ToolOutput.TextContent({ type: "text", text: "ok" })],
    }),
    ...input,
  })
}

describe("session.compaction-v2-prompt", () => {
  test("no previous summary prompt includes create-anchor wording", () => {
    const prompt = CompactionV2Prompt.buildPrompt()

    expect(prompt).toStartWith("Create a new anchored summary from the conversation history above.")
    expect(prompt).toContain(SUMMARY_TEMPLATE)
  })

  test("with previous summary prompt embeds wrapper and summary appears exactly once", () => {
    const previousSummary = "Existing anchored facts"
    const prompt = CompactionV2Prompt.buildPrompt({ previousSummary })

    expect(prompt).toContain("Update the anchored summary below using the conversation history above.")
    expect(prompt).toContain(`<previous-summary>\n${previousSummary}\n</previous-summary>`)
    expect(prompt.split(previousSummary)).toHaveLength(2)
  })

  test("context strings append after SUMMARY_TEMPLATE in order", () => {
    const first = "First extra context"
    const second = "Second extra context"
    const prompt = CompactionV2Prompt.buildPrompt({ context: [first, second] })

    expect(prompt.endsWith(`${SUMMARY_TEMPLATE}\n\n${first}\n\n${second}`)).toBe(true)
  })

  test("promptOverride replaces generated template and context", () => {
    const prompt = CompactionV2Prompt.buildPrompt({
      previousSummary: "do not include",
      context: ["do not append"],
      promptOverride: "custom prompt",
    })

    expect(prompt).toBe("custom prompt")
  })

  test("assembly converts selection.head only, not selection.history", async () => {
    const selected: CompactionV2Context.Selection = {
      history: [user("history_only", 1, { text: "history-only intent" }), user("head", 2, { text: "head intent" })],
      head: [user("head", 2, { text: "head intent" })],
      previousSummary: undefined,
    }

    const messages = await CompactionV2Prompt.toProviderMessages(selected)

    expect(messages).toHaveLength(2)
    expect(messages[0]).toStrictEqual({ role: "user", content: [{ type: "text", text: "head intent" }] })
    expect(JSON.stringify(messages)).not.toContain("history-only intent")
  })

  test("final appended user ModelMessage is last and contains the compaction prompt text", async () => {
    const messages = await CompactionV2Prompt.toProviderMessages({
      head: [user("head", 1, { text: "conversation" })],
      promptOverride: "compact now",
    })

    expect(messages.at(-1)).toStrictEqual({ role: "user", content: [{ type: "text", text: "compact now" }] })
  })

  test("conversion uses compaction media stripping and 2000 char tool output truncation", async () => {
    const longOutput = "a".repeat(TOOL_OUTPUT_MAX_CHARS + 1)
    const messages = await CompactionV2Prompt.toProviderMessages({
      head: [
        user("media", 1, {
          text: "look",
          files: [new FileAttachment({ uri: "data:image/png;base64,Zm9v", mime: "image/png", name: "image.png" })],
        }),
        assistant("assistant", 2, [
          completedTool({
            state: new SessionMessage.ToolStateCompleted({
              status: "completed",
              input: { cmd: "long" },
              structured: {},
              content: [
                new ToolOutput.TextContent({ type: "text", text: longOutput }),
                new ToolOutput.FileContent({ type: "file", uri: "data:image/png;base64,Zm9v", mime: "image/png", name: "image.png" }),
              ],
            }),
          }),
        ]),
      ],
      promptOverride: "prompt",
    })

    expect(messages[0]).toStrictEqual({
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "text", text: "[Attached image/png: image.png]" },
      ],
    })
    expect(messages[2]).toStrictEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call-1",
          toolName: "bash",
          output: {
            type: "text",
            value: `${"a".repeat(TOOL_OUTPUT_MAX_CHARS)}\n[Tool output truncated for compaction: omitted 1 chars]`,
          },
        },
      ],
    })
    expect(JSON.stringify(messages)).not.toContain('"type":"media"')
  })

  test("taskRequests and assistant patch content do not become provider intent", async () => {
    const taskRequest = new SessionMessage.UserTaskRequest({
      type: "task-request",
      id: id("task_request"),
      prompt: "delegate this",
      description: "review",
      agent: "reviewer",
    })
    const messages = await CompactionV2Prompt.toProviderMessages({
      head: [
        user("task", 1, { text: "", taskRequests: [taskRequest] }),
        assistant("patch", 2, [patch("patch_content")]),
      ],
      promptOverride: "provider prompt",
    })

    expect(messages).toStrictEqual([{ role: "user", content: [{ type: "text", text: "provider prompt" }] }])
    expect(JSON.stringify(messages)).not.toContain("delegate this")
    expect(JSON.stringify(messages)).not.toContain("README.md")
  })

  test("pure transform callback is the explicit chat-transform boundary", async () => {
    const messages = await CompactionV2Prompt.toProviderMessages({
      head: [user("before", 1, { text: "before transform" })],
      transform: () => [user("after", 2, { text: "after transform" })],
      promptOverride: "prompt",
    })

    expect(messages[0]).toStrictEqual({ role: "user", content: [{ type: "text", text: "after transform" }] })
    expect(JSON.stringify(messages)).not.toContain("before transform")
  })

  test("source boundary does not import or wire blocked runtime services", async () => {
    const source = await Bun.file(new URL("../../src/session/compaction-v2-prompt.ts", import.meta.url)).text()

    for (const forbidden of [
      "SessionCompaction",
      "SessionProcessor",
      "Plugin",
      "Session.Service",
      "SessionV2",
      "Database",
      "EventV2Bridge",
      "session/compaction",
      "session/prompt",
    ]) {
      expect(source).not.toContain(forbidden)
    }
  })
})
