import { describe, expect, test } from "bun:test"
import type { PermissionRequest } from "@opencode-ai/sdk/v2"
import { replaySession, replaySessionV2 } from "@/cli/cmd/run/session-replay"
import type { SessionMessages } from "@/cli/cmd/run/session.shared"
import type { TranscriptV2Display } from "@/session/transcript-v2-display"

function userMessage(id: string, text: string): SessionMessages[number] {
  return {
    info: {
      id,
      sessionID: "session-1",
      role: "user",
      time: {
        created: 1,
      },
      agent: "build",
      model: {
        providerID: "openai",
        modelID: "gpt-5",
      },
    },
    parts: [
      {
        id: `${id}-text`,
        sessionID: "session-1",
        messageID: id,
        type: "text",
        text,
      },
    ],
  }
}

function assistantInfo(id: string) {
  return {
    id,
    sessionID: "session-1",
    role: "assistant" as const,
    time: {
      created: 2,
    },
    parentID: "msg-user-1",
    modelID: "gpt-5",
    providerID: "openai",
    mode: "chat",
    agent: "build",
    path: {
      cwd: "/tmp",
      root: "/tmp",
    },
    cost: 0,
    tokens: {
      input: 1,
      output: 1,
      reasoning: 0,
      cache: {
        read: 0,
        write: 0,
      },
    },
  }
}

function assistantMessage(id: string, text: string): SessionMessages[number] {
  return {
    info: assistantInfo(id),
    parts: [
      {
        id: `${id}-text`,
        sessionID: "session-1",
        messageID: id,
        type: "text",
        text,
        time: {
          start: 2,
          end: 3,
        },
      },
    ],
  }
}

function runningToolMessage(id: string): SessionMessages[number] {
  return {
    info: assistantInfo(id),
    parts: [
      {
        id: `${id}-tool`,
        sessionID: "session-1",
        messageID: id,
        type: "tool",
        callID: `${id}-call`,
        tool: "bash",
        state: {
          status: "running",
          input: {
            command: "pwd",
          },
          time: {
            start: 2,
          },
        },
      },
    ],
  }
}

describe("run session replay", () => {
  test("replays persisted user and assistant history into scrollback commits", () => {
    const out = replaySession({
      messages: [
        userMessage("msg-user-1", "Hello, whats the weather today?"),
        assistantMessage("msg-1", "What city or ZIP code should I check?"),
      ],
      permissions: [],
      questions: [],
      thinking: true,
      limits: {},
    })

    expect(out.commits).toEqual([
      expect.objectContaining({
        kind: "user",
        text: "Hello, whats the weather today?",
        phase: "start",
        source: "system",
        messageID: "msg-user-1",
      }),
      expect.objectContaining({
        kind: "assistant",
        text: "What city or ZIP code should I check?",
        phase: "progress",
        source: "assistant",
        messageID: "msg-1",
      }),
    ])
    expect(out.patch).toEqual(
      expect.objectContaining({
        phase: "idle",
        status: "",
      }),
    )
  })

  test("keeps the footer in a running state for resumed active tools", () => {
    const out = replaySession({
      messages: [runningToolMessage("msg-1")],
      permissions: [],
      questions: [],
      thinking: true,
      limits: {},
    })

    expect(out.patch).toEqual(
      expect.objectContaining({
        phase: "running",
        status: "running bash",
      }),
    )
  })

  test("replays v2 user and assistant text without legacy ids", () => {
    const out = replaySessionV2({
      messages: [
        v2User("evt-user-1", "Hello"),
        v2Assistant("evt-assistant-1", [{ type: "text", id: "evt-text-1", text: "Hi there" }]),
      ],
      permissions: [],
      questions: [],
      thinking: true,
      limits: {},
      sessionID: "session-1",
    })

    expect(out.commits).toEqual([
      expect.objectContaining({ kind: "user", text: "Hello", messageID: "evt-user-1" }),
      expect.objectContaining({ kind: "assistant", text: "Hi there", messageID: "evt-assistant-1", partID: "evt-text-1" }),
    ])
    expect(JSON.stringify(out.commits)).not.toContain("msg_")
    expect(JSON.stringify(out.commits)).not.toContain("prt_")
    expect(out.data.ids.has("evt-text-1")).toBe(true)
    expect(out.data.sent.has("evt-text-1")).toBe(false)
  })

  test("honors thinking flag for v2 reasoning", () => {
    const messages = [v2Assistant("evt-assistant-1", [{ type: "reasoning", id: "evt-reason-1", reasoningID: "r1", text: "work" }])]

    expect(
      replaySessionV2({ messages, permissions: [], questions: [], thinking: true, limits: {}, sessionID: "session-1" }).commits,
    ).toContainEqual(expect.objectContaining({ kind: "reasoning", text: "Thinking: work", partID: "evt-reason-1" }))
    expect(
      replaySessionV2({ messages, permissions: [], questions: [], thinking: false, limits: {}, sessionID: "session-1" }).commits,
    ).toEqual([])
  })

  test("seeds v2 running, completed, and error tool state", () => {
    const out = replaySessionV2({
      messages: [
        v2Assistant("evt-assistant-1", [
          v2Tool("evt-run", "running"),
          v2Tool("evt-done", "completed"),
          v2Tool("evt-error", "error"),
        ]),
      ],
      permissions: [],
      questions: [],
      thinking: true,
      limits: {},
      sessionID: "session-1",
    })

    expect(out.commits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "tool", partID: "evt-run", phase: "start", toolState: "running" }),
        expect.objectContaining({ kind: "tool", partID: "evt-done", toolState: "completed" }),
        expect.objectContaining({ kind: "tool", partID: "evt-error", toolState: "error", toolError: "boom" }),
      ]),
    )
    expect(out.patch).toEqual(expect.objectContaining({ phase: "running", status: "running bash" }))
    expect(out.data.tools.has("evt-run")).toBe(true)
    expect(out.data.ids.has("evt-done")).toBe(true)
    expect(out.data.ids.has("evt-error")).toBe(true)
  })

  test("enriches v2 replay permissions from matching tool calls", () => {
    const permission: PermissionRequest = {
      id: "perm-1",
      sessionID: "session-1",
      permission: "bash",
      patterns: ["*"],
      metadata: {},
      always: [],
      tool: { messageID: "evt-assistant-1", callID: "call-1" },
    }
    const out = replaySessionV2({
      messages: [v2Assistant("evt-assistant-1", [v2Tool("evt-run", "running")])],
      permissions: [permission],
      questions: [],
      thinking: true,
      limits: {},
      sessionID: "session-1",
    })

    expect(out.data.permissions).toEqual([
      expect.objectContaining({ id: "perm-1", metadata: { input: { command: "pwd" } } }),
    ])
  })

  test("preserves v2 task requests as completed task tool commits", () => {
    const out = replaySessionV2({
      messages: [
        {
          ...v2User("evt-user-1", "Run this"),
          taskRequests: [
            {
              type: "task-request",
              id: "evt-task-1",
              prompt: "Inspect replay",
              description: "Inspect replay state",
              agent: "explore",
            },
          ],
        },
      ],
      permissions: [],
      questions: [],
      thinking: true,
      limits: {},
      sessionID: "session-1",
    })

    expect(out.commits).toContainEqual(
      expect.objectContaining({
        kind: "tool",
        text: "Inspect replay state",
        messageID: "evt-user-1",
        partID: "evt-task-1",
        tool: "task",
        toolState: "completed",
      }),
    )
    expect(out.data.ids.has("evt-task-1")).toBe(true)
    expect(out.data.msg.get("evt-task-1")).toBe("evt-user-1")
  })

  test("preserves v2 patch, shell, compaction, and assistant error display", () => {
    const out = replaySessionV2({
      messages: [
        v2Assistant("evt-assistant-1", [{ type: "patch", id: "evt-patch-1", hash: "abc123", files: ["src/a.ts"] }], {
          error: { type: "unknown", message: "assistant failed" },
          finish: "error",
        }),
        v2Shell("evt-shell-1", "call-shell-1", "pwd", "/tmp"),
        v2Compaction("evt-compaction-1", "summary text"),
      ],
      permissions: [],
      questions: [],
      thinking: true,
      limits: {},
      sessionID: "session-1",
    })

    expect(out.commits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "error", text: "assistant failed", messageID: "evt-assistant-1" }),
        expect.objectContaining({ kind: "system", text: "Patch abc123\nsrc/a.ts", messageID: "evt-assistant-1" }),
        expect.objectContaining({ kind: "tool", tool: "bash", text: "/tmp", partID: "evt-shell-1", toolState: "completed" }),
        expect.objectContaining({ kind: "system", text: "summary text", messageID: "evt-compaction-1" }),
      ]),
    )
  })
})

function v2User(id: string, text: string): TranscriptV2Display.DisplayUser {
  return { type: "user", id, text, files: [], agents: [], references: [], time: { created: 1 } }
}

function v2Assistant(
  id: string,
  content: TranscriptV2Display.DisplayAssistantContent[],
  input?: Pick<TranscriptV2Display.DisplayAssistant, "error" | "finish">,
): TranscriptV2Display.DisplayAssistant {
  return {
    type: "assistant",
    id,
    agent: "build",
    model: { providerID: "openai" as never, id: "gpt-5" as never },
    content,
    ...input,
    time: { created: 2, completed: 3 },
  }
}

function v2Shell(id: string, callID: string, command: string, output: string): TranscriptV2Display.DisplayShell {
  return { type: "shell", id, callID, command, output, time: { created: 3, completed: 4 } }
}

function v2Compaction(id: string, summary: string): TranscriptV2Display.DisplayCompaction {
  return { type: "compaction", id, reason: "manual", summary, time: { created: 4, completed: 5 } }
}

function v2Tool(
  id: string,
  status: "running" | "completed" | "error",
): TranscriptV2Display.DisplayAssistantTool {
  return {
    type: "tool",
    id,
    callID: "call-1",
    name: "bash",
    state:
      status === "running"
        ? { status, input: { command: "pwd" }, structured: {}, content: [] }
        : status === "completed"
          ? { status, input: { command: "pwd" }, structured: {}, content: [{ type: "text", text: "out" }] }
          : { status, input: { command: "pwd" }, structured: {}, content: [], error: { type: "unknown", message: "boom" } },
    time: { created: 2, ran: 2, completed: status === "running" ? undefined : 3 },
  }
}
