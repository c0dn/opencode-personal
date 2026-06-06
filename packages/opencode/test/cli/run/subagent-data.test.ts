import { describe, expect, test } from "bun:test"
import type { Event, SessionMessage } from "@opencode-ai/sdk/v2"
import { entryBody } from "@/cli/cmd/run/entry.body"
import {
  bootstrapSubagentCalls,
  bootstrapSubagentData,
  clearFinishedSubagents,
  createSubagentData,
  reduceSubagentData,
  snapshotSubagentData,
} from "@/cli/cmd/run/subagent-data"

type ChildMessage = Parameters<typeof bootstrapSubagentCalls>[0]["messages"][number]
type AssistantMessage = Extract<SessionMessage, { type: "assistant" }>
type AssistantTool = Extract<AssistantMessage["content"][number], { type: "tool" }>

function visible(commits: Array<Parameters<typeof entryBody>[0]>) {
  return commits.flatMap((item) => {
    const body = entryBody(item)
    if (body.type === "none") {
      return []
    }

    if (body.type === "structured") {
      if (body.snapshot.kind === "code" || body.snapshot.kind === "task") {
        return [body.snapshot.title]
      }

      if (body.snapshot.kind === "diff") {
        return body.snapshot.items.map((item) => item.title)
      }

      if (body.snapshot.kind === "todo") {
        return ["# Todos"]
      }

      return ["# Questions"]
    }

    return [body.content]
  })
}

function reduce(data: ReturnType<typeof createSubagentData>, event: unknown) {
  return reduceSubagentData({
    data,
    event: event as Event,
    sessionID: "parent-1",
    thinking: true,
    limits: {},
  })
}

function assistantMessage(id: string, content: AssistantMessage["content"]): AssistantMessage {
  return {
    id,
    type: "assistant",
    time: { created: 1, completed: 2 },
    agent: "explore",
    model: {
      id: "gpt-5",
      providerID: "openai",
    },
    content,
  }
}

function taskMessage(sessionID: string, status: "running" | "completed" = "completed"): SessionMessage {
  return assistantMessage(`msg-${sessionID}`, [taskTool({ id: `tool-${sessionID}`, sessionID, status, toolCalls: 4 })])
}

function taskTool(input: {
  id: string
  sessionID?: string
  status?: "running" | "completed" | "error"
  toolCalls?: number
  body?: Record<string, unknown>
}): AssistantTool {
  const body = input.body ?? {
    description: "Scan reducer paths",
    subagent_type: "explore",
  }
  const structured = input.sessionID
    ? {
        task: {
          sessionID: input.sessionID,
          ...(input.toolCalls === undefined ? {} : { toolCalls: input.toolCalls }),
        },
      }
    : {}
  const base = {
    id: input.id,
    type: "tool" as const,
    name: "task",
    time: { created: 1, ran: 1, completed: input.status === "running" ? undefined : 2 },
  }

  if (input.status === "running") {
    return {
      ...base,
      state: {
        status: "running",
        input: body,
        structured,
        content: [],
      },
    }
  }

  if (input.status === "error") {
    return {
      ...base,
      state: {
        status: "error",
        input: body,
        structured,
        content: [{ type: "text", text: "failed" }],
        error: { type: "unknown", message: "failed" },
      },
    }
  }

  return {
    ...base,
    state: {
      status: "completed",
      input: body,
      structured,
      content: [],
    },
  }
}

function question(id: string, sessionID: string) {
  return {
    id,
    sessionID,
    questions: [
      {
        question: "Mode?",
        header: "Mode",
        options: [{ label: "Fast", description: "Quick pass" }],
        multiple: false,
      },
    ],
  }
}

function childAssistantMessage(messageID: string, content: AssistantMessage["content"]): ChildMessage {
  return assistantMessage(messageID, content)
}

function childUserMessage(messageID: string, text: string): ChildMessage {
  return {
    id: messageID,
    type: "user",
    time: { created: 1 },
    text,
  }
}

function childTool(input: {
  id: string
  name: string
  status?: "running" | "completed" | "error"
  body: Record<string, unknown>
  output?: string
}): AssistantTool {
  const base = {
    id: input.id,
    type: "tool" as const,
    name: input.name,
    time: { created: 1, ran: 1, completed: input.status === "running" ? undefined : 2 },
  }
  if (input.status === "running") {
    return {
      ...base,
      state: {
        status: "running",
        input: input.body,
        structured: {},
        content: [],
      },
    }
  }
  if (input.status === "error") {
    return {
      ...base,
      state: {
        status: "error",
        input: input.body,
        structured: {},
        content: [],
        error: { type: "unknown", message: input.output ?? "failed" },
      },
    }
  }
  return {
    ...base,
    state: {
      status: "completed",
      input: input.body,
      structured: {},
      content: input.output ? [{ type: "text", text: input.output }] : [],
    },
  }
}

describe("run subagent data", () => {
  test("bootstraps tabs and child blockers from parent task parts", () => {
    const data = createSubagentData()

    expect(
      bootstrapSubagentData({
        data,
        messages: [taskMessage("child-1")],
        children: [{ id: "child-1" }, { id: "child-2" }],
        permissions: [
          {
            id: "perm-1",
            sessionID: "child-1",
            permission: "read",
            patterns: ["src/**/*.ts"],
            metadata: {},
            always: [],
          },
          {
            id: "perm-2",
            sessionID: "other",
            permission: "read",
            patterns: ["src/**/*.ts"],
            metadata: {},
            always: [],
          },
        ],
        questions: [question("question-1", "child-1"), question("question-2", "other")],
      }),
    ).toBe(true)

    const snapshot = snapshotSubagentData(data)

    expect(snapshot.tabs).toEqual([
      expect.objectContaining({
        sessionID: "child-1",
        label: "Explore",
        description: "Scan reducer paths",
        status: "completed",
        toolCalls: 4,
      }),
    ])
    expect(snapshot.details).toEqual({
      "child-1": {
        sessionID: "child-1",
        commits: [],
      },
    })
    expect(snapshot.permissions.map((item) => item.id)).toEqual(["perm-1"])
    expect(snapshot.questions.map((item) => item.id)).toEqual(["question-1"])
  })

  test("bootstraps a task tab from canonical structured task metadata", () => {
    const data = createSubagentData()

    expect(
      bootstrapSubagentData({
        data,
        messages: [
          assistantMessage("msg-canonical", [
            taskTool({ id: "tool-canonical", sessionID: "child-canonical", toolCalls: 7 }),
          ]),
        ],
        children: [{ id: "child-canonical" }],
        permissions: [],
        questions: [],
      }),
    ).toBe(true)

    expect(snapshotSubagentData(data).tabs).toEqual([
      expect.objectContaining({
        sessionID: "child-canonical",
        label: "Explore",
        description: "Scan reducer paths",
        status: "completed",
        toolCalls: 7,
      }),
    ])
  })

  test("ignores task tools without valid canonical task metadata", () => {
    const data = createSubagentData()

    bootstrapSubagentData({
      data,
      messages: [
        assistantMessage("msg-invalid", [taskTool({ id: "tool-invalid" })]),
        assistantMessage("msg-empty", [taskTool({ id: "tool-empty", sessionID: "" })]),
      ],
      children: [{ id: "child-canonical" }],
      permissions: [],
      questions: [],
    })

    expect(snapshotSubagentData(data).tabs).toEqual([])
  })

  test("canonical zero task tool calls is preserved", () => {
    const data = createSubagentData()

    bootstrapSubagentData({
      data,
      messages: [
        assistantMessage("msg-zero-tool-calls", [
          taskTool({ id: "tool-zero-tool-calls", sessionID: "child-zero-tool-calls", toolCalls: 0 }),
        ]),
      ],
      children: [{ id: "child-zero-tool-calls" }],
      permissions: [],
      questions: [],
    })

    expect(snapshotSubagentData(data).tabs).toEqual([
      expect.objectContaining({
        sessionID: "child-zero-tool-calls",
        toolCalls: 0,
      }),
    ])
  })

  test("negative canonical tool calls is omitted while valid session metadata is used", () => {
    const data = createSubagentData()

    bootstrapSubagentData({
      data,
      messages: [
        assistantMessage("msg-negative-tool-calls", [
          taskTool({ id: "tool-negative-tool-calls", sessionID: "child-negative-tool-calls", toolCalls: -1 }),
        ]),
      ],
      children: [{ id: "child-negative-tool-calls" }],
      permissions: [],
      questions: [],
    })

    expect(snapshotSubagentData(data).tabs).toEqual([
      expect.objectContaining({
        sessionID: "child-negative-tool-calls",
        toolCalls: undefined,
      }),
    ])
  })

  test("reads task metadata from legacy-compatible tool state metadata", () => {
    const data = createSubagentData()

    reduce(data, {
      type: "message.part.updated",
      properties: {
        part: {
          id: "tool-metadata-task",
          messageID: "msg-metadata-task",
          sessionID: "parent-1",
          type: "tool",
          callID: "call-metadata-task",
          tool: "task",
          state: {
            status: "running",
            input: {
              description: "Inspect metadata path",
              subagent_type: "explore",
            },
            metadata: {
              task: {
                sessionID: "child-metadata-task",
                toolCalls: 5,
              },
            },
            time: { start: 1 },
          },
        },
      },
    })

    expect(snapshotSubagentData(data).tabs).toEqual([
      expect.objectContaining({
        sessionID: "child-metadata-task",
        description: "Inspect metadata path",
        toolCalls: 5,
      }),
    ])
  })

  test("captures child activity and blocker metadata in the footer detail state", () => {
    const data = createSubagentData()

    bootstrapSubagentData({
      data,
      messages: [taskMessage("child-1", "running")],
      children: [{ id: "child-1" }],
      permissions: [],
      questions: [],
    })

    reduce(data, {
      type: "message.part.updated",
      properties: {
        part: {
          id: "txt-user-1",
          messageID: "msg-user-1",
          sessionID: "child-1",
          type: "text",
          text: "Inspect footer tabs",
        },
      },
    })
    reduce(data, {
      type: "message.updated",
      properties: {
        sessionID: "child-1",
        info: {
          id: "msg-user-1",
          role: "user",
        },
      },
    })
    reduce(data, {
      type: "message.updated",
      properties: {
        sessionID: "child-1",
        info: {
          id: "msg-assistant-1",
          role: "assistant",
        },
      },
    })
    reduce(data, {
      type: "message.part.updated",
      properties: {
        part: {
          id: "reason-1",
          messageID: "msg-assistant-1",
          sessionID: "child-1",
          type: "reasoning",
          text: "planning next steps",
          time: { start: 1 },
        },
      },
    })
    reduce(data, {
      type: "message.part.updated",
      properties: {
        part: {
          id: "tool-1",
          messageID: "msg-assistant-1",
          sessionID: "child-1",
          type: "tool",
          callID: "call-1",
          tool: "bash",
          state: {
            status: "running",
            input: {
              command: "git status --short",
            },
            time: { start: 1 },
          },
        },
      },
    })
    reduce(data, {
      type: "permission.asked",
      properties: {
        id: "perm-1",
        sessionID: "child-1",
        permission: "bash",
        patterns: ["git status --short"],
        metadata: {},
        always: [],
        tool: {
          messageID: "msg-assistant-1",
          callID: "call-1",
        },
      },
    })
    reduce(data, {
      type: "message.part.updated",
      properties: {
        part: {
          id: "txt-1",
          messageID: "msg-assistant-1",
          sessionID: "child-1",
          type: "text",
          text: "hello",
        },
      },
    })
    reduce(data, {
      type: "message.part.delta",
      properties: {
        sessionID: "child-1",
        messageID: "msg-assistant-1",
        partID: "txt-1",
        field: "text",
        delta: " world",
      },
    })

    const snapshot = snapshotSubagentData(data)

    expect(snapshot.tabs).toEqual([expect.objectContaining({ sessionID: "child-1", status: "running" })])
    expect(visible(snapshot.details["child-1"]?.commits ?? [])).toEqual([
      "› Inspect footer tabs",
      "_Thinking:_ planning next steps",
      "$ git status --short",
      "hello world",
    ])
    expect(snapshot.permissions).toEqual([
      expect.objectContaining({
        id: "perm-1",
        metadata: {
          input: {
            command: "git status --short",
          },
        },
      }),
    ])
    expect(snapshot.questions).toEqual([])
  })

  test("replays bootstrapped child session messages into inspector commits", () => {
    const data = createSubagentData()

    bootstrapSubagentData({
      data,
      messages: [taskMessage("child-1", "completed")],
      children: [{ id: "child-1" }],
      permissions: [],
      questions: [],
    })

    expect(
      bootstrapSubagentCalls({
        data,
        sessionID: "child-1",
        messages: [
          childUserMessage("msg-user-1", "Inspect footer tabs"),
          childAssistantMessage("msg-assistant-1", [
            {
              id: "reason-1",
              type: "reasoning",
              text: "planning next steps",
            },
            {
              id: "txt-1",
              type: "text",
              text: "hello world",
            },
          ]),
        ],
        thinking: true,
      }),
    ).toBe(true)

    expect(visible(snapshotSubagentData(data).details["child-1"]?.commits ?? [])).toEqual([
      "› Inspect footer tabs",
      "_Thinking:_ planning next steps",
      "hello world",
    ])
  })

  test("bootstraps child tool commits and enriches permissions from canonical input", () => {
    const data = createSubagentData()

    bootstrapSubagentData({
      data,
      messages: [taskMessage("child-1", "running")],
      children: [{ id: "child-1" }],
      permissions: [
        {
          id: "perm-1",
          sessionID: "child-1",
          permission: "edit",
          patterns: ["src/run/subagent-data.ts"],
          metadata: {},
          always: [],
          tool: { messageID: "msg-assistant-1", callID: "edit-1" },
        },
      ],
      questions: [],
    })

    expect(
      bootstrapSubagentCalls({
        data,
        sessionID: "child-1",
        messages: [
          childAssistantMessage("msg-assistant-1", [
            childTool({
              id: "edit-1",
              name: "edit",
              body: { filePath: "src/run/subagent-data.ts", diff: "@@ -1 +1 @@" },
              output: "edited file",
            }),
          ]),
        ],
        thinking: true,
      }),
    ).toBe(true)

    const snapshot = snapshotSubagentData(data)
    expect(snapshot.details["child-1"]?.commits).toEqual([
      expect.objectContaining({ kind: "tool", tool: "edit", phase: "start", partID: "edit-1" }),
      expect.objectContaining({ kind: "tool", tool: "edit", phase: "final", text: "edited file", partID: "edit-1" }),
    ])
    expect(snapshot.permissions).toEqual([
      expect.objectContaining({
        id: "perm-1",
        metadata: {
          input: {
            filePath: "src/run/subagent-data.ts",
            diff: "@@ -1 +1 @@",
          },
        },
      }),
    ])
  })

  test("skips canonical history commits when live child frames already exist", () => {
    const data = createSubagentData()

    bootstrapSubagentData({
      data,
      messages: [taskMessage("child-1", "running")],
      children: [{ id: "child-1" }],
      permissions: [],
      questions: [],
    })
    reduce(data, {
      type: "message.updated",
      properties: {
        sessionID: "child-1",
        info: { id: "msg-live", role: "assistant" },
      },
    })
    reduce(data, {
      type: "message.part.updated",
      properties: {
        part: {
          id: "txt-live",
          messageID: "msg-live",
          sessionID: "child-1",
          type: "text",
          text: "live text",
        },
      },
    })

    bootstrapSubagentCalls({
      data,
      sessionID: "child-1",
      messages: [childAssistantMessage("msg-bootstrap", [{ id: "txt-bootstrap", type: "text", text: "bootstrap text" }])],
      thinking: true,
    })

    expect(visible(snapshotSubagentData(data).details["child-1"]?.commits ?? [])).toEqual(["live text"])
  })

  test("clears finished tabs on the next parent prompt", () => {
    const data = createSubagentData()

    bootstrapSubagentData({
      data,
      messages: [taskMessage("child-1", "completed"), taskMessage("child-2", "running")],
      children: [{ id: "child-1" }, { id: "child-2" }],
      permissions: [],
      questions: [],
    })

    expect(clearFinishedSubagents(data)).toBe(true)
    expect(snapshotSubagentData(data).tabs).toEqual([
      expect.objectContaining({ sessionID: "child-2", status: "running" }),
    ])
  })
})
