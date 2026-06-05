import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { OpencodeClient, type GlobalEvent } from "@opencode-ai/sdk/v2"
import { createSessionTransport } from "@/cli/cmd/run/stream.transport"
import type { FooterApi, FooterEvent, RunFilePart, StreamCommit } from "@/cli/cmd/run/types"

type EventStream = Awaited<ReturnType<OpencodeClient["event"]["subscribe"]>>["stream"]
type GlobalEventStream = Awaited<ReturnType<OpencodeClient["global"]["event"]>>["stream"]
type SdkEvent = EventStream extends AsyncGenerator<infer T, unknown, unknown> ? T : never
type SessionMessage = NonNullable<Awaited<ReturnType<OpencodeClient["session"]["messages"]>>["data"]>[number]
type V2SessionMessagesResponse = NonNullable<Awaited<ReturnType<OpencodeClient["v2"]["session"]["messages"]>>["data"]>
type V2SessionMessage = V2SessionMessagesResponse["items"][number]
type SessionChild = NonNullable<Awaited<ReturnType<OpencodeClient["session"]["children"]>>["data"]>[number]
type SessionToolPart = Extract<SessionMessage["parts"][number], { type: "tool" }>
type SessionStatusMap = NonNullable<Awaited<ReturnType<OpencodeClient["session"]["status"]>>["data"]>
type TextPart = Extract<SessionMessage["parts"][number], { type: "text" }>

afterEach(() => {
  mock.restore()
})

function defer<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error?: unknown) => void
  const promise = new Promise<T>((next, fail) => {
    resolve = next
    reject = fail
  })

  return { promise, resolve, reject }
}

async function waitFor<T>(check: () => T | undefined, timeout = 1_000): Promise<T> {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const value = check()
    if (value !== undefined) {
      return value
    }

    await Bun.sleep(10)
  }

  throw new Error("timed out waiting for value")
}

function busy(sessionID = "session-1") {
  return {
    id: `evt-${sessionID}-busy`,
    type: "session.status",
    properties: {
      sessionID,
      status: {
        type: "busy",
      },
    },
  } satisfies SdkEvent
}

function idle(sessionID = "session-1") {
  return {
    id: `evt-${sessionID}-idle`,
    type: "session.status",
    properties: {
      sessionID,
      status: {
        type: "idle",
      },
    },
  } satisfies SdkEvent
}

function retry(sessionID: string, attempt: number, message: string) {
  return {
    id: `evt-${sessionID}-retry-${attempt}`,
    type: "session.status",
    properties: {
      sessionID,
      status: {
        type: "retry",
        attempt,
        message,
        next: 1,
      },
    },
  } satisfies SdkEvent
}

function assistant(id: string) {
  return {
    id: `evt-${id}`,
    type: "message.updated",
    properties: {
      sessionID: "session-1",
      info: assistantMessage({
        sessionID: "session-1",
        id,
        parts: [],
      }).info,
    },
  } satisfies SdkEvent
}

const StreamClosed = undefined as never

function feed<T, R = never>(returnValue: R = StreamClosed) {
  const list: T[] = []
  let done = false
  let wake: (() => void) | undefined

  const wrapped = (async function* (): AsyncGenerator<T, R, unknown> {
    while (!done || list.length > 0) {
      if (list.length === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve
        })
        continue
      }

      const next = list.shift()
      if (!next) {
        continue
      }

      yield next
    }
    return returnValue as R
  })()

  return {
    stream: wrapped,
    push(value: T) {
      list.push(value)
      wake?.()
      wake = undefined
    },
    close() {
      done = true
      wake?.()
      wake = undefined
    },
  }
}

function eventFeed() {
  return feed<SdkEvent>()
}

function globalFeed() {
  return feed<GlobalEvent>()
}

function emptyStream(): EventStream {
  return (async function* (): AsyncGenerator<SdkEvent> {})()
}

function ok<T>(data: T) {
  return Promise.resolve({
    data,
    error: undefined,
    request: new Request("https://opencode.test"),
    response: new Response(),
  })
}

function okV2Messages(items: V2SessionMessage[], cursor: V2SessionMessagesResponse["cursor"] = {}) {
  return ok({ items, cursor })
}

function sse(stream: EventStream) {
  return Promise.resolve({ stream })
}

function globalSse(stream: GlobalEventStream) {
  return Promise.resolve({ stream })
}

function wrapGlobalStream(stream: EventStream): GlobalEventStream {
  return (async function* (): GlobalEventStream {
    for await (const event of stream) {
      yield globalEvent(event)
    }
    return StreamClosed
  })()
}

function statusMap(busy: boolean): SessionStatusMap {
  if (busy) {
    return { "session-1": { type: "busy" } }
  }

  return {}
}

function assistantMessage(input: { sessionID: string; id: string; parts: SessionMessage["parts"] }): SessionMessage {
  return {
    info: {
      id: input.id,
      sessionID: input.sessionID,
      role: "assistant",
      time: {
        created: 1,
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
    },
    parts: input.parts,
  }
}

function v2User(id: string, text: string, created = 1): V2SessionMessage {
  return {
    id,
    type: "user",
    text,
    files: [],
    agents: [],
    references: [],
    time: { created },
  }
}

function v2Assistant(id: string, content: Extract<V2SessionMessage, { type: "assistant" }>["content"], created = 2): V2SessionMessage {
  return {
    id,
    type: "assistant",
    agent: "build",
    model: {
      providerID: "openai",
      id: "gpt-5",
    },
    content,
    time: { created, completed: created + 1 },
  }
}

function v2Text(id: string, text: string): Extract<Extract<V2SessionMessage, { type: "assistant" }>["content"][number], { type: "text" }> {
  return { id, type: "text", text }
}

function v2RunningTool(id: string, callID = "call-1"): Extract<Extract<V2SessionMessage, { type: "assistant" }>["content"][number], { type: "tool" }> {
  return {
    id,
    type: "tool",
    callID,
    name: "bash",
    state: {
      status: "running",
      input: { command: "pwd" },
      structured: {},
      content: [],
    },
    time: { created: 2, ran: 2 },
  }
}

function v2CompletedTool(
  id: string,
  input: Record<string, unknown>,
  name = "bash",
  callID = "call-1",
): Extract<Extract<V2SessionMessage, { type: "assistant" }>["content"][number], { type: "tool" }> {
  return {
    id,
    type: "tool",
    callID,
    name,
    state: {
      status: "completed",
      input,
      structured: {},
      content: [],
    },
    time: { created: 2, ran: 2, completed: 3 },
  }
}

function v2TaskTool(input: {
  id?: string
  callID?: string
  sessionID?: string
  status?: "running" | "completed" | "error"
  description?: string
  subagentType?: string
  toolCalls?: number
  created?: number
} = {}): Extract<Extract<V2SessionMessage, { type: "assistant" }>["content"][number], { type: "tool" }> {
  const status = input.status ?? "running"
  return {
    id: input.id ?? `evt-task-${input.sessionID ?? "child-1"}`,
    type: "tool",
    callID: input.callID ?? "call-task-1",
    name: "task",
    title: "Task",
    state:
      status === "error"
        ? {
            status,
            input: {
              description: input.description ?? "Explore run.ts",
              subagent_type: input.subagentType ?? "explore",
            },
            structured: { task: { sessionID: input.sessionID ?? "child-1", ...(input.toolCalls !== undefined ? { toolCalls: input.toolCalls } : {}) } },
            content: [],
            error: { type: "unknown", message: "failed" },
          }
        : {
            status,
            input: {
              description: input.description ?? "Explore run.ts",
              subagent_type: input.subagentType ?? "explore",
            },
            structured: { task: { sessionID: input.sessionID ?? "child-1", ...(input.toolCalls !== undefined ? { toolCalls: input.toolCalls } : {}) } },
            content: [],
          },
    time:
      status === "running"
        ? { created: input.created ?? 2, ran: input.created ?? 2 }
        : { created: input.created ?? 2, ran: input.created ?? 2, completed: (input.created ?? 2) + 1 },
  }
}

function runningTool(input: {
  sessionID: string
  messageID: string
  id: string
  callID: string
  tool: string
  body: Record<string, unknown>
  metadata?: Record<string, unknown>
}): SessionToolPart {
  return {
    id: input.id,
    sessionID: input.sessionID,
    messageID: input.messageID,
    type: "tool",
    callID: input.callID,
    tool: input.tool,
    state: {
      status: "running",
      input: input.body,
      ...(input.metadata ? { metadata: input.metadata } : {}),
      time: {
        start: 1,
      },
    },
  }
}

function completedTool(input: {
  sessionID: string
  messageID: string
  id: string
  callID: string
  tool: string
  body: Record<string, unknown>
  output?: string
  metadata?: Record<string, unknown>
}): SessionToolPart {
  return {
    id: input.id,
    sessionID: input.sessionID,
    messageID: input.messageID,
    type: "tool",
    callID: input.callID,
    tool: input.tool,
    state: {
      status: "completed",
      input: input.body,
      output: input.output ?? "",
      title: input.tool,
      metadata: input.metadata ?? {},
      time: {
        start: 1,
        end: 2,
      },
    },
  }
}

function textPart(id: string, messageID: string, text: string, sessionID = "session-1"): TextPart {
  return {
    id,
    sessionID,
    messageID,
    type: "text",
    text,
  }
}

function textUpdated(part: TextPart): SdkEvent {
  return {
    id: `evt-${part.id}-updated`,
    type: "message.part.updated",
    properties: {
      sessionID: part.sessionID,
      part,
      time: 1,
    },
  }
}

function toolUpdated(part: SessionToolPart): SdkEvent {
  return {
    id: `evt-${part.id}-updated`,
    type: "message.part.updated",
    properties: {
      sessionID: part.sessionID,
      part,
      time: 1,
    },
  }
}

function v2ToolCalled(input: { id?: string; callID?: string; tool?: string; timestamp?: number; body?: Record<string, unknown> } = {}): SdkEvent {
  return {
    id: input.id ?? "evt-v2-task-called",
    type: "session.next.tool.called",
    properties: {
      timestamp: input.timestamp ?? 10,
      sessionID: "session-1",
      callID: input.callID ?? "call-task-1",
      tool: input.tool ?? "task",
      input: input.body ?? { description: "Explore run.ts", subagent_type: "explore" },
      provider: { executed: true },
    },
  } satisfies SdkEvent
}

function v2ToolMetadata(input: { callID?: string; timestamp?: number; childSessionID?: string; toolCalls?: number } = {}): SdkEvent {
  return {
    id: "evt-v2-task-metadata",
    type: "session.next.tool.metadata.updated",
    properties: {
      timestamp: input.timestamp ?? 11,
      sessionID: "session-1",
      callID: input.callID ?? "call-task-1",
      task: { sessionID: input.childSessionID ?? "child-1", ...(input.toolCalls !== undefined ? { toolCalls: input.toolCalls } : {}) },
    },
  } satisfies SdkEvent
}

function textDelta(messageID: string, partID: string, delta: string, sessionID = "session-1"): SdkEvent {
  return {
    id: `evt-${partID}-delta`,
    type: "message.part.delta",
    properties: {
      sessionID,
      messageID,
      partID,
      field: "text",
      delta,
    },
  }
}

function child(id: string): SessionChild {
  return {
    id,
    slug: id,
    projectID: "project-1",
    directory: "/tmp",
    title: id,
    version: "1",
    time: {
      created: 1,
      updated: 1,
    },
  }
}

function globalEvent(payload: GlobalEvent["payload"]): GlobalEvent {
  return {
    directory: "/tmp",
    project: "project-1",
    payload,
  }
}

function footer(fn?: (commit: StreamCommit) => void) {
  const commits: StreamCommit[] = []
  const events: FooterEvent[] = []
  let closed = false
  let idleCalls = 0

  const api: FooterApi = {
    get isClosed() {
      return closed
    },
    onPrompt: () => () => {},
    onQueuedRemove: () => () => {},
    onClose: () => () => {},
    event(next) {
      events.push(next)
    },
    append(next) {
      commits.push(next)
      fn?.(next)
    },
    idle() {
      idleCalls += 1
      return Promise.resolve()
    },
    close() {
      closed = true
    },
    destroy() {
      closed = true
    },
  }

  return {
    api,
    commits,
    events,
    get idleCalls() {
      return idleCalls
    },
  }
}

function sdk(
  input: {
    stream?: EventStream
    globalStream?: GlobalEventStream
    subscribe?: OpencodeClient["event"]["subscribe"]
    globalEvent?: OpencodeClient["global"]["event"]
    promptAsync?: OpencodeClient["session"]["promptAsync"]
    status?: OpencodeClient["session"]["status"]
    messages?: OpencodeClient["session"]["messages"]
    v2Messages?: OpencodeClient["v2"]["session"]["messages"]
    children?: OpencodeClient["session"]["children"]
    permissions?: OpencodeClient["permission"]["list"]
    questions?: OpencodeClient["question"]["list"]
  } = {},
) {
  const client = new OpencodeClient()

  const subscribe: OpencodeClient["event"]["subscribe"] = input.subscribe ?? (() => sse(input.stream ?? emptyStream()))
  const globalEvent: OpencodeClient["global"]["event"] =
    input.globalEvent ?? (() => globalSse(input.globalStream ?? wrapGlobalStream(input.stream ?? emptyStream())))
  const promptAsync: OpencodeClient["session"]["promptAsync"] = input.promptAsync ?? (() => ok(undefined))
  const status: OpencodeClient["session"]["status"] = input.status ?? (() => ok({}))
  const messages: OpencodeClient["session"]["messages"] = input.messages ?? (() => ok([]))
  const v2Messages: OpencodeClient["v2"]["session"]["messages"] = input.v2Messages ?? (() => okV2Messages([]))
  const children: OpencodeClient["session"]["children"] = input.children ?? (() => ok([]))
  const permissions: OpencodeClient["permission"]["list"] = input.permissions ?? (() => ok([]))
  const questions: OpencodeClient["question"]["list"] = input.questions ?? (() => ok([]))

  spyOn(client.event, "subscribe").mockImplementation(subscribe)
  spyOn(client.global, "event").mockImplementation(globalEvent)
  spyOn(client.session, "promptAsync").mockImplementation(promptAsync)
  spyOn(client.session, "status").mockImplementation(status)
  spyOn(client.session, "messages").mockImplementation(messages)
  spyOn(client.v2.session, "messages").mockImplementation(v2Messages)
  spyOn(client.session, "children").mockImplementation(children)
  spyOn(client.permission, "list").mockImplementation(permissions)
  spyOn(client.question, "list").mockImplementation(questions)

  return client
}

describe("run stream transport", () => {
  test("does not replay persisted main-session history during bootstrap by default", async () => {
    const src = eventFeed()
    const ui = footer()
    const legacyMessages = mock(() => ok([]))
    const v2Messages = mock(({ sessionID, order, limit }) => {
      expect({ sessionID, order, limit }).toEqual({ sessionID: "session-1", order: "desc", limit: 200 })
      return okV2Messages([])
    })
    const transport = await createSessionTransport({
      sdk: sdk({
        stream: src.stream,
        v2Messages,
        messages: legacyMessages,
      }),
      sessionID: "session-1",
      thinking: true,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      expect(ui.commits).toEqual([])
      expect(ui.idleCalls).toBe(0)
      expect(v2Messages).toHaveBeenCalledTimes(1)
      expect(legacyMessages).not.toHaveBeenCalled()
    } finally {
      src.close()
      await transport.close()
    }
  })

  test("bootstraps no-replay primary blockers from v2 without appending history", async () => {
    const src = eventFeed()
    const ui = footer()
    const v2Messages = mock(({ sessionID, order, limit }) => {
      expect({ sessionID, order, limit }).toEqual({ sessionID: "session-1", order: "desc", limit: 200 })
      return okV2Messages([
        v2User("evt-user-1", "historical user"),
        v2Assistant("evt-assistant-1", [v2Text("evt-text-1", "historical assistant"), v2RunningTool("evt-tool-1")]),
      ])
    })
    const transport = await createSessionTransport({
      sdk: sdk({
        stream: src.stream,
        v2Messages,
        permissions: async () =>
          ok([
            {
              id: "perm-1",
              sessionID: "session-1",
              permission: "bash",
              patterns: ["*"],
              metadata: {},
              always: [],
              tool: { messageID: "evt-assistant-1", callID: "call-1" },
            },
            {
              id: "perm-child",
              sessionID: "child-1",
              permission: "bash",
              patterns: ["*"],
              metadata: {},
              always: [],
              tool: { messageID: "evt-child", callID: "call-child" },
            },
          ]),
      }),
      sessionID: "session-1",
      thinking: true,
      replay: false,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      const view = await waitFor(() => {
        const item = ui.events.findLast((event) => event.type === "stream.view")
        return item?.type === "stream.view" && item.view.type === "permission" ? item.view : undefined
      })
      expect(view.request).toEqual(
        expect.objectContaining({
          id: "perm-1",
          metadata: { input: { command: "pwd" } },
        }),
      )
      expect(ui.commits).toEqual([])
      expect(v2Messages).toHaveBeenCalledTimes(1)
    } finally {
      src.close()
      await transport.close()
    }
  })

  test("replays persisted main-session history during bootstrap when enabled", async () => {
    const src = eventFeed()
    const ui = footer()
    const legacyMessages = mock(() => ok([]))
    const v2Messages = mock(({ order, limit, cursor }) => {
      expect({ order, limit, cursor }).toEqual({ order: "asc", limit: 200, cursor: undefined })
      return okV2Messages([v2Assistant("evt-assistant-1", [v2Text("evt-text-1", "Hello.")])])
    })
    const transport = await createSessionTransport({
      sdk: sdk({
        stream: src.stream,
        messages: legacyMessages,
        v2Messages,
      }),
      sessionID: "session-1",
      thinking: true,
      replay: true,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      await waitFor(() => ui.commits.find((item) => item.kind === "assistant" && item.text === "Hello."))
      expect(ui.idleCalls).toBeGreaterThan(0)
      expect(legacyMessages).not.toHaveBeenCalled()
      expect(v2Messages).toHaveBeenCalledTimes(1)
      expect(JSON.stringify(ui.commits)).not.toContain("msg_")
      expect(JSON.stringify(ui.commits)).not.toContain("prt_")
    } finally {
      src.close()
      await transport.close()
    }
  })

  test("paginates all v2 replay messages with explicit ascending pages", async () => {
    const src = eventFeed()
    const ui = footer()
    const calls: unknown[] = []
    const v2Messages = mock((params) => {
      calls.push(params)
      if ("cursor" in params && params.cursor === "next-1") {
        return okV2Messages([v2Assistant("evt-assistant-2", [v2Text("evt-text-2", "two")], 3)])
      }
      return okV2Messages([v2Assistant("evt-assistant-1", [v2Text("evt-text-1", "one")], 1)], { next: "next-1" })
    })
    const transport = await createSessionTransport({
      sdk: sdk({ stream: src.stream, v2Messages }),
      sessionID: "session-1",
      thinking: true,
      replay: true,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      await waitFor(() => (ui.commits.filter((item) => item.kind === "assistant").length === 2 ? true : undefined))
      expect(calls).toEqual([
        expect.objectContaining({ sessionID: "session-1", order: "asc", limit: 200 }),
        expect.objectContaining({ sessionID: "session-1", order: "asc", cursor: "next-1", limit: 200 }),
      ])
      expect(ui.commits.filter((item) => item.kind === "assistant").map((item) => item.text)).toEqual(["one", "two"])
    } finally {
      src.close()
      await transport.close()
    }
  })

  test("replay with children reuses v2 replay rows for subagent bootstrap", async () => {
    const src = eventFeed()
    const ui = footer()
    const legacyMessages = mock(() => ok([]))
    const transport = await createSessionTransport({
      sdk: sdk({
        stream: src.stream,
        v2Messages: async () => okV2Messages([v2Assistant("evt-assistant-1", [v2Text("evt-text-1", "primary"), v2TaskTool()])]),
        messages: legacyMessages,
        children: async () => ok([child("child-1")]),
      }),
      sessionID: "session-1",
      thinking: true,
      replay: true,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      await waitFor(() => ui.commits.find((item) => item.kind === "assistant" && item.text === "primary"))
      const state = await waitFor(() => {
        const item = ui.events.findLast((event) => event.type === "stream.subagent")
        return item?.type === "stream.subagent" && item.state.tabs.some((tab) => tab.sessionID === "child-1")
          ? item.state
          : undefined
      })
      expect(state.tabs).toEqual([expect.objectContaining({ sessionID: "child-1", status: "running" })])
      expect(legacyMessages).not.toHaveBeenCalled()
    } finally {
      src.close()
      await transport.close()
    }
  })

  test("no-replay discovers subagent tabs from v2 primary bootstrap when children are empty", async () => {
    const src = eventFeed()
    const ui = footer()
    const legacyMessages = mock(() => ok([]))
    const transport = await createSessionTransport({
      sdk: sdk({
        stream: src.stream,
        v2Messages: async () => okV2Messages([v2Assistant("evt-parent-assistant-1", [v2TaskTool()])]),
        messages: legacyMessages,
        children: async () => ok([]),
      }),
      sessionID: "session-1",
      thinking: true,
      replay: false,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      const state = await waitFor(() => {
        const item = ui.events.findLast((event) => event.type === "stream.subagent")
        return item?.type === "stream.subagent" && item.state.tabs.some((tab) => tab.sessionID === "child-1")
          ? item.state
          : undefined
      })
      expect(state.tabs).toEqual([expect.objectContaining({ sessionID: "child-1", status: "running" })])
      expect(legacyMessages).not.toHaveBeenCalled()
    } finally {
      src.close()
      await transport.close()
    }
  })

  test("global v2 called and metadata events create a live footer subagent tab", async () => {
    const global = globalFeed()
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: sdk({
        globalStream: global.stream,
        v2Messages: async () => okV2Messages([]),
        children: async () => ok([]),
      }),
      sessionID: "session-1",
      thinking: true,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      global.push(globalEvent(v2ToolCalled({ id: "evt-v2-called-canonical" })))
      global.push(globalEvent(v2ToolMetadata({ toolCalls: 2 })))

      const state = await waitFor(() => {
        const item = ui.events.findLast((event) => event.type === "stream.subagent")
        return item?.type === "stream.subagent" && item.state.tabs.some((tab) => tab.sessionID === "child-1")
          ? item.state
          : undefined
      })

      expect(state.tabs).toEqual([
        expect.objectContaining({
          sessionID: "child-1",
          partID: "evt-v2-called-canonical",
          callID: "call-task-1",
          status: "running",
          toolCalls: 2,
        }),
      ])
    } finally {
      global.close()
      await transport.close()
    }
  })

  test("legacy parent task part updates no longer create live footer subagent tabs", async () => {
    const global = globalFeed()
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: sdk({ globalStream: global.stream, v2Messages: async () => okV2Messages([]) }),
      sessionID: "session-1",
      thinking: true,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      global.push(
        globalEvent(
          toolUpdated(
            runningTool({
              sessionID: "session-1",
              messageID: "msg-1",
              id: "task-1",
              callID: "call-1",
              tool: "task",
              body: { description: "Explore run.ts", subagent_type: "explore" },
              metadata: { sessionId: "child-1" },
            }),
          ),
        ),
      )
      await Bun.sleep(50)
      expect(
        ui.events
          .filter((event) => event.type === "stream.subagent")
          .flatMap((event) => (event.type === "stream.subagent" ? event.state.tabs : [])),
      ).toEqual([])
    } finally {
      global.close()
      await transport.close()
    }
  })

  test("caps replayed bootstrap history to the configured number of messages", async () => {
    const src = eventFeed()
    const ui = footer()
    const v2Messages = mock(({ order, limit }) => {
      expect({ order, limit }).toEqual({ order: "desc", limit: 1 })
      return okV2Messages([v2Assistant("evt-assistant-2", [v2Text("evt-text-2", "World.")], 3)])
    })
    const transport = await createSessionTransport({
      sdk: sdk({
        stream: src.stream,
        v2Messages,
      }),
      sessionID: "session-1",
      thinking: true,
      replay: true,
      replayLimit: 1,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      await waitFor(() => (ui.commits.length > 0 ? ui.commits : undefined))
      expect(ui.commits.filter((item) => item.kind === "assistant")).toEqual([
        expect.objectContaining({
          text: "World.",
        }),
      ])
      expect(v2Messages).toHaveBeenCalledTimes(1)
    } finally {
      src.close()
      await transport.close()
    }
  })

  test("replay limit with children uses separate v2 latest slice for subagent bootstrap", async () => {
    const src = eventFeed()
    const ui = footer()
    const legacyMessages = mock(() => ok([]))
    const calls: unknown[] = []
    const v2Messages = mock(({ sessionID, order, limit }) => {
      calls.push({ sessionID, order, limit })
      if (limit === 1) {
        return okV2Messages([v2Assistant("evt-replay-latest", [v2Text("evt-text-latest", "latest")])])
      }

      return okV2Messages([v2Assistant("evt-parent-bootstrap", [v2TaskTool()])])
    })
    const transport = await createSessionTransport({
      sdk: sdk({
        stream: src.stream,
        messages: legacyMessages,
        v2Messages,
        children: async () => ok([child("child-1")]),
      }),
      sessionID: "session-1",
      thinking: true,
      replay: true,
      replayLimit: 1,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      await waitFor(() => {
        const item = ui.events.findLast((event) => event.type === "stream.subagent")
        return item?.type === "stream.subagent" && item.state.tabs.some((tab) => tab.sessionID === "child-1")
          ? item
          : undefined
      })
      expect(calls.filter((call) => (call as { sessionID?: string }).sessionID === "session-1")).toEqual([
        { sessionID: "session-1", order: "desc", limit: 1 },
        { sessionID: "session-1", order: "desc", limit: 200 },
      ])
      expect(legacyMessages).not.toHaveBeenCalled()
    } finally {
      src.close()
      await transport.close()
    }
  })

  test("renders limited latest v2 messages in ascending display order", async () => {
    const src = eventFeed()
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: sdk({
        stream: src.stream,
        v2Messages: async () =>
          okV2Messages([
            v2Assistant("evt-assistant-3", [v2Text("evt-text-3", "three")], 3),
            v2Assistant("evt-assistant-2", [v2Text("evt-text-2", "two")], 2),
          ]),
      }),
      sessionID: "session-1",
      thinking: true,
      replay: true,
      replayLimit: 2,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      await waitFor(() => (ui.commits.filter((item) => item.kind === "assistant").length === 2 ? true : undefined))
      expect(ui.commits.filter((item) => item.kind === "assistant").map((item) => item.text)).toEqual(["two", "three"])
    } finally {
      src.close()
      await transport.close()
    }
  })

  test("rejects startup when v2 replay is not ready or invalid", async () => {
    await expect(
      createSessionTransport({
        sdk: sdk({
          v2Messages: async () =>
            ({
              data: undefined,
              error: { _tag: "SessionMessagesNotReadyError", sessionID: "session-1", status: "upgrade_pending" },
              request: new Request("https://opencode.test"),
              response: new Response(undefined, { status: 503 }),
            }) as never,
        }),
        sessionID: "session-1",
        thinking: true,
        replay: true,
        limits: () => ({}),
        footer: footer().api,
      }),
    ).rejects.toThrow("failed to load v2 replay messages")

    await expect(
      createSessionTransport({
        sdk: sdk({ v2Messages: async () => okV2Messages([{ ...v2User("msg_legacy", "bad"), id: "msg_legacy" }]) }),
        sessionID: "session-1",
        thinking: true,
        replay: true,
        limits: () => ({}),
        footer: footer().api,
      }),
    ).rejects.toThrow()
  })

  test("rejects no-replay startup when primary v2 bootstrap is not ready or invalid", async () => {
    await expect(
      createSessionTransport({
        sdk: sdk({
          v2Messages: async () =>
            ({
              data: undefined,
              error: { _tag: "SessionMessagesNotReadyError", sessionID: "session-1", status: "upgrade_pending" },
              request: new Request("https://opencode.test"),
              response: new Response(undefined, { status: 503 }),
            }) as never,
        }),
        sessionID: "session-1",
        thinking: true,
        replay: false,
        limits: () => ({}),
        footer: footer().api,
      }),
    ).rejects.toThrow("failed to load v2 replay messages")

    await expect(
      createSessionTransport({
        sdk: sdk({ v2Messages: async () => okV2Messages([{ ...v2User("msg_legacy", "bad"), id: "msg_legacy" }]) }),
        sessionID: "session-1",
        thinking: true,
        replay: false,
        limits: () => ({}),
        footer: footer().api,
      }),
    ).rejects.toThrow()
  })

  test("rejects startup when separate v2 parent subagent discovery fails", async () => {
    let calls = 0
    await expect(
      createSessionTransport({
        sdk: sdk({
          messages: mock(() => ok([])),
          children: async () => ok([child("child-1")]),
          v2Messages: async () => {
            calls += 1
            if (calls === 1) {
              return okV2Messages([v2Assistant("evt-replay-latest", [v2Text("evt-text-latest", "latest")])])
            }

            return {
              data: undefined,
              error: { _tag: "SessionMessagesNotReadyError", sessionID: "session-1", status: "upgrade_pending" },
              request: new Request("https://opencode.test"),
              response: new Response(undefined, { status: 503 }),
            } as never
          },
        }),
        sessionID: "session-1",
        thinking: true,
        replay: true,
        replayLimit: 1,
        limits: () => ({}),
        footer: footer().api,
      }),
    ).rejects.toThrow("failed to load v2 replay messages")
  })

  test("skips buffered pre-bootstrap deltas already covered by replay history", async () => {
    const src = eventFeed()
    const ui = footer()
    const gate = defer<void>()
    let transport: Awaited<ReturnType<typeof createSessionTransport>> | undefined
    const task = createSessionTransport({
      sdk: sdk({
        stream: src.stream,
        v2Messages: async () => {
          await gate.promise
          return okV2Messages([v2Assistant("evt-assistant-1", [v2Text("evt-text-1", "Hello")])])
        },
      }),
      sessionID: "session-1",
      thinking: true,
      replay: true,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      await Promise.resolve()
      src.push(textDelta("evt-assistant-1", "evt-text-1", "lo"))
      gate.resolve()
      transport = await task

      await waitFor(() => (ui.commits.length > 0 ? ui.commits : undefined))
      await Bun.sleep(20)
      expect(ui.commits.filter((item) => item.kind === "assistant")).toEqual([
        expect.objectContaining({
          text: "Hello",
        }),
      ])
    } finally {
      src.close()
      await transport?.close()
    }
  })

  test("applies buffered pre-bootstrap deltas not yet persisted", async () => {
    const src = eventFeed()
    const ui = footer()
    const gate = defer<void>()
    let transport: Awaited<ReturnType<typeof createSessionTransport>> | undefined
    const task = createSessionTransport({
      sdk: sdk({
        stream: src.stream,
        v2Messages: async () => {
          await gate.promise
          return okV2Messages([v2Assistant("evt-assistant-1", [], 2)])
        },
      }),
      sessionID: "session-1",
      thinking: true,
      replay: true,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      await Promise.resolve()
      src.push(textDelta("evt-assistant-1", "evt-text-1", "Hello"))
      src.push(textUpdated(textPart("evt-text-1", "evt-assistant-1", "", "session-1")))
      gate.resolve()
      transport = await task

      await waitFor(() => (ui.commits.length > 0 ? ui.commits : undefined))
      await Bun.sleep(20)
      expect(ui.commits.filter((item) => item.kind === "assistant")).toEqual([
        expect.objectContaining({
          text: "Hello",
        }),
      ])
    } finally {
      src.close()
      await transport?.close()
    }
  })

  test("preserves running footer state for resumed active sessions", async () => {
    const src = eventFeed()
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: sdk({
        stream: src.stream,
        v2Messages: async () => okV2Messages([v2Assistant("evt-assistant-1", [v2RunningTool("evt-tool-1")])]),
      }),
      sessionID: "session-1",
      thinking: true,
      replay: true,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      const patch = await waitFor(() => {
        const item = ui.events.findLast((event) => event.type === "stream.patch")
        return item?.type === "stream.patch" ? item.patch : undefined
      })

      expect(patch).toEqual(
        expect.objectContaining({
          phase: "running",
          status: "running bash",
        }),
      )
    } finally {
      src.close()
      await transport.close()
    }
  })

  test("drops completed historical subagent tabs during bootstrap", async () => {
    const src = eventFeed()
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: sdk({
        stream: src.stream,
        v2Messages: async () => okV2Messages([v2Assistant("evt-parent-assistant-1", [v2TaskTool({ status: "completed" })])]),
        children: async () => ok([child("child-1")]),
      }),
      sessionID: "session-1",
      thinking: true,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      const state = await waitFor(() => {
        const item = ui.events.findLast((event) => event.type === "stream.subagent")
        return item?.type === "stream.subagent" ? item.state : undefined
      })

      expect(state.tabs).toEqual([])
      expect(state.details).toEqual({})
    } finally {
      src.close()
      await transport.close()
    }
  })

  test("bootstraps child tabs and resumed blocker input", async () => {
    const src = eventFeed()
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: sdk({
        stream: src.stream,
        v2Messages: async ({ sessionID }) =>
          sessionID === "child-1"
            ? okV2Messages([
                v2Assistant("evt-child-assistant-1", [
                  v2CompletedTool(
                    "edit-1",
                    {
                      filePath: "src/run/subagent-data.ts",
                      diff: "@@ -1 +1 @@",
                    },
                    "edit",
                    "call-edit-1",
                  ),
                ]),
              ])
              : okV2Messages([v2Assistant("evt-parent-assistant-1", [v2TaskTool({ description: "Explore run folder" })])]),
        children: async () => ok([child("child-1")]),
        permissions: async () =>
          ok([
            {
              id: "perm-1",
              sessionID: "child-1",
              permission: "edit",
              patterns: ["src/run/subagent-data.ts"],
              metadata: {},
              always: [],
              tool: {
                messageID: "evt-child-assistant-1",
                callID: "call-edit-1",
              },
            },
          ]),
      }),
      sessionID: "session-1",
      thinking: true,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      const boot = await waitFor(() => {
        const item = ui.events.findLast((event) => event.type === "stream.subagent")
        const state = item?.type === "stream.subagent" ? item.state : undefined
        return state?.tabs.some((tab) => tab.sessionID === "child-1") &&
          state.permissions.some((req) => req.id === "perm-1" && req.metadata.input)
          ? state
          : undefined
      })

      expect(boot.tabs).toEqual([
        expect.objectContaining({
          sessionID: "child-1",
          label: "Explore",
          description: "Pending permission",
          status: "running",
        }),
      ])
      expect(boot.permissions).toEqual([
        expect.objectContaining({
          id: "perm-1",
          sessionID: "child-1",
          metadata: {
            input: {
              filePath: "src/run/subagent-data.ts",
              diff: "@@ -1 +1 @@",
            },
          },
        }),
      ])

      transport.selectSubagent("child-1")

      const selected = await waitFor(() => {
        const item = ui.events.findLast((event) => event.type === "stream.subagent")
        const state = item?.type === "stream.subagent" ? item.state : undefined
        const detail = state?.details["child-1"]
        return detail?.commits.some(
          (commit) => commit.kind === "tool" && commit.tool === "edit" && commit.phase === "start",
        )
          ? state
          : undefined
      })

      expect(selected.details["child-1"]?.commits).toContainEqual(
        expect.objectContaining({
          kind: "tool",
          tool: "edit",
          phase: "start",
        }),
      )

      expect(
        await waitFor(() => {
          const item = ui.events.findLast((event) => event.type === "stream.view")
          return item?.type === "stream.view" && item.view.type === "permission" && item.view.request.id === "perm-1"
            ? item
            : undefined
        }),
      ).toEqual({
        type: "stream.view",
        view: {
          type: "permission",
          request: expect.objectContaining({
            id: "perm-1",
            metadata: {
              input: {
                filePath: "src/run/subagent-data.ts",
                diff: "@@ -1 +1 @@",
              },
            },
          }),
        },
      })
    } finally {
      src.close()
      await transport.close()
    }
  })

  test("bootstraps child session output before selection", async () => {
    const ui = footer()
    const legacyMessages = mock(() => ok([]))
    const v2Messages = mock(async ({ sessionID, order, limit }) => {
      if (sessionID === "child-1") {
        expect({ sessionID, order, limit }).toEqual({
          sessionID: "child-1",
          order: "desc",
          limit: 80,
        })
        return okV2Messages([v2Assistant("evt-child-assistant-1", [v2Text("evt-child-text-1", "subagent summary")])])
      }

      return okV2Messages([v2Assistant("evt-parent-assistant-1", [v2TaskTool()])])
    })
    const transport = await createSessionTransport({
      sdk: sdk({
        messages: legacyMessages,
        v2Messages,
        children: async () => ok([child("child-1")]),
      }),
      sessionID: "session-1",
      thinking: true,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      await waitFor(() => {
        const item = ui.events.findLast((event) => event.type === "stream.subagent")
        return item?.type === "stream.subagent" && item.state.tabs.some((tab) => tab.sessionID === "child-1")
          ? item
          : undefined
      })

      await waitFor(() =>
        v2Messages.mock.calls.some((call) => call[0]?.sessionID === "child-1") ? true : undefined,
      )

      transport.selectSubagent("child-1")

      expect(
        await waitFor(() => {
          const item = ui.events.findLast((event) => event.type === "stream.subagent")
          const detail = item?.type === "stream.subagent" ? item.state.details["child-1"] : undefined
          return detail?.commits.some((commit) => commit.kind === "assistant" && commit.text === "subagent summary")
            ? detail
            : undefined
        }),
      ).toEqual({
        sessionID: "child-1",
        commits: [
          expect.objectContaining({
            kind: "assistant",
            text: "subagent summary",
          }),
        ],
      })
      expect(v2Messages).toHaveBeenCalledWith(
        { sessionID: "child-1", limit: 80, order: "desc" },
        expect.objectContaining({ throwOnError: true, signal: expect.any(AbortSignal) }),
      )
      expect(legacyMessages).not.toHaveBeenCalled()
    } finally {
      await transport.close()
    }
  })

  test("does not block startup on child history bootstrap", async () => {
    const pending = defer<Awaited<ReturnType<typeof okV2Messages>>>()
    const ui = footer()
    let transport: Awaited<ReturnType<typeof createSessionTransport>> | undefined

    const task = createSessionTransport({
      sdk: sdk({
        v2Messages: async ({ sessionID }) => {
          if (sessionID === "child-1") {
            return pending.promise
          }

          return okV2Messages([v2Assistant("evt-parent-assistant-1", [v2TaskTool()])])
        },
        children: async () => ok([child("child-1")]),
      }),
      sessionID: "session-1",
      thinking: true,
      limits: () => ({}),
      footer: ui.api,
    }).then((item) => {
      transport = item
      return item
    })

    try {
      const state = await waitFor(() => {
        const item = ui.events.findLast((event) => event.type === "stream.subagent")
        return item?.type === "stream.subagent" && item.state.tabs.some((tab) => tab.sessionID === "child-1")
          ? item.state
          : undefined
      })

      await waitFor(() => transport)

      expect(state).toEqual({
        tabs: [expect.objectContaining({ sessionID: "child-1", status: "running" })],
        details: {},
        permissions: [],
        questions: [],
      })
    } finally {
      pending.resolve(okV2Messages([]))
      await task
      await transport?.close()
    }
  })

  test("reports v2 child history failures without legacy fallback", async () => {
    const gate = defer<void>()
    const ui = footer()
    const trace = { write: mock(() => {}) }
    const legacyMessages = mock(() => ok([]))
    const v2Messages = mock(async ({ sessionID }) => {
      if (sessionID === "child-1") {
        await gate.promise
        throw new Error("v2 unavailable")
      }

      return okV2Messages([v2Assistant("evt-parent-assistant-1", [v2TaskTool()])])
    })
    const transport = await createSessionTransport({
      sdk: sdk({
        messages: legacyMessages,
        v2Messages,
        children: async () => ok([child("child-1")]),
      }),
      sessionID: "session-1",
      thinking: true,
      limits: () => ({}),
      footer: ui.api,
      trace,
    })

    try {
      await waitFor(() => {
        const item = ui.events.findLast((event) => event.type === "stream.subagent")
        return item?.type === "stream.subagent" && item.state.tabs.some((tab) => tab.sessionID === "child-1")
          ? item
          : undefined
      })

      transport.selectSubagent("child-1")
      gate.resolve()

      const detail = await waitFor(() => {
        const item = ui.events.findLast((event) => event.type === "stream.subagent")
        const next = item?.type === "stream.subagent" ? item.state.details["child-1"] : undefined
        return next?.commits.some((commit) => commit.kind === "error" && commit.text.includes("v2 unavailable"))
          ? next
          : undefined
      })

      expect(detail.commits).toEqual([
        expect.objectContaining({
          kind: "error",
          text: expect.stringContaining("v2 unavailable"),
        }),
      ])
      expect(trace.write).toHaveBeenCalledWith(
        "subagent.history.error",
        expect.objectContaining({ sessionID: "child-1", error: "v2 unavailable" }),
      )
      expect(legacyMessages).not.toHaveBeenCalled()
    } finally {
      await transport.close()
    }
  })

  test("replays child events buffered during bootstrap once the tab is known", async () => {
    const global = globalFeed()
    const ui = footer()
    const gate = defer<void>()
    let transport: Awaited<ReturnType<typeof createSessionTransport>> | undefined
    const task = createSessionTransport({
      sdk: sdk({
        globalStream: global.stream,
        v2Messages: async () => {
          await gate.promise
          return okV2Messages([])
        },
        children: async () => ok([]),
      }),
      sessionID: "session-1",
      thinking: true,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      await Promise.resolve()
      global.push(globalEvent(retry("child-1", 1, "retry child")))
      global.push(
        globalEvent({
          id: "evt-child-message",
          type: "message.updated",
          properties: {
            sessionID: "child-1",
            info: assistantMessage({
              sessionID: "child-1",
              id: "msg-child-1",
              parts: [],
            }).info,
          },
        }),
      )
      global.push(globalEvent(textUpdated(textPart("txt-child-1", "msg-child-1", "", "child-1"))))
      global.push(globalEvent(textDelta("msg-child-1", "txt-child-1", "Hello", "child-1")))
      global.push(globalEvent(v2ToolCalled({ id: "evt-v2-called-buffered" })))
      global.push(globalEvent(v2ToolMetadata()))
      gate.resolve()
      transport = await task

      await waitFor(() => {
        const item = ui.events.findLast((event) => event.type === "stream.subagent")
        return item?.type === "stream.subagent" && item.state.tabs.some((tab) => tab.sessionID === "child-1")
          ? item
          : undefined
      })

      transport.selectSubagent("child-1")

      const detail = await waitFor(() => {
        const item = ui.events.findLast((event) => event.type === "stream.subagent")
        const next = item?.type === "stream.subagent" ? item.state.details["child-1"] : undefined
        return next?.commits.some((commit) => commit.kind === "error" && commit.text === "retry child") &&
          next.commits.some((commit) => commit.kind === "assistant" && commit.text === "Hello")
          ? next
          : undefined
      })

      expect(detail).toEqual({
        sessionID: "child-1",
        commits: expect.arrayContaining([
          expect.objectContaining({
            kind: "error",
            text: "retry child",
          }),
          expect.objectContaining({
            kind: "assistant",
            text: "Hello",
          }),
        ]),
      })
    } finally {
      global.close()
      await transport?.close()
    }
  })

  test("streams selected subagent output from global events while it is running", async () => {
    const global = globalFeed()
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: sdk({
        globalStream: global.stream,
      }),
      sessionID: "session-1",
      thinking: true,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      global.push(globalEvent(v2ToolCalled({ id: "evt-v2-called-stream" })))
      global.push(globalEvent(v2ToolMetadata()))

      await waitFor(() => {
        const item = ui.events.findLast((event) => event.type === "stream.subagent")
        return item?.type === "stream.subagent" && item.state.tabs.some((tab) => tab.sessionID === "child-1")
          ? item
          : undefined
      })

      transport.selectSubagent("child-1")

      global.push(
        globalEvent({
          id: "evt-child-message",
          type: "message.updated",
          properties: {
            sessionID: "child-1",
            info: assistantMessage({
              sessionID: "child-1",
              id: "msg-child-1",
              parts: [],
            }).info,
          },
        }),
      )
      global.push(globalEvent(textUpdated(textPart("txt-child-1", "msg-child-1", "hello", "child-1"))))

      expect(
        await waitFor(() => {
          const item = ui.events.findLast((event) => event.type === "stream.subagent")
          const detail = item?.type === "stream.subagent" ? item.state.details["child-1"] : undefined
          return detail?.commits.some((commit) => commit.kind === "assistant" && commit.text === "hello")
            ? detail
            : undefined
        }),
      ).toEqual({
        sessionID: "child-1",
        commits: [
          expect.objectContaining({
            kind: "assistant",
            text: "hello",
          }),
        ],
      })

      global.push(globalEvent(textUpdated(textPart("txt-child-1", "msg-child-1", "hello world", "child-1"))))

      expect(
        await waitFor(() => {
          const item = ui.events.findLast((event) => event.type === "stream.subagent")
          const detail = item?.type === "stream.subagent" ? item.state.details["child-1"] : undefined
          return detail?.commits.some((commit) => commit.kind === "assistant" && commit.text === "hello world")
            ? detail
            : undefined
        }, 2_000),
      ).toEqual({
        sessionID: "child-1",
        commits: [
          expect.objectContaining({
            kind: "assistant",
            text: "hello world",
          }),
        ],
      })
    } finally {
      global.close()
      await transport.close()
    }
  })

  test("recovers pending questions from question.list when question.asked is missed", async () => {
    const src = eventFeed()
    const ui = footer()
    let questionCalls = 0
    const request = {
      id: "question-1",
      sessionID: "session-1",
      questions: [
        {
          question: "Which area should I inspect first?",
          header: "Area",
          options: [{ label: "CLI", description: "Look at the direct run flow." }],
          multiple: false,
        },
      ],
      tool: {
        messageID: "msg-1",
        callID: "call-question-1",
      },
    }
    const transport = await createSessionTransport({
      sdk: sdk({
        stream: src.stream,
        questions: async () => {
          questionCalls += 1
          return ok(questionCalls > 1 ? [request] : [])
        },
        promptAsync: async () => {
          queueMicrotask(() => {
            src.push(busy())
            src.push(assistant("msg-1"))
            src.push(
              toolUpdated(
                runningTool({
                  sessionID: "session-1",
                  messageID: "msg-1",
                  id: "question-tool-1",
                  callID: "call-question-1",
                  tool: "question",
                  body: {
                    questions: request.questions,
                  },
                }),
              ),
            )
          })
          return ok(undefined)
        },
      }),
      sessionID: "session-1",
      thinking: true,
      limits: () => ({}),
      footer: ui.api,
    })

    const ctrl = new AbortController()

    try {
      const run = transport.runPromptTurn({
        agent: undefined,
        model: undefined,
        variant: undefined,
        prompt: { text: "hello", parts: [] },
        files: [],
        includeFiles: false,
        signal: ctrl.signal,
      })

      const view = await waitFor(() => {
        const item = ui.events.findLast((event) => event.type === "stream.view")
        return item?.type === "stream.view" && item.view.type === "question" ? item.view : undefined
      })

      expect(view).toEqual({
        type: "question",
        request,
      })

      expect(ui.events).toContainEqual({
        type: "stream.patch",
        patch: {
          phase: "running",
          status: "awaiting answer",
        },
      })

      src.push(
        toolUpdated(
          completedTool({
            sessionID: "session-1",
            messageID: "msg-1",
            id: "question-tool-1",
            callID: "call-question-1",
            tool: "question",
            body: {
              questions: request.questions,
            },
            output: "User has answered your questions.",
            metadata: {
              answers: [["CLI"]],
            },
          }),
        ),
      )

      expect(
        await waitFor(() => {
          const item = ui.events.findLast((event) => event.type === "stream.view")
          return item?.type === "stream.view" && item.view.type === "prompt" ? item : undefined
        }),
      ).toEqual({
        type: "stream.view",
        view: { type: "prompt" },
      })

      ctrl.abort()
      await run
    } finally {
      src.close()
      await transport.close()
    }
  })

  test("does not resurrect questions if question.list resolves after tool completion", async () => {
    const src = eventFeed()
    const ui = footer()
    const started = defer()
    const request = {
      id: "question-race-1",
      sessionID: "session-1",
      questions: [
        {
          question: "Which area should I inspect first?",
          header: "Area",
          options: [{ label: "CLI", description: "Look at the direct run flow." }],
          multiple: false,
        },
      ],
      tool: {
        messageID: "msg-1",
        callID: "call-question-race-1",
      },
    }
    const pending = defer<Awaited<ReturnType<typeof ok<(typeof request)[]>>>>()
    let questionCalls = 0
    const transport = await createSessionTransport({
      sdk: sdk({
        stream: src.stream,
        questions: async () => {
          questionCalls += 1
          if (questionCalls === 1) {
            return ok([])
          }

          if (questionCalls === 2) {
            started.resolve()
            return pending.promise
          }

          return ok([])
        },
        promptAsync: async () => {
          queueMicrotask(() => {
            src.push(busy())
            src.push(assistant("msg-1"))
            src.push(
              toolUpdated(
                runningTool({
                  sessionID: "session-1",
                  messageID: "msg-1",
                  id: "question-race-tool-1",
                  callID: "call-question-race-1",
                  tool: "question",
                  body: {
                    questions: request.questions,
                  },
                }),
              ),
            )
          })
          return ok(undefined)
        },
      }),
      sessionID: "session-1",
      thinking: true,
      limits: () => ({}),
      footer: ui.api,
    })

    const ctrl = new AbortController()

    try {
      const run = transport.runPromptTurn({
        agent: undefined,
        model: undefined,
        variant: undefined,
        prompt: { text: "hello", parts: [] },
        files: [],
        includeFiles: false,
        signal: ctrl.signal,
      })

      await started.promise
      src.push(
        toolUpdated(
          completedTool({
            sessionID: "session-1",
            messageID: "msg-1",
            id: "question-race-tool-1",
            callID: "call-question-race-1",
            tool: "question",
            body: {
              questions: request.questions,
            },
            output: "User has answered your questions.",
            metadata: {
              answers: [["CLI"]],
            },
          }),
        ),
      )
      await waitFor(() => {
        const commit = ui.commits.findLast(
          (item) => item.kind === "tool" && item.partID === "question-race-tool-1" && item.toolState === "completed",
        )
        return commit ? true : undefined
      })
      pending.resolve(ok([request]))

      await Bun.sleep(50)

      expect(
        ui.events.some(
          (event) =>
            event.type === "stream.view" && event.view.type === "question" && event.view.request.id === request.id,
        ),
      ).toBe(false)

      ctrl.abort()
      await run
    } finally {
      src.close()
      await transport.close()
    }
  })

  test("respects the includeFiles flag when building prompt payloads", async () => {
    const src = eventFeed()
    const ui = footer()
    const seen: unknown[] = []
    const file: RunFilePart = {
      type: "file",
      url: "file:///tmp/a.ts",
      filename: "a.ts",
      mime: "text/plain",
    }

    const transport = await createSessionTransport({
      sdk: sdk({
        stream: src.stream,
        promptAsync: async (input) => {
          seen.push(input)
          queueMicrotask(() => {
            src.push(busy())
            src.push(idle())
          })
          return ok(undefined)
        },
      }),
      sessionID: "session-1",
      thinking: true,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      await transport.runPromptTurn({
        agent: undefined,
        model: undefined,
        variant: undefined,
        prompt: { text: "hello", parts: [] },
        files: [file],
        includeFiles: true,
      })

      await transport.runPromptTurn({
        agent: undefined,
        model: undefined,
        variant: undefined,
        prompt: { text: "again", parts: [] },
        files: [file],
        includeFiles: false,
      })

      expect(seen).toEqual([
        expect.objectContaining({
          parts: [file, { type: "text", text: "hello" }],
        }),
        expect.objectContaining({
          parts: [{ type: "text", text: "again" }],
        }),
      ])
    } finally {
      src.close()
      await transport.close()
    }
  })

  test("falls back to session status polling when idle events are missing", async () => {
    const src = eventFeed()
    const ui = footer()
    let busy = true
    const transport = await createSessionTransport({
      sdk: sdk({
        stream: src.stream,
        promptAsync: async () => {
          queueMicrotask(() => {
            src.push(assistant("msg-1"))
            busy = false
          })
          return ok(undefined)
        },
        status: async () => ok(statusMap(busy)),
      }),
      sessionID: "session-1",
      thinking: true,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      await Promise.race([
        transport.runPromptTurn({
          agent: undefined,
          model: undefined,
          variant: undefined,
          prompt: { text: "hello", parts: [] },
          files: [],
          includeFiles: false,
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("turn timed out")), 1_000)),
      ])
    } finally {
      src.close()
      await transport.close()
    }
  })

  test("resolves prompt turns after v2 tool activity and idle", async () => {
    const src = eventFeed()
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: sdk({
        stream: src.stream,
        promptAsync: async () => {
          queueMicrotask(() => {
            src.push(v2ToolCalled())
            src.push(v2ToolMetadata())
            src.push(idle())
          })
          return ok(undefined)
        },
        status: async () => ok(statusMap(false)),
      }),
      sessionID: "session-1",
      thinking: true,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      await Promise.race([
        transport.runPromptTurn({
          agent: undefined,
          model: undefined,
          variant: undefined,
          prompt: { text: "hello", parts: [] },
          files: [],
          includeFiles: false,
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("turn timed out")), 1_000)),
      ])
    } finally {
      src.close()
      await transport.close()
    }
  })

  test("flushes interrupted output when the active turn aborts", async () => {
    const src = eventFeed()
    const seen = defer()
    const ui = footer((commit) => {
      if (commit.kind === "assistant" && commit.phase === "progress") {
        seen.resolve()
      }
    })
    const transport = await createSessionTransport({
      sdk: sdk({
        stream: src.stream,
        promptAsync: async () => {
          queueMicrotask(() => {
            src.push(busy())
            src.push(assistant("msg-1"))
            src.push(textUpdated(textPart("txt-1", "msg-1", "")))
            src.push(textDelta("msg-1", "txt-1", "unfinished"))
          })
          return ok(undefined)
        },
      }),
      sessionID: "session-1",
      thinking: true,
      limits: () => ({}),
      footer: ui.api,
    })

    const ctrl = new AbortController()

    try {
      const task = transport.runPromptTurn({
        agent: undefined,
        model: undefined,
        variant: undefined,
        prompt: { text: "hello", parts: [] },
        files: [],
        includeFiles: false,
        signal: ctrl.signal,
      })

      await seen.promise
      ctrl.abort()
      await task

      expect(ui.commits).toEqual([
        {
          kind: "assistant",
          text: "unfinished",
          phase: "progress",
          source: "assistant",
          messageID: "msg-1",
          partID: "txt-1",
        },
        {
          kind: "assistant",
          text: "",
          phase: "final",
          source: "assistant",
          messageID: "msg-1",
          partID: "txt-1",
          interrupted: true,
        },
      ])
    } finally {
      src.close()
      await transport.close()
    }
  })

  test("closes an active turn without rejecting it", async () => {
    const src = eventFeed()
    const ui = footer()
    const ready = defer()
    let aborted = false

    const transport = await createSessionTransport({
      sdk: sdk({
        stream: src.stream,
        promptAsync: async (_input, opt) => {
          ready.resolve()
          await new Promise<void>((resolve) => {
            const onAbort = () => {
              aborted = true
              opt?.signal?.removeEventListener("abort", onAbort)
              resolve()
            }

            opt?.signal?.addEventListener("abort", onAbort, { once: true })
          })
          return ok(undefined)
        },
      }),
      sessionID: "session-1",
      thinking: true,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      const task = transport.runPromptTurn({
        agent: undefined,
        model: undefined,
        variant: undefined,
        prompt: { text: "hello", parts: [] },
        files: [],
        includeFiles: false,
      })

      await ready.promise
      await transport.close()
      await task

      expect(aborted).toBe(true)
    } finally {
      src.close()
      await transport.close()
    }
  })

  test("rejects the active turn when the event stream faults", async () => {
    const ui = footer()
    const ready = defer()

    const transport = await createSessionTransport({
      sdk: sdk({
        globalEvent: () =>
          globalSse(
            (async function* (): AsyncGenerator<GlobalEvent> {
              await ready.promise
              yield globalEvent(busy())
              throw new Error("boom")
            })(),
          ),
        promptAsync: async () => {
          ready.resolve()
          return ok(undefined)
        },
        status: async () => ok({ "session-1": { type: "busy" } }),
      }),
      sessionID: "session-1",
      thinking: true,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      await expect(
        transport.runPromptTurn({
          agent: undefined,
          model: undefined,
          variant: undefined,
          prompt: { text: "hello", parts: [] },
          files: [],
          includeFiles: false,
        }),
      ).rejects.toThrow("boom")
    } finally {
      await transport.close()
    }
  })

  test("rejects the active turn when the backing instance is disposed", async () => {
    const ui = footer()
    const ready = defer()

    const transport = await createSessionTransport({
      sdk: sdk({
        globalEvent: () =>
          globalSse(
            (async function* (): AsyncGenerator<GlobalEvent> {
              await ready.promise
              yield globalEvent({
                id: "evt-disposed",
                type: "server.instance.disposed",
                properties: {
                  directory: "/tmp",
                },
              })
            })(),
          ),
        promptAsync: async () => {
          ready.resolve()
          return ok(undefined)
        },
        status: async () => ok({}),
      }),
      directory: "/tmp",
      sessionID: "session-1",
      thinking: true,
      limits: () => ({}),
      footer: ui.api,
    })

    try {
      await expect(
        transport.runPromptTurn({
          agent: undefined,
          model: undefined,
          variant: undefined,
          prompt: { text: "hello", parts: [] },
          files: [],
          includeFiles: false,
        }),
      ).rejects.toThrow("instance disposed")
    } finally {
      await transport.close()
    }
  })

  test("rejects concurrent turns", async () => {
    const src = eventFeed()
    const ui = footer()
    const transport = await createSessionTransport({
      sdk: sdk({
        stream: src.stream,
      }),
      sessionID: "session-1",
      thinking: true,
      limits: () => ({}),
      footer: ui.api,
    })

    const ctrl = new AbortController()

    try {
      const task = transport.runPromptTurn({
        agent: undefined,
        model: undefined,
        variant: undefined,
        prompt: { text: "one", parts: [] },
        files: [],
        includeFiles: false,
        signal: ctrl.signal,
      })

      await expect(
        transport.runPromptTurn({
          agent: undefined,
          model: undefined,
          variant: undefined,
          prompt: { text: "two", parts: [] },
          files: [],
          includeFiles: false,
        }),
      ).rejects.toThrow("prompt already running")

      ctrl.abort()
      await task
    } finally {
      src.close()
      await transport.close()
    }
  })
})
