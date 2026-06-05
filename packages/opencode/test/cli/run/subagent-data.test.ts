import { describe, expect, test } from "bun:test"
import type { Event } from "@opencode-ai/sdk/v2"
import { entryBody } from "@/cli/cmd/run/entry.body"
import {
  bootstrapSubagentCalls,
  bootstrapSubagentCallsV2Display,
  bootstrapSubagentData,
  bootstrapSubagentDataV2Display,
  clearFinishedSubagents,
  createSubagentData,
  reduceSubagentData,
  snapshotSubagentData,
} from "@/cli/cmd/run/subagent-data"
import type { TranscriptV2Display } from "@/session/transcript-v2-display"

type SessionMessage = Parameters<typeof bootstrapSubagentData>[0]["messages"][number]
type ChildMessage = Parameters<typeof bootstrapSubagentCalls>[0]["messages"][number]
type DisplayTool = TranscriptV2Display.DisplayAssistantTool

function displayAssistant(content: TranscriptV2Display.DisplayAssistantContent[]) {
  return {
    type: "assistant",
    id: "evt-parent-assistant-1",
    agent: "build",
    model: { providerID: "openai", id: "gpt-5" } as TranscriptV2Display.DisplayAssistant["model"],
    time: { created: 1, completed: 4 },
    content,
  } satisfies TranscriptV2Display.DisplayAssistant
}

function displayTask(
  input: Partial<DisplayTool> & {
    id?: string
    name?: string
    status?: "pending" | "running" | "completed" | "error"
    task?: unknown
    input?: unknown
  } = {},
): DisplayTool {
  const status = input.status ?? "running"
  const stateInput = input.input ?? { description: "Scan reducer paths", subagent_type: "explore" }
  const structured = "task" in input ? (input.task === undefined ? {} : { task: input.task }) : { task: { sessionID: "child-1", toolCalls: 4 } }
  return {
    type: "tool",
    id: input.id ?? `evt-tool-${status}`,
    callID: input.callID ?? `call-${status}`,
    name: input.name ?? "task",
    title: input.title ?? "Reducer touchpoints",
    time: input.time ?? (status === "running" ? { created: 1, ran: 2 } : { created: 1, ran: 2, completed: 3 }),
    state:
      status === "pending"
        ? { status: "pending", input: JSON.stringify(stateInput) }
        : status === "error"
          ? {
              status,
              input: stateInput as Record<string, unknown>,
              structured,
              content: [],
              error: { type: "unknown", message: "failed" },
            }
          : {
              status,
              input: stateInput as Record<string, unknown>,
              structured,
              content: [],
            },
  }
}

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

function v2Called(input: { id?: string; sessionID?: string; callID?: string; tool?: string; timestamp?: number; body?: Record<string, unknown> } = {}) {
  return {
    id: input.id ?? "evt-called-1",
    type: "session.next.tool.called",
    properties: {
      timestamp: input.timestamp ?? 10,
      sessionID: input.sessionID ?? "parent-1",
      callID: input.callID ?? "call-task-1",
      tool: input.tool ?? "task",
      input: input.body ?? { description: "Scan reducer paths", subagent_type: "explore" },
      provider: { executed: true },
    },
  } satisfies Event
}

function v2Metadata(input: { sessionID?: string; callID?: string; timestamp?: number; task?: unknown } = {}) {
  return {
    id: "evt-metadata-1",
    type: "session.next.tool.metadata.updated",
    properties: {
      timestamp: input.timestamp ?? 11,
      sessionID: input.sessionID ?? "parent-1",
      callID: input.callID ?? "call-task-1",
      task: input.task ?? { sessionID: "child-1", toolCalls: 4 },
    },
  } as Event
}

function v2Success(input: { sessionID?: string; callID?: string; timestamp?: number; title?: string; structured?: Record<string, unknown> } = {}) {
  return {
    id: "evt-success-1",
    type: "session.next.tool.success",
    properties: {
      timestamp: input.timestamp ?? 12,
      sessionID: input.sessionID ?? "parent-1",
      callID: input.callID ?? "call-task-1",
      ...(input.title !== undefined ? { title: input.title } : {}),
      structured: input.structured ?? {},
      content: [],
      provider: { executed: true },
    },
  } satisfies Event
}

function v2Failed(input: { sessionID?: string; callID?: string; timestamp?: number } = {}) {
  return {
    id: "evt-failed-1",
    type: "session.next.tool.failed",
    properties: {
      timestamp: input.timestamp ?? 12,
      sessionID: input.sessionID ?? "parent-1",
      callID: input.callID ?? "call-task-1",
      error: { type: "unknown", message: "failed" },
      provider: { executed: true },
    },
  } satisfies Event
}

function taskMessage(sessionID: string, status: "running" | "completed" = "completed"): SessionMessage {
  if (status === "running") {
    return {
      parts: [
        {
          id: `part-${sessionID}`,
          sessionID: "parent-1",
          messageID: `msg-${sessionID}`,
          type: "tool",
          callID: `call-${sessionID}`,
          tool: "task",
          state: {
            status: "running",
            input: {
              description: "Scan reducer paths",
              subagent_type: "explore",
            },
            title: "Reducer touchpoints",
            metadata: {
              sessionId: sessionID,
              toolcalls: 4,
            },
            time: { start: 1 },
          },
        },
      ],
    }
  }

  return {
    parts: [
      {
        id: `part-${sessionID}`,
        sessionID: "parent-1",
        messageID: `msg-${sessionID}`,
        type: "tool",
        callID: `call-${sessionID}`,
        tool: "task",
        state: {
          status: "completed",
          input: {
            description: "Scan reducer paths",
            subagent_type: "explore",
          },
          output: "",
          title: "Reducer touchpoints",
          metadata: {
            sessionId: sessionID,
            toolcalls: 4,
          },
          time: { start: 1, end: 2 },
        },
      },
    ],
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

function childMessage(input: {
  messageID: string
  sessionID: string
  role: "user" | "assistant"
  parts: ChildMessage["parts"]
}) {
  if (input.role === "user") {
    return {
      info: {
        id: input.messageID,
        sessionID: input.sessionID,
        role: "user",
        time: {
          created: 1,
        },
        agent: "test",
        model: {
          providerID: "openai",
          modelID: "gpt-5",
        },
      },
      parts: input.parts,
    } satisfies ChildMessage
  }

  return {
    info: {
      id: input.messageID,
      sessionID: input.sessionID,
      role: "assistant",
      time: {
        created: 2,
        completed: 3,
      },
      parentID: "msg-user-1",
      providerID: "openai",
      modelID: "gpt-5",
      mode: "default",
      agent: "explore",
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
      finish: "stop",
    },
    parts: input.parts,
  } satisfies ChildMessage
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
        title: "Reducer touchpoints",
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

  test("bootstraps tabs from canonical v2 task display rows", () => {
    const data = createSubagentData()

    expect(
      bootstrapSubagentDataV2Display({
        data,
        messages: [displayAssistant([displayTask({ status: "completed" })])],
        children: [{ id: "child-1" }],
        permissions: [],
        questions: [],
      }),
    ).toBe(true)

    expect(snapshotSubagentData(data).tabs).toEqual([
      expect.objectContaining({
        sessionID: "child-1",
        partID: "evt-tool-completed",
        callID: "call-completed",
        label: "Explore",
        description: "Scan reducer paths",
        title: "Reducer touchpoints",
        status: "completed",
        toolCalls: 4,
        lastUpdatedAt: 3,
      }),
    ])
  })

  test("strictly validates v2 task display metadata", () => {
    const rejected = [
      displayTask({ status: "pending" }),
      displayTask({ name: "bash" }),
      displayTask({ task: undefined }),
      displayTask({ task: { sessionID: "msg_legacy" } }),
      displayTask({ task: { sessionID: "prt_legacy" } }),
      displayTask({ task: { sessionID: "child-1", toolCalls: -1 } }),
      displayTask({ task: { sessionID: "child-1", toolCalls: Number.NaN } }),
      displayTask({ task: { sessionID: "child-1", toolCalls: Number.POSITIVE_INFINITY } }),
      displayTask({ task: { sessionId: "child-1" } }),
      displayTask({ task: { sessionID: "child-1", toolcalls: 1 } }),
      displayTask({ task: { sessionID: "child-1", calls: 1 } }),
      displayTask({ task: { sessionID: "child-1", model: "gpt" } }),
    ]

    for (const tool of rejected) {
      const data = createSubagentData()
      expect(
        bootstrapSubagentDataV2Display({
          data,
          messages: [displayAssistant([tool])],
          children: [],
          permissions: [],
          questions: [],
        }),
      ).toBe(false)
      expect(snapshotSubagentData(data).tabs).toEqual([])
    }
  })

  test("filters v2 task tabs by known children and accepts valid metadata when children are empty", () => {
    const filtered = createSubagentData()
    bootstrapSubagentDataV2Display({
      data: filtered,
      messages: [displayAssistant([displayTask({ task: { sessionID: "child-2" } })])],
      children: [{ id: "child-1" }],
      permissions: [],
      questions: [],
    })
    expect(snapshotSubagentData(filtered).tabs).toEqual([])

    const unfiltered = createSubagentData()
    bootstrapSubagentDataV2Display({
      data: unfiltered,
      messages: [displayAssistant([displayTask({ task: { sessionID: "child-2" } })])],
      children: [],
      permissions: [],
      questions: [],
    })
    expect(snapshotSubagentData(unfiltered).tabs).toEqual([expect.objectContaining({ sessionID: "child-2" })])
  })

  test("preserves v2 blocker fallback tabs for children without task rows", () => {
    const data = createSubagentData()

    bootstrapSubagentDataV2Display({
      data,
      messages: [],
      children: [{ id: "child-1", title: "Explore" }],
      permissions: [
        { id: "perm-1", sessionID: "child-1", permission: "read", patterns: ["src/**/*.ts"], metadata: {}, always: [] },
      ],
      questions: [],
    })

    expect(snapshotSubagentData(data).tabs).toEqual([
      expect.objectContaining({ sessionID: "child-1", label: "Explore", description: "Pending permission" }),
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

  test("creates live v2 task tabs only after called and exact metadata", () => {
    for (const events of [[v2Called()], [v2Metadata()], [v2Metadata(), v2Failed()]]) {
      const data = createSubagentData()
      for (const event of events) {
        reduce(data, event)
      }
      expect(snapshotSubagentData(data).tabs).toEqual([])
    }

    const calledThenMetadata = createSubagentData()
    reduce(calledThenMetadata, v2Called({ id: "evt-called-canonical", timestamp: 10 }))
    reduce(calledThenMetadata, v2Metadata({ timestamp: 99 }))
    expect(snapshotSubagentData(calledThenMetadata).tabs).toEqual([
      expect.objectContaining({
        sessionID: "child-1",
        partID: "evt-called-canonical",
        callID: "call-task-1",
        label: "Explore",
        description: "Scan reducer paths",
        status: "running",
        toolCalls: 4,
        lastUpdatedAt: 10,
      }),
    ])

    const metadataThenCalled = createSubagentData()
    reduce(metadataThenCalled, v2Metadata())
    reduce(metadataThenCalled, v2Called({ timestamp: 20 }))
    expect(snapshotSubagentData(metadataThenCalled).tabs).toEqual([
      expect.objectContaining({ sessionID: "child-1", partID: "evt-called-1", status: "running", lastUpdatedAt: 20 }),
    ])
  })

  test("updates live v2 task tabs from terminal events without metadata timestamp override", () => {
    const completed = createSubagentData()
    reduce(completed, v2Called({ timestamp: 10 }))
    reduce(completed, v2Success({ timestamp: 30, title: "Done" }))
    reduce(completed, v2Metadata({ timestamp: 20 }))
    expect(snapshotSubagentData(completed).tabs).toEqual([
      expect.objectContaining({ status: "completed", title: "Done", lastUpdatedAt: 30 }),
    ])

    const failed = createSubagentData()
    reduce(failed, v2Called({ timestamp: 10 }))
    reduce(failed, v2Metadata({ timestamp: 20 }))
    reduce(failed, v2Failed({ timestamp: 40 }))
    expect(snapshotSubagentData(failed).tabs).toEqual([
      expect.objectContaining({ status: "error", lastUpdatedAt: 40 }),
    ])
  })

  test("ignores non-task and invalid live v2 task metadata", () => {
    const nonTask = createSubagentData()
    reduce(nonTask, v2Called({ tool: "bash" }))
    reduce(nonTask, v2Metadata())
    expect(snapshotSubagentData(nonTask).tabs).toEqual([])

    for (const task of [
      { sessionID: "msg_legacy" },
      { sessionID: "prt_legacy" },
      { sessionID: "child-1", toolCalls: -1 },
      { sessionID: "child-1", toolCalls: Number.NaN },
      { sessionID: "child-1", toolCalls: Number.POSITIVE_INFINITY },
      { sessionId: "child-1" },
      { sessionID: "child-1", toolcalls: 1 },
      { sessionID: "child-1", calls: 1 },
      { sessionID: "child-1", model: "gpt" },
    ]) {
      const data = createSubagentData()
      reduce(data, v2Called())
      reduce(data, v2Metadata({ task }))
      expect(snapshotSubagentData(data).tabs).toEqual([])
    }
  })

  test("does not resurrect cleared completed live v2 task tabs", () => {
    const data = createSubagentData()
    reduce(data, v2Called())
    reduce(data, v2Metadata())
    reduce(data, v2Success({ timestamp: 30, structured: { task: { sessionID: "child-1", toolCalls: 4 } } }))
    expect(clearFinishedSubagents(data)).toBe(true)
    reduce(data, v2Metadata({ timestamp: 40 }))
    expect(snapshotSubagentData(data).tabs).toEqual([])
  })

  test("legacy parent task part updates no longer create tabs", () => {
    const data = createSubagentData()
    reduce(data, {
      type: "message.part.updated",
      properties: {
        part: taskMessage("child-1", "running").parts[0],
      },
    })
    expect(snapshotSubagentData(data).tabs).toEqual([])
  })

  test("child part updates still update details for a known v2-created tab", () => {
    const data = createSubagentData()
    reduce(data, v2Called())
    reduce(data, v2Metadata())
    reduce(data, {
      type: "message.updated",
      properties: { sessionID: "child-1", info: { id: "msg-child-1", role: "assistant" } },
    })
    reduce(data, {
      type: "message.part.updated",
      properties: {
        part: {
          id: "txt-child-1",
          messageID: "msg-child-1",
          sessionID: "child-1",
          type: "text",
          text: "hello child",
        },
      },
    })

    expect(visible(snapshotSubagentData(data).details["child-1"]?.commits ?? [])).toEqual(["hello child"])
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
          childMessage({
            messageID: "msg-user-1",
            sessionID: "child-1",
            role: "user",
            parts: [
              {
                id: "txt-user-1",
                messageID: "msg-user-1",
                sessionID: "child-1",
                type: "text",
                text: "Inspect footer tabs",
                time: { start: 1, end: 1 },
              },
            ],
          }),
          childMessage({
            messageID: "msg-assistant-1",
            sessionID: "child-1",
            role: "assistant",
            parts: [
              {
                id: "reason-1",
                messageID: "msg-assistant-1",
                sessionID: "child-1",
                type: "reasoning",
                text: "planning next steps",
                time: { start: 2, end: 2 },
              },
              {
                id: "txt-1",
                messageID: "msg-assistant-1",
                sessionID: "child-1",
                type: "text",
                text: "hello world",
                time: { start: 2, end: 3 },
              },
            ],
          }),
        ],
        thinking: true,
        limits: {},
      }),
    ).toBe(true)

    expect(visible(snapshotSubagentData(data).details["child-1"]?.commits ?? [])).toEqual([
      "› Inspect footer tabs",
      "_Thinking:_ planning next steps",
      "hello world",
    ])
  })

  test("replays v2 display child rows into selected detail commits and preserves blockers", () => {
    const data = createSubagentData()

    bootstrapSubagentData({
      data,
      messages: [taskMessage("child-1", "running")],
      children: [{ id: "child-1" }],
      permissions: [
        {
          id: "perm-1",
          sessionID: "child-1",
          permission: "read",
          patterns: ["src/**/*.ts"],
          metadata: {},
          always: [],
        },
      ],
      questions: [],
    })

    expect(
      bootstrapSubagentCallsV2Display({
        data,
        sessionID: "child-1",
        thinking: true,
        limits: {},
        messages: [
          {
            type: "assistant",
            id: "asst-1",
            agent: "explore",
            model: { providerID: "openai", id: "gpt-5" } as TranscriptV2Display.DisplayAssistant["model"],
            time: { created: 2, completed: 3 },
            content: [
              { type: "text", id: "txt-1", text: "subagent summary" },
              {
                type: "tool",
                id: "tool-1",
                callID: "call-1",
                name: "bash",
                title: "bash",
                time: { created: 2, ran: 2, completed: 3 },
                state: {
                  status: "completed",
                  input: { command: "pwd" },
                  structured: {},
                  content: [{ type: "text", text: "/repo" }],
                },
              },
            ],
          },
          {
            type: "user",
            id: "user-1",
            text: "inspect runtime",
            files: [],
            agents: [],
            references: [],
            taskRequests: [
              {
                type: "task-request",
                id: "task-request-1",
                prompt: "map reducers",
                description: "Map reducers",
                agent: "explore",
              },
            ],
            time: { created: 1 },
          },
        ] satisfies readonly TranscriptV2Display.DisplayTranscriptMessage[],
      }),
    ).toBe(true)

    const snapshot = snapshotSubagentData(data)
    expect(snapshot.permissions.map((item) => item.id)).toEqual(["perm-1"])
    expect(visible(snapshot.details["child-1"]?.commits ?? [])).toEqual([
      "› inspect runtime",
      "subagent summary",
      "$ pwd",
      "\n/repo",
    ])
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
