import { expect } from "bun:test"
import { EventV2 } from "@opencode-ai/core/event"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionLegacy } from "@opencode-ai/core/session/legacy"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { FileAttachment } from "@opencode-ai/core/session/prompt"
import { ToolOutput } from "@opencode-ai/core/tool-output"
import type { ModelMessage } from "ai"
import { DateTime } from "effect"
import type { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import type { MessageV2Context } from "../../src/session/message-v2-context"
import type { Provider } from "@/provider/provider"

export const sessionID = SessionID.make("session_semantic_fixture")
export const providerID = ProviderV2.ID.make("provider")
export const modelRef = {
  providerID,
  id: ModelV2.ID.make("model"),
  variant: ModelV2.VariantID.make("default"),
}
export const legacyModel: Provider.Model = {
  id: ProviderV2.ModelID.make("model"),
  providerID,
  api: {
    id: "model",
    url: "https://example.com",
    npm: "@ai-sdk/openai",
  },
  name: "Semantic Model",
  capabilities: {
    temperature: true,
    reasoning: true,
    attachment: true,
    toolcall: true,
    input: { text: true, audio: false, image: true, video: false, pdf: false },
    output: { text: true, audio: false, image: true, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 0, input: 0, output: 0 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
}

export const modelFixture = (() => {
  const legacyUserID = MessageID.make("msg_model_user")
  const legacyAssistantID = MessageID.make("msg_model_assistant")

  const v2User = user("model_user", 1, {
    text: "Run the check",
    files: [new FileAttachment({ uri: "data:image/png;base64,aW1hZ2U=", mime: "image/png", name: "input.png" })],
    taskRequests: [
      new SessionMessage.UserTaskRequest({
        type: "task-request",
        id: v2ID("model_user_task_request"),
        prompt: "legacy subtask prompt must not be provider context",
        description: "review",
        agent: "reviewer",
      }),
    ],
  })
  const v2Assistant = assistant("model_assistant", 2, [
    new SessionMessage.AssistantReasoning({
      type: "reasoning",
      id: v2ID("model_assistant_reasoning"),
      reasoningID: "reasoning-1",
      text: "Thinking",
    }),
    new SessionMessage.AssistantText({ type: "text", id: v2ID("model_assistant_text"), text: "Done" }),
    new SessionMessage.AssistantTool({
      type: "tool",
      id: v2ID("model_assistant_tool"),
      callID: "call-1",
      name: "bash",
      title: "Run command",
      time: { created: DateTime.makeUnsafe(2), completed: DateTime.makeUnsafe(3) },
      state: new SessionMessage.ToolStateCompleted({
        status: "completed",
        input: { cmd: "ls" },
        structured: {},
        content: [
          new ToolOutput.TextContent({ type: "text", text: "ok" }),
          new ToolOutput.FileContent({
            type: "file",
            uri: "data:image/png;base64,dG9vbC1pbWFnZQ==",
            mime: "image/png",
            name: "tool.png",
          }),
        ],
      }),
    }),
    new SessionMessage.AssistantPatch({
      type: "patch",
      id: v2ID("model_assistant_patch"),
      hash: "abc123",
      files: ["README.md"],
    }),
  ])

  return {
    legacy: [
      {
        info: legacyUser(legacyUserID, 1),
        parts: [
          legacyPart(legacyUserID, "model_user_text", { type: "text", text: "Run the check" }),
          legacyPart(legacyUserID, "model_user_file", {
            type: "file",
            mime: "image/png",
            filename: "input.png",
            url: "data:image/png;base64,aW1hZ2U=",
          }),
          legacyPart(legacyUserID, "model_user_compaction_artifact", { type: "compaction", auto: true }),
          legacyPart(legacyUserID, "model_user_subtask_artifact", {
            type: "subtask",
            prompt: "legacy subtask prompt must not be provider context",
            description: "review",
            agent: "reviewer",
          }),
        ] as SessionLegacy.Part[],
      },
      {
        info: legacyAssistant(legacyAssistantID, legacyUserID, 2, { finish: "stop" }),
        parts: [
          legacyPart(legacyAssistantID, "model_assistant_reasoning", {
            type: "reasoning",
            text: "Thinking",
            time: { start: 2, end: 2 },
            metadata: { openai: { signature: "legacy-only-metadata" } },
          }),
          legacyPart(legacyAssistantID, "model_assistant_text", {
            type: "text",
            text: "Done",
            metadata: { openai: { text: "legacy-only-metadata" } },
          }),
          legacyPart(legacyAssistantID, "model_assistant_tool", {
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "completed",
              input: { cmd: "ls" },
              output: "ok",
              title: "Run command",
              metadata: {},
              time: { start: 2, end: 3 },
              attachments: [
                legacyPart(legacyAssistantID, "model_assistant_tool_file", {
                  type: "file",
                  mime: "image/png",
                  filename: "tool.png",
                  url: "data:image/png;base64,dG9vbC1pbWFnZQ==",
                }),
              ],
            },
            metadata: { openai: { signature: "legacy-only-metadata" } },
          }),
        ] as SessionLegacy.Part[],
      },
    ] satisfies SessionLegacy.WithParts[],
    // Deliberately reversed to prove v2 helpers sort by canonical time/id rather than caller order.
    v2: [v2Assistant, v2User] satisfies SessionMessage.Message[],
  }
})()

export const contextFixture = (() => {
  const retainedUserID = MessageID.make("msg_context_001_retained_user")
  const droppedUserID = MessageID.make("msg_context_000_dropped_user")
  const beforeAnchorAssistantID = MessageID.make("msg_context_002_before_anchor_assistant")
  const compactionUserID = MessageID.make("msg_context_003_compaction_user")
  const summaryAssistantID = MessageID.make("msg_context_004_summary_assistant")
  const laterUserID = MessageID.make("msg_context_005_later_user")
  const latestAssistantID = MessageID.make("msg_context_006_latest_assistant")
  const freshTaskUserID = MessageID.make("msg_context_007_fresh_task_user")

  const v2Dropped = user("context_000_dropped_user", 1, { text: "drop me" })
  const v2Retained = user("context_001_retained_user", 2, { text: "keep me" })
  const v2BeforeAnchor = assistant("context_002_before_anchor_assistant", 3, [
    new SessionMessage.AssistantText({ type: "text", id: v2ID("context_002_text"), text: "before compaction" }),
  ], { finish: "stop" })
  const v2Compaction = new SessionMessage.Compaction({
    type: "compaction",
    id: v2ID("context_003_compaction"),
    reason: "manual",
    summary: "summary text",
    include: v2Retained.id,
    time: { created: DateTime.makeUnsafe(4) },
  })
  const v2LaterUser = user("context_005_later_user", 5, { text: "continue" })
  const v2LatestAssistant = assistant(
    "context_006_latest_assistant",
    6,
    [new SessionMessage.AssistantText({ type: "text", id: v2ID("context_006_text"), text: "latest answer" })],
    { finish: "stop", time: { created: DateTime.makeUnsafe(6), completed: DateTime.makeUnsafe(7) } },
  )
  const v2FreshTaskUser = user("context_007_fresh_task_user", 8, {
    text: "",
    taskRequests: [
      new SessionMessage.UserTaskRequest({
        type: "task-request",
        id: v2ID("context_007_task_request"),
        prompt: "fresh task metadata",
        description: "review",
        agent: "reviewer",
      }),
    ],
  })

  return {
    labels: {
      dropped: v2Dropped.id,
      retained: v2Retained.id,
      beforeAnchor: v2BeforeAnchor.id,
      compaction: v2Compaction.id,
      laterUser: v2LaterUser.id,
      latestAssistant: v2LatestAssistant.id,
      freshTaskUser: v2FreshTaskUser.id,
    },
    legacyLabels: {
      [droppedUserID]: "dropped",
      [retainedUserID]: "retained",
      [beforeAnchorAssistantID]: "beforeAnchor",
      [compactionUserID]: "compaction",
      [summaryAssistantID]: "summary",
      [laterUserID]: "laterUser",
      [latestAssistantID]: "latestAssistant",
      [freshTaskUserID]: "freshTaskUser",
    } satisfies Record<string, string>,
    v2Labels: {
      [v2Dropped.id]: "dropped",
      [v2Retained.id]: "retained",
      [v2BeforeAnchor.id]: "beforeAnchor",
      [v2Compaction.id]: "compaction",
      [v2LaterUser.id]: "laterUser",
      [v2LatestAssistant.id]: "latestAssistant",
      [v2FreshTaskUser.id]: "freshTaskUser",
    } satisfies Record<string, string>,
    legacy: [
      {
        info: legacyUser(droppedUserID, 1),
        parts: [legacyPart(droppedUserID, "context_dropped_text", { type: "text", text: "drop me" })] as SessionLegacy.Part[],
      },
      {
        info: legacyUser(retainedUserID, 2),
        parts: [legacyPart(retainedUserID, "context_retained_text", { type: "text", text: "keep me" })] as SessionLegacy.Part[],
      },
      {
        info: legacyAssistant(beforeAnchorAssistantID, retainedUserID, 3, { finish: "stop" }),
        parts: [
          legacyPart(beforeAnchorAssistantID, "context_before_anchor_text", { type: "text", text: "before compaction" }),
        ] as SessionLegacy.Part[],
      },
      {
        info: legacyUser(compactionUserID, 4),
        parts: [
          legacyPart(compactionUserID, "context_compaction", {
            type: "compaction",
            auto: true,
            tail_start_id: retainedUserID,
          }),
        ] as SessionLegacy.Part[],
      },
      {
        info: legacyAssistant(summaryAssistantID, compactionUserID, 4, { summary: true, finish: "stop" }),
        parts: [legacyPart(summaryAssistantID, "context_summary_text", { type: "text", text: "summary text" })] as SessionLegacy.Part[],
      },
      {
        info: legacyUser(laterUserID, 5),
        parts: [legacyPart(laterUserID, "context_later_text", { type: "text", text: "continue" })] as SessionLegacy.Part[],
      },
      {
        info: legacyAssistant(latestAssistantID, laterUserID, 6, { finish: "stop", time: { created: 6, completed: 7 } }),
        parts: [legacyPart(latestAssistantID, "context_latest_text", { type: "text", text: "latest answer" })] as SessionLegacy.Part[],
      },
      {
        info: legacyUser(freshTaskUserID, 8),
        parts: [
          legacyPart(freshTaskUserID, "context_fresh_task", {
            type: "subtask",
            prompt: "fresh task metadata",
            description: "review",
            agent: "reviewer",
          }),
        ] as SessionLegacy.Part[],
      },
    ] satisfies SessionLegacy.WithParts[],
    // Deliberately reversed to cover same fixture semantics against unsorted v2 reads.
    v2: [
      v2FreshTaskUser,
      v2LatestAssistant,
      v2LaterUser,
      v2Compaction,
      v2BeforeAnchor,
      v2Retained,
      v2Dropped,
    ] satisfies SessionMessage.Message[],
  }
})()

export function modelSemantic(messages: ModelMessage[]) {
  return messages.flatMap((message) => {
    const rawContent = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content
    const content = rawContent
      .map((part: unknown) => normalizeModelPart(part))
      .filter((part) => !isLegacyPromptArtifact(part))
    return content.length === 0 ? [] : [{ role: message.role, content }]
  })
}

export function contextSemantic(
  messages: readonly SessionMessage.Message[] | readonly SessionLegacy.WithParts[],
  labels: Record<string, string>,
) {
  return Array.from(messages as readonly unknown[]).flatMap((message): ContextEntry[] => {
    if (!message || typeof message !== "object") return []
    if ("info" in message) return legacyContextEntry(message as SessionLegacy.WithParts, labels)
    return v2ContextEntry(message as SessionMessage.Message, labels)
  })
}

export function compactLegacyCompactionSummary(entries: ContextEntry[]) {
  return entries.flatMap((entry, index) => {
    if (entry.kind === "compaction-summary") return []
    if (entry.kind !== "compaction") return [entry]
    const summary = entries[index + 1]
    return [{ ...entry, summary: summary?.kind === "compaction-summary" ? summary.summary : undefined }]
  })
}

export function latestSemantic(input: MessageV2Context.Latest | ReturnType<typeof MessageV2.latest>, labels: Record<string, string>) {
  const latest = input as MessageV2Context.Latest & ReturnType<typeof MessageV2.latest>
  return {
    user: latest.user ? labels[latest.user.id] : undefined,
    assistant: latest.assistant ? labels[latest.assistant.id] : undefined,
    finishedAssistant: latest.finishedAssistant
      ? labels[latest.finishedAssistant.id]
      : latest.finished
        ? labels[latest.finished.id]
        : undefined,
  }
}

export function expectNoLegacyIDs(value: unknown) {
  const seen = new Set<unknown>()
  const visit = (input: unknown) => {
    if (typeof input === "string") expect(input).not.toMatch(/(?:^|[^A-Za-z0-9])(?:msg|prt)_/)
    if (!input || typeof input !== "object" || seen.has(input)) return
    seen.add(input)
    for (const nested of Array.isArray(input) ? input : Object.values(input)) visit(nested)
  }
  visit(value)
}

function v2ID(suffix: string) {
  return EventV2.ID.make(`evt_legacy_backfill_m_${suffix}`)
}

function user(suffix: string, time: number, input: Partial<SessionMessage.User>): SessionMessage.User {
  return new SessionMessage.User({
    id: v2ID(suffix),
    type: "user",
    text: "",
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
    id: v2ID(suffix),
    type: "assistant",
    agent: "build",
    model: modelRef,
    content,
    time: { created: DateTime.makeUnsafe(time) },
    ...input,
  })
}

function legacyUser(id: MessageID, time: number): SessionLegacy.User {
  return {
    id,
    sessionID,
    role: "user",
    time: { created: time },
    agent: "user",
    model: { providerID, modelID: ProviderV2.ModelID.make("model") },
    tools: {},
    mode: "",
  } as unknown as SessionLegacy.User
}

function legacyAssistant(
  id: MessageID,
  parentID: MessageID,
  time: number,
  input?: Partial<SessionLegacy.Assistant>,
): SessionLegacy.Assistant {
  return {
    id,
    sessionID,
    role: "assistant",
    parentID,
    time: { created: time },
    providerID,
    modelID: legacyModel.api.id,
    mode: "",
    agent: "build",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ...input,
  } as unknown as SessionLegacy.Assistant
}

function legacyPart<T extends object>(messageID: MessageID, suffix: string, input: T) {
  return {
    id: PartID.make(`prt_${suffix}`),
    sessionID,
    messageID,
    ...input,
  }
}

type ContextEntry = Record<string, string | undefined>

function normalizeModelPart(part: unknown): unknown {
  if (!part || typeof part !== "object" || !("type" in part)) return part
  const value = part as Record<string, unknown>
  if (value.type === "text") return { type: "text", text: value.text }
  if (value.type === "file")
    return { type: "file", mediaType: value.mediaType, filename: value.filename, data: value.data }
  if (value.type === "reasoning") return { type: "reasoning", text: value.text }
  if (value.type === "tool-call") {
    return {
      type: "tool-call",
      toolCallId: value.toolCallId,
      toolName: value.toolName,
      input: value.input,
    }
  }
  if (value.type === "tool-result") {
    return { type: "tool-result", toolCallId: value.toolCallId, toolName: value.toolName, output: value.output }
  }
  return value
}

function isLegacyPromptArtifact(part: unknown) {
  const textPart = part as { type?: unknown; text?: unknown }
  return (
    textPart.type === "text" &&
    (textPart.text === "What did we do so far?" || textPart.text === "The following tool was executed by the user")
  )
}

function v2ContextEntry(message: SessionMessage.Message, labels: Record<string, string>) {
  if (message.type === "compaction") {
    return [{ kind: "compaction", label: labels[message.id], summary: message.summary, include: message.include ? labels[message.include] : undefined }]
  }
  if (message.type === "user") return [{ kind: "user", label: labels[message.id], text: message.text }]
  if (message.type === "assistant") return [{ kind: "assistant", label: labels[message.id], text: assistantText(message.content) }]
  return []
}

function legacyContextEntry(message: SessionLegacy.WithParts, labels: Record<string, string>) {
  const compaction = message.parts.find((part): part is SessionLegacy.CompactionPart => part.type === "compaction")
  if (compaction) {
    return [
      {
        kind: "compaction",
        label: labels[message.info.id],
        include: compaction.tail_start_id ? labels[compaction.tail_start_id] : undefined,
      },
    ]
  }
  if (message.info.role === "assistant" && message.info.summary) {
    return [{ kind: "compaction-summary", label: labels[message.info.id], summary: legacyText(message.parts) }]
  }
  return [{ kind: message.info.role, label: labels[message.info.id], text: legacyText(message.parts) }]
}

function assistantText(content: readonly SessionMessage.AssistantContent[]) {
  return content.filter((item) => item.type === "text").map((item) => item.text).join("")
}

function legacyText(parts: SessionLegacy.Part[]) {
  return parts.filter((part) => part.type === "text" || part.type === "reasoning").map((part) => part.text).join("")
}
