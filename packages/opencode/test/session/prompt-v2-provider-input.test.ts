import { describe, expect, test } from "bun:test"
import { EventV2 } from "@opencode-ai/core/event"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { FileAttachment } from "@opencode-ai/core/session/prompt"
import { ToolOutput } from "@opencode-ai/core/tool-output"
import { DateTime } from "effect"
import BUILD_SWITCH from "../../src/session/prompt/build-switch.txt"
import PLAN_MODE from "../../src/session/prompt/plan-mode.txt"
import PROMPT_PLAN from "../../src/session/prompt/plan.txt"
import { PromptV2ProviderInput } from "../../src/session/prompt-v2-provider-input"

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
  input?: Partial<SessionMessage.Assistant>,
): SessionMessage.Assistant {
  return new SessionMessage.Assistant({
    id: id(suffix),
    type: "assistant",
    agent: "build",
    model,
    content: [],
    time: { created: DateTime.makeUnsafe(time), completed: DateTime.makeUnsafe(time + 1) },
    finish: "stop",
    ...input,
  })
}

function text(value: string, suffix = value) {
  return new SessionMessage.AssistantText({ id: id(`text_${suffix}`), type: "text", text: value })
}

function patch() {
  return new SessionMessage.AssistantPatch({ id: id("patch"), type: "patch", hash: "abc123", files: ["README.md"] })
}

function completedTool() {
  return new SessionMessage.AssistantTool({
    id: id("tool"),
    type: "tool",
    callID: "call-1",
    name: "bash",
    time: { created: DateTime.makeUnsafe(2), completed: DateTime.makeUnsafe(3) },
    state: new SessionMessage.ToolStateCompleted({
      status: "completed",
      input: { cmd: "pwd" },
      structured: {},
      content: [new ToolOutput.TextContent({ type: "text", text: "done" })],
    }),
  })
}

function compaction(suffix: string, time: number, input?: Partial<SessionMessage.Compaction>): SessionMessage.Compaction {
  return new SessionMessage.Compaction({
    id: id(suffix),
    type: "compaction",
    reason: "manual",
    summary: suffix,
    time: { created: DateTime.makeUnsafe(time) },
    ...input,
  })
}

describe("session.prompt-v2-provider-input", () => {
  test("does not mutate original canonical messages", () => {
    const first = user("first", 1)
    const done = assistant("done", 2)
    const latest = user("latest", 3)
    const messages = [latest, done, first]

    const prepared = PromptV2ProviderInput.prepareMessages({
      messages,
      agentName: "plan",
      step: 2,
      experimentalPlanMode: false,
    })

    expect(messages).toStrictEqual([latest, done, first])
    expect(latest.text).toBe("latest")
    expect(prepared).not.toBe(messages)
    expect(prepared.find((message) => message.id === latest.id)).not.toBe(latest)
  })

  test("non-plan plan reminder and build-after-plan reminder append to latest user", () => {
    const planPrepared = PromptV2ProviderInput.prepareMessages({
      messages: [user("ask", 1)],
      agentName: "plan",
      step: 1,
      experimentalPlanMode: false,
    })
    expect((planPrepared.at(-1) as SessionMessage.User).text).toBe(`ask\n${PROMPT_PLAN}`)

    const buildPrepared = PromptV2ProviderInput.prepareMessages({
      messages: [user("ask", 1), assistant("planned", 2, { agent: "plan" }), user("next", 3)],
      agentName: "build",
      step: 1,
      experimentalPlanMode: false,
    })
    expect((buildPrepared.at(-1) as SessionMessage.User).text).toBe(`next\n${BUILD_SWITCH}`)
  })

  test("step>1 wraps user text before appending plan and build reminders outside the wrapper", () => {
    const planUser = latestUserText(
      PromptV2ProviderInput.prepareMessages({
        messages: [assistant("done", 1), user("latest", 2)],
        agentName: "plan",
        step: 2,
        experimentalPlanMode: false,
      }),
    )
    expect(planUser).toContain("</system-reminder>\n<system-reminder>\n# Plan Mode - System Reminder")
    expect(systemReminderBody(planUser)).not.toContain("# Plan Mode - System Reminder")

    const buildUser = latestUserText(
      PromptV2ProviderInput.prepareMessages({
        messages: [assistant("planned", 1, { agent: "plan" }), user("latest", 2)],
        agentName: "build",
        step: 2,
        experimentalPlanMode: false,
      }),
    )
    expect(buildUser).toContain(`</system-reminder>\n${BUILD_SWITCH}`)
    expect(systemReminderBody(buildUser)).not.toContain("Your operational mode has changed from plan to build")
  })

  test("experimental plan mode appends plan/build text with injected plan path and existence", () => {
    const planPath = "/tmp/work/.opencode/plan.md"
    const planPrepared = PromptV2ProviderInput.prepareMessages({
      messages: [assistant("build", 1, { agent: "build" }), user("latest", 2)],
      agentName: "plan",
      step: 1,
      experimentalPlanMode: true,
      plan: { path: planPath, exists: false },
    })
    expect(latestUserText(planPrepared)).toBe(
      `latest\n${PLAN_MODE.replace("${planInfo}", `No plan file exists yet. You should create your plan at ${planPath} using the write tool.`)}`,
    )

    const buildPrepared = PromptV2ProviderInput.prepareMessages({
      messages: [assistant("plan", 1, { agent: "plan" }), user("latest", 2)],
      agentName: "build",
      step: 1,
      experimentalPlanMode: true,
      plan: { path: planPath, exists: true },
    })
    expect(latestUserText(buildPrepared)).toBe(
      `latest\n${BUILD_SWITCH}\n\nA plan file exists at ${planPath}. You should execute on the plan defined within it`,
    )
  })

  test("system-reminder wraps only users after latest finished assistant using canonical chronological order", () => {
    const olderUnfinished = assistant("zz_older_unfinished", 1, { time: { created: DateTime.makeUnsafe(1) } })
    const latestFinished = assistant("aa_latest_finished", 3)
    const beforeLatestFinished = user("before", 2)
    const afterLatestFinished = user("after", 4)

    const prepared = PromptV2ProviderInput.prepareMessages({
      messages: [afterLatestFinished, latestFinished, beforeLatestFinished, olderUnfinished],
      agentName: "build",
      step: 2,
      experimentalPlanMode: false,
    })

    expect(userText(prepared, beforeLatestFinished.id)).toBe("before")
    expect(userText(prepared, afterLatestFinished.id)).toBe(systemWrapped("after"))
  })

  test("source boundary and policy markers are explicit", async () => {
    const source = await Bun.file(new URL("../../src/session/prompt-v2-provider-input.ts", import.meta.url)).text()

    expect(source).not.toContain("SessionLegacy")
    expect(source).not.toContain('from "./message-v2"')
    expect(source).not.toContain("Plugin")
    expect(source).not.toContain("experimental.chat.messages.transform")
    expect(PromptV2ProviderInput.LegacyTransformPolicy).toBe("not-applied-to-v2-provider-input")
    expect(PromptV2ProviderInput.MaxStepOverlayPolicy).toBe("production-wiring-appends-max-steps")
  })

  test("toProviderMessages ignores taskRequests and assistant patch content via MessageV2Model", async () => {
    const result = await PromptV2ProviderInput.toProviderMessages({
      messages: [
        user("task", 1, {
          text: "visible",
          taskRequests: [
            new SessionMessage.UserTaskRequest({
              type: "task-request",
              id: id("task_request"),
              prompt: "hidden",
              description: "review",
              agent: "reviewer",
            }),
          ],
        }),
        assistant("answer", 2, { content: [patch(), text("kept")] }),
      ],
      agentName: "build",
      step: 1,
      experimentalPlanMode: false,
    })

    expect(result).toStrictEqual([
      { role: "user", content: [{ type: "text", text: "visible" }] },
      { role: "assistant", content: [{ type: "text", text: "kept" }] },
    ])
  })

  test("compaction summary is provider-visible and retained tail remains provider-visible", async () => {
    const retained = user("retained", 2, { text: "retained user" })
    const beforeAnchor = assistant("before_anchor", 3, { content: [text("retained assistant", "retained_assistant")] })
    const anchor = compaction("anchor", 4, { summary: "summary so far", include: retained.id })
    const tail = user("tail", 5, { text: "tail user" })

    const result = await PromptV2ProviderInput.toProviderMessages({
      messages: [tail, anchor, beforeAnchor, retained, user("dropped", 1, { text: "dropped user" })],
      agentName: "build",
      step: 1,
      experimentalPlanMode: false,
    })

    expect(result).toStrictEqual([
      { role: "user", content: [{ type: "text", text: "What did we do so far?" }] },
      { role: "assistant", content: [{ type: "text", text: "summary so far" }] },
      { role: "user", content: [{ type: "text", text: "retained user" }] },
      { role: "assistant", content: [{ type: "text", text: "retained assistant" }] },
      { role: "user", content: [{ type: "text", text: "tail user" }] },
    ])
  })

  test("completed tool and media conversion still flow through MessageV2Model", async () => {
    const result = await PromptV2ProviderInput.toProviderMessages({
      messages: [
        user("media", 1, {
          text: "see file",
          files: [new FileAttachment({ uri: "data:text/plain;base64,aGk=", mime: "text/plain", name: "note.txt" })],
        }),
        assistant("tool", 2, { content: [completedTool()] }),
      ],
      agentName: "build",
      step: 1,
      experimentalPlanMode: false,
    })

    expect(result).toStrictEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "see file" },
          { type: "file", mediaType: "text/plain", filename: "note.txt", data: "data:text/plain;base64,aGk=" },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "call-1", toolName: "bash", input: { cmd: "pwd" }, providerExecuted: undefined }],
      },
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "call-1", toolName: "bash", output: { type: "text", value: "done" } }],
      },
    ])
  })

  test("toProviderMessages passes MessageV2Model options through", async () => {
    const result = await PromptV2ProviderInput.toProviderMessages(
      {
        messages: [
          user("media", 1, {
            text: "see file",
            files: [new FileAttachment({ uri: "data:image/png;base64,Zm9v", mime: "image/png", name: "image.png" })],
          }),
        ],
        agentName: "build",
        step: 1,
        experimentalPlanMode: false,
      },
      { stripMedia: true },
    )

    expect(result).toStrictEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "see file" },
          { type: "text", text: "[Attached image/png: image.png]" },
        ],
      },
    ])
  })
})

function latestUserText(messages: SessionMessage.Message[]) {
  const found = messages.findLast((message): message is SessionMessage.User => message.type === "user")
  if (!found) throw new Error("missing latest user")
  return found.text
}

function userText(messages: SessionMessage.Message[], id: SessionMessage.ID) {
  const found = messages.find((message): message is SessionMessage.User => message.type === "user" && message.id === id)
  if (!found) throw new Error(`missing user ${id}`)
  return found.text
}

function systemReminderBody(input: string) {
  const start = input.indexOf("<system-reminder>")
  const end = input.indexOf("</system-reminder>")
  return input.slice(start, end + "</system-reminder>".length)
}

function systemWrapped(value: string) {
  return `<system-reminder>\nThe user sent the following message:\n${value}\n\nPlease address this message and continue with your tasks.\n</system-reminder>`
}
