import type { AssistantMessage, Event, PermissionRequest, QuestionRequest, ToolPart } from "@opencode-ai/sdk/v2"
import { Buffer } from "node:buffer"
import type { TranscriptV2Display } from "@/session/transcript-v2-display"
import { bootstrapSessionData, createSessionData, reduceSessionData, type SessionData } from "./session-data"
import { messagePrompt, type SessionMessages } from "./session.shared"
import type { FooterPatch, StreamCommit } from "./types"

type ReplayInput = {
  messages: SessionMessages
  permissions: PermissionRequest[]
  questions: QuestionRequest[]
  thinking: boolean
  limits: Record<string, number>
}

type ReplayV2Input = {
  messages: readonly TranscriptV2Display.DisplayTranscriptMessage[]
  permissions: PermissionRequest[]
  questions: QuestionRequest[]
  thinking: boolean
  limits: Record<string, number>
  sessionID?: string
}

type BootstrapV2DisplayInput = {
  data: SessionData
  messages: readonly TranscriptV2Display.DisplayTranscriptMessage[]
  permissions: PermissionRequest[]
  questions: QuestionRequest[]
}

export type SessionReplay = {
  data: SessionData
  commits: StreamCommit[]
  patch?: FooterPatch
}

type ReplayMessage = {
  commits: StreamCommit[]
  patch?: FooterPatch
}

function apply(data: SessionData, event: Event, sessionID: string, thinking: boolean, limits: Record<string, number>) {
  return reduceSessionData({
    data,
    event,
    sessionID,
    thinking,
    limits,
  })
}

function mergePatch(left: FooterPatch | undefined, right: FooterPatch | undefined) {
  if (!left) {
    return right
  }

  if (!right) {
    return left
  }

  return {
    ...left,
    ...right,
  }
}

function active(data: SessionData) {
  return data.part.size > 0 || data.tools.size > 0
}

function replayPatch(data: SessionData, patch: FooterPatch | undefined) {
  if (active(data)) {
    if (!patch) {
      return {
        phase: "running",
      } satisfies FooterPatch
    }

    return {
      ...patch,
      phase: "running",
    } satisfies FooterPatch
  }

  if (data.permissions.length > 0 || data.questions.length > 0) {
    if (!patch) {
      return {
        phase: "idle",
      } satisfies FooterPatch
    }

    return {
      ...patch,
      phase: "idle",
    } satisfies FooterPatch
  }

  if (!patch) {
    return undefined
  }

  return {
    ...patch,
    phase: "idle",
    status: "",
  } satisfies FooterPatch
}

function replayMessage(
  data: SessionData,
  message: SessionMessages[number],
  thinking: boolean,
  limits: Record<string, number>,
): ReplayMessage {
  if (message.info.role === "user") {
    const prompt = messagePrompt(message)
    if (!prompt.text.trim()) {
      return {
        commits: [],
      }
    }

    return {
      commits: [
        {
          kind: "user",
          text: prompt.text,
          phase: "start",
          source: "system",
          messageID: message.info.id,
        },
      ],
    }
  }

  const commits: StreamCommit[] = []
  let patch: FooterPatch | undefined

  const info = apply(
    data,
    {
      id: `bootstrap:message:${message.info.id}`,
      type: "message.updated",
      properties: {
        sessionID: message.info.sessionID,
        info: message.info,
      },
    },
    message.info.sessionID,
    thinking,
    limits,
  )
  commits.push(...info.commits)
  patch = mergePatch(patch, info.footer?.patch)

  for (const part of message.parts) {
    const next = apply(
      data,
      {
        id: `bootstrap:part:${part.id}`,
        type: "message.part.updated",
        properties: {
          sessionID: part.sessionID,
          part,
          time: 0,
        },
      },
      message.info.sessionID,
      thinking,
      limits,
    )
    patch = mergePatch(patch, next.footer?.patch)
    commits.push(...next.commits)
  }

  return {
    commits,
    patch,
  }
}

export function replaySession(input: ReplayInput): SessionReplay {
  const data = createSessionData()
  const commits: StreamCommit[] = []
  let patch: FooterPatch | undefined

  bootstrapSessionData({
    data,
    messages: input.messages,
    permissions: input.permissions,
    questions: input.questions,
  })

  for (const message of input.messages) {
    const next = replayMessage(data, message, input.thinking, input.limits)
    commits.push(...next.commits)
    patch = mergePatch(patch, next.patch)
  }

  return {
    data,
    commits,
    patch: replayPatch(data, patch),
  }
}

export function replaySessionV2(input: ReplayV2Input): SessionReplay {
  const data = createSessionData()
  const commits: StreamCommit[] = []
  let patch: FooterPatch | undefined
  const sessionID = replaySessionID(input)

  for (const message of orderDisplayMessages(input.messages)) {
    const next = replayDisplayMessage(data, message, sessionID, input.thinking, input.limits)
    commits.push(...next.commits)
    patch = mergePatch(patch, next.patch)
  }

  bootstrapSessionData({
    data,
    messages: [],
    permissions: input.permissions,
    questions: input.questions,
  })

  return {
    data,
    commits,
    patch: replayPatch(data, patch),
  }
}

export function bootstrapSessionDataV2Display(input: BootstrapV2DisplayInput) {
  for (const message of input.messages) {
    if (message.type !== "assistant") {
      continue
    }

    for (const content of message.content) {
      if (content.type !== "tool") {
        continue
      }

      const state = content.state
      if (state.status === "pending") {
        continue
      }

      input.data.call.set(`${message.id}:${content.callID}`, state.input)
    }
  }

  bootstrapSessionData({
    data: input.data,
    messages: [],
    permissions: input.permissions,
    questions: input.questions,
  })
}

function replaySessionID(input: ReplayV2Input) {
  return input.sessionID ?? input.permissions[0]?.sessionID ?? input.questions[0]?.sessionID ?? "v2-replay"
}

function orderDisplayMessages(messages: readonly TranscriptV2Display.DisplayTranscriptMessage[]) {
  return messages.slice().sort((left, right) => {
    const time = left.time.created - right.time.created
    if (time !== 0) return time
    return Buffer.from(left.id).compare(Buffer.from(right.id))
  })
}

function replayDisplayMessage(
  data: SessionData,
  message: TranscriptV2Display.DisplayTranscriptMessage,
  sessionID: string,
  thinking: boolean,
  limits: Record<string, number>,
): ReplayMessage {
  switch (message.type) {
    case "user":
      return replayDisplayUser(data, message, sessionID)
    case "synthetic":
      return replayDisplayTextCommit("system", message.text, message.id)
    case "assistant":
      return replayDisplayAssistant(data, message, sessionID, thinking, limits)
    case "shell":
      return replayDisplayShell(message)
    case "compaction":
      return replayDisplayTextCommit("system", message.summary, message.id)
    case "agent-switched":
    case "model-switched":
      return { commits: [] }
  }
}

function replayDisplayUser(
  data: SessionData,
  message: TranscriptV2Display.DisplayUser,
  sessionID: string,
): ReplayMessage {
  data.role.set(message.id, "user")
  const commits: StreamCommit[] = []
  if (message.text.trim()) {
    commits.push({
      kind: "user",
      text: message.text,
      phase: "start",
      source: "system",
      messageID: message.id,
    })
  }

  for (const request of message.taskRequests ?? []) {
    const id = request.id
    data.msg.set(id, message.id)
    data.ids.add(id)
    commits.push({
      kind: "tool",
      text: request.description || request.prompt,
      phase: "start",
      source: "tool",
      messageID: message.id,
      partID: id,
      tool: "task",
      part: {
        id,
        sessionID,
        messageID: message.id,
        type: "tool",
        callID: id,
        tool: "task",
        state: {
          status: "completed",
          input: { description: request.description, prompt: request.prompt, subagent_type: request.agent },
          output: "",
          title: "task",
          metadata: {},
          time: { start: message.time.created, end: message.time.completed ?? message.time.created },
        },
      },
      toolState: "completed",
    })
  }

  return { commits }
}

function replayDisplayTextCommit(kind: "system", text: string, messageID: string): ReplayMessage {
  if (!text.trim()) return { commits: [] }
  return {
    commits: [
      {
        kind,
        text,
        phase: "start",
        source: "system",
        messageID,
      },
    ],
  }
}

function replayDisplayAssistant(
  data: SessionData,
  message: TranscriptV2Display.DisplayAssistant,
  sessionID: string,
  thinking: boolean,
  limits: Record<string, number>,
): ReplayMessage {
  const commits: StreamCommit[] = []
  let patch: FooterPatch | undefined
  const assistantInfo = displayAssistantInfo(message, sessionID)
  const info = apply(
    data,
    {
      id: `bootstrap:v2:message:${message.id}`,
      type: "message.updated",
      properties: {
        sessionID,
        info: assistantInfo,
      },
    },
    sessionID,
    thinking,
    limits,
  )
  commits.push(...info.commits)
  patch = mergePatch(patch, info.footer?.patch)

  for (const content of message.content) {
    const next = replayDisplayAssistantContent(data, message, content, sessionID, thinking, limits)
    commits.push(...next.commits)
    patch = mergePatch(patch, next.patch)
  }

  return { commits, patch }
}

function displayAssistantInfo(message: TranscriptV2Display.DisplayAssistant, sessionID: string): AssistantMessage {
  return {
    id: message.id,
    sessionID,
    role: "assistant",
    time: {
      created: message.time.created,
      ...(message.time.completed !== undefined ? { completed: message.time.completed } : {}),
    },
    parentID: "",
    modelID: message.model.id,
    providerID: message.model.providerID,
    mode: "chat",
    agent: message.agent,
    path: { cwd: "", root: "" },
    cost: message.cost ?? 0,
    tokens: message.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ...(message.finish !== undefined ? { finish: message.finish } : {}),
    ...(message.error !== undefined ? { error: displayAssistantError(message.error) } : {}),
  }
}

function displayAssistantError(error: NonNullable<TranscriptV2Display.DisplayAssistant["error"]>): AssistantMessage["error"] {
  switch (error.type) {
    case "unknown":
      return { name: "UnknownError", data: { message: error.message } }
    case "aborted":
      return { name: "MessageAbortedError", data: { message: error.message } }
    case "api":
      return {
        name: "APIError",
        data: {
          message: error.message,
          isRetryable: error.isRetryable,
          ...(error.statusCode !== undefined ? { statusCode: error.statusCode } : {}),
          ...(error.responseHeaders !== undefined ? { responseHeaders: error.responseHeaders } : {}),
          ...(error.responseBody !== undefined ? { responseBody: error.responseBody } : {}),
          ...(error.metadata !== undefined ? { metadata: error.metadata } : {}),
        },
      }
    case "auth":
      return { name: "ProviderAuthError", data: { providerID: error.providerID, message: error.message } }
    case "context_overflow":
      return {
        name: "ContextOverflowError",
        data: {
          message: error.message,
          ...(error.responseBody !== undefined ? { responseBody: error.responseBody } : {}),
        },
      }
    case "output_length":
      return { name: "MessageOutputLengthError", data: {} }
    case "structured_output":
      return { name: "StructuredOutputError", data: { message: error.message, retries: error.retries } }
  }
}

function replayDisplayAssistantContent(
  data: SessionData,
  message: TranscriptV2Display.DisplayAssistant,
  content: TranscriptV2Display.DisplayAssistantContent,
  sessionID: string,
  thinking: boolean,
  limits: Record<string, number>,
): ReplayMessage {
  if (content.type === "patch") {
    const text = content.files.length > 0 ? `Patch ${content.hash}\n${content.files.join("\n")}` : `Patch ${content.hash}`
    return replayDisplayTextCommit("system", text, message.id)
  }

  const part = content.type === "tool" ? displayToolPart(content, message.id, sessionID) : displayTextPart(content, message, sessionID)
  const next = apply(
    data,
    {
      id: `bootstrap:v2:part:${content.id}`,
      type: "message.part.updated",
      properties: {
        sessionID,
        part,
        time: message.time.completed ?? message.time.created,
      },
    },
    sessionID,
    thinking,
    limits,
  )
  return { commits: next.commits, patch: next.footer?.patch }
}

function displayTextPart(
  content: TranscriptV2Display.DisplayAssistantText | TranscriptV2Display.DisplayAssistantReasoning,
  message: TranscriptV2Display.DisplayAssistant,
  sessionID: string,
) {
  return {
    id: content.id,
    sessionID,
    messageID: message.id,
    type: content.type,
    text: content.text,
    time: { start: message.time.created, ...(message.time.completed ? { end: message.time.completed } : {}) },
  } as const
}

function displayToolPart(
  content: TranscriptV2Display.DisplayAssistantTool,
  messageID: string,
  sessionID: string,
): ToolPart {
  const base = {
    id: content.id,
    sessionID,
    messageID,
    type: "tool" as const,
    callID: content.callID,
    tool: content.name,
  }
  const state = content.state
  const output = toolOutputText("content" in state ? state.content : [])
  if (state.status === "pending") {
    return { ...base, state: { status: "pending", input: {}, raw: state.input } }
  }
  if (state.status === "running") {
    return {
      ...base,
      state: {
        status: "running",
        input: state.input,
        title: content.title,
        metadata: content.provider,
        time: { start: content.time.ran ?? content.time.created },
      },
    }
  }
  if (state.status === "completed") {
    return {
      ...base,
      state: {
        status: "completed",
        input: state.input,
        output,
        title: content.title ?? content.name,
        metadata: content.provider ?? {},
        time: {
          start: content.time.ran ?? content.time.created,
          end: content.time.completed ?? content.time.ran ?? content.time.created,
        },
      },
    }
  }
  return {
    ...base,
    state: {
      status: "error",
      input: state.input,
      error: typeof state.error === "string" ? state.error : state.error.message,
      metadata: content.provider,
      time: {
        start: content.time.ran ?? content.time.created,
        end: content.time.completed ?? content.time.ran ?? content.time.created,
      },
    },
  }
}

function toolOutputText(content: readonly TranscriptV2Display.DisplayToolOutput[]) {
  return content
    .flatMap((item) => {
      if (item.type === "text") return [item.text]
      return [`${item.name ?? item.uri}`]
    })
    .join("\n")
}

function replayDisplayShell(message: TranscriptV2Display.DisplayShell): ReplayMessage {
  return {
    commits: [
      {
        kind: "tool",
        text: message.output,
        phase: "progress",
        source: "tool",
        partID: message.id,
        tool: "bash",
        shell: { callID: message.callID, command: message.command },
        toolState: "completed",
      },
    ],
  }
}
