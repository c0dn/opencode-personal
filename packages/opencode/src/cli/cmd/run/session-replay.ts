import type {
  Event,
  PermissionRequest,
  QuestionRequest,
  SessionMessage,
} from "@opencode-ai/sdk/v2"
import { bootstrapSessionData, v2BootstrapSessionData, createSessionData, reduceSessionData, type SessionData } from "./session-data"
import { messagePrompt, type SessionMessages } from "./session.shared"
import type { FooterPatch, LocalReplayRow, StreamCommit } from "./types"

type ReplayInput = {
  messages: SessionMessages
  permissions: PermissionRequest[]
  questions: QuestionRequest[]
  thinking: boolean
  limits: Record<string, number>
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

type V2ReplayInput = {
  messages: SessionMessage[]
  sessionID: string
  permissions: PermissionRequest[]
  questions: QuestionRequest[]
  thinking: boolean
  limits: Record<string, number>
}

function v2ContentToPart(
  item: NonNullable<Extract<SessionMessage, { type: "assistant" }>["content"][number]>,
  messageID: string,
  sessionID: string,
) {
  if (item.type === "text") {
    return {
      type: "text" as const,
      id: item.id,
      sessionID,
      messageID,
      text: item.text,
    }
  }

  if (item.type === "reasoning") {
    return {
      type: "reasoning" as const,
      id: item.id,
      sessionID,
      messageID,
      text: item.text,
    }
  }

  if (item.type === "tool") {
    const start = item.time.ran ?? item.time.created
    if (item.state.status === "running") {
      return {
        type: "tool" as const,
        id: item.id,
        sessionID,
        messageID,
        callID: item.id,
        tool: item.name,
        state: {
          status: "running" as const,
          input: item.state.input,
          time: { start },
        },
      }
    }

    if (item.state.status === "completed") {
      return {
        type: "tool" as const,
        id: item.id,
        sessionID,
        messageID,
        callID: item.id,
        tool: item.name,
        state: {
          status: "completed" as const,
          input: item.state.input,
          output: toolOutput(item.state),
          title: item.name,
          time: { start, end: item.time.completed ?? start },
        },
      }
    }

    if (item.state.status === "error") {
      return {
        type: "tool" as const,
        id: item.id,
        sessionID,
        messageID,
        callID: item.id,
        tool: item.name,
        state: {
          status: "error" as const,
          input: item.state.input,
          error: toolErrorOutput(item.state),
          time: { start, end: item.time.completed ?? start },
        },
      }
    }

    return undefined
  }

  return undefined
}

function toolOutput(state: { output?: unknown; content?: Array<{ type: string; text?: string }> }): string {
  if (typeof state.output === "string" && state.output.trim()) return state.output
  if (Array.isArray(state.content)) {
    return state.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("")
  }
  return ""
}

function toolErrorOutput(state: { error?: unknown }): string {
  if (typeof state.error === "string") return state.error
  if (state.error && typeof state.error === "object" && "message" in state.error) {
    const msg = (state.error as { message: unknown }).message
    if (typeof msg === "string") return msg
  }
  return "unknown error"
}

function v2ReplayMessage(
  data: SessionData,
  message: SessionMessage,
  sessionID: string,
  thinking: boolean,
  limits: Record<string, number>,
): ReplayMessage {
  if (message.type === "user") {
    const body = message.text.trim()
    if (!body) {
      return { commits: [] }
    }

    return {
      commits: [
        {
          kind: "user",
          text: body,
          phase: "start",
          source: "system",
          messageID: message.id,
        },
      ],
    }
  }

  if (message.type !== "assistant") {
    return { commits: [] }
  }

  const commits: StreamCommit[] = []
  let patch: FooterPatch | undefined

  const info = apply(
    data,
    {
      id: `bootstrap:message:${message.id}`,
      type: "message.updated",
      properties: {
        sessionID,
        info: {
          id: message.id,
          sessionID,
          role: "assistant" as const,
          model: {
            providerID: message.model.providerID,
            modelID: message.model.id,
          },
          ...(message.tokens ? { tokens: message.tokens } : {}),
          ...(message.cost !== undefined ? { cost: message.cost } : {}),
          ...(message.error ? { error: message.error } : {}),
        },
      },
    } as unknown as Event,
    sessionID,
    thinking,
    limits,
  )
  commits.push(...info.commits)
  patch = mergePatch(patch, info.footer?.patch)

  for (const item of message.content) {
    const part = v2ContentToPart(item, message.id, sessionID)
    if (!part) {
      continue
    }

    const next = apply(
      data,
      {
        id: `bootstrap:part:${part.id}`,
        type: "message.part.updated",
        properties: {
          sessionID,
          part,
          time: 0,
        },
    } as unknown as Event,
      sessionID,
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

export function v2ReplaySession(input: V2ReplayInput): SessionReplay {
  const data = createSessionData()
  const commits: StreamCommit[] = []
  let patch: FooterPatch | undefined

  v2BootstrapSessionData({
    data,
    messages: input.messages,
    permissions: input.permissions,
    questions: input.questions,
  })

  for (const message of input.messages) {
    const next = v2ReplayMessage(data, message, input.sessionID, input.thinking, input.limits)
    commits.push(...next.commits)
    patch = mergePatch(patch, next.patch)
  }

  return {
    data,
    commits,
    patch: replayPatch(data, patch),
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

export function v2ReplayLocalRows(
  messages: SessionMessage[],
  commits: StreamCommit[],
  rows: LocalReplayRow[],
): StreamCommit[] {
  const persisted = new Set(messages.map((message) => message.id))
  return insertLocalRows(persisted, commits, rows)
}

export function replayLocalRows(
  messages: SessionMessages,
  commits: StreamCommit[],
  rows: LocalReplayRow[],
): StreamCommit[] {
  const persisted = new Set(messages.map((message) => message.info.id))
  return insertLocalRows(persisted, commits, rows)
}

function insertLocalRows(
  persisted: Set<string>,
  commits: StreamCommit[],
  rows: LocalReplayRow[],
): StreamCommit[] {
  return rows.reduce((out, local) => {
    const row = local.commit
    if (row.kind === "user" && row.messageID && persisted.has(row.messageID)) {
      return out
    }

    if (!row.messageID) {
      return [...out, row]
    }

    const exact = local.after
      ? out.findIndex(
          (commit) =>
            commit.kind === local.after?.kind &&
            commit.text === local.after.text &&
            commit.phase === local.after.phase &&
            commit.toolState === local.after.toolState &&
            (local.after.partID ? commit.partID === local.after.partID : commit.messageID === local.after.messageID),
        )
      : -1
    const anchored =
      exact !== -1
        ? exact
        : local.after
          ? out.findLastIndex((commit) =>
              local.after?.partID
                ? commit.partID === local.after.partID
                : commit.kind === local.after?.kind && commit.messageID === local.after.messageID,
            )
          : -1
    if (anchored !== -1) {
      const commit = out[anchored]
      const visible = local.after?.visible
      if (commit && visible && commit.text.startsWith(visible) && commit.text.length > visible.length) {
        return [
          ...out.slice(0, anchored),
          { ...commit, text: visible },
          row,
          { ...commit, text: commit.text.slice(visible.length) },
          ...out.slice(anchored + 1),
        ]
      }

      return [...out.slice(0, anchored + 1), row, ...out.slice(anchored + 1)]
    }

    const after = out.findIndex((commit) => commit.kind === "user" && commit.messageID === row.messageID)
    if (after !== -1) {
      return [...out.slice(0, after + 1), row, ...out.slice(after + 1)]
    }

    const before = out.findIndex((commit) => commit.messageID && row.messageID! < commit.messageID)
    if (before === -1) {
      return [...out, row]
    }

    return [...out.slice(0, before), row, ...out.slice(before)]
  }, commits)
}

export function replayActiveText(data: SessionData, current: SessionData): StreamCommit[] {
  return [...current.part.entries()].flatMap(([partID, kind]) => {
    if (kind === "user" || current.end.has(partID) || data.ids.has(partID)) {
      return []
    }

    const text = current.text.get(partID) ?? ""
    const existing = data.text.get(partID) ?? ""
    const sent = current.sent.get(partID) ?? 0
    const existingSent = data.sent.get(partID) ?? 0
    const visible = current.visible.get(partID) ?? ""
    const existingVisible = data.visible.get(partID) ?? ""
    if (!text.startsWith(existing) || existingSent > sent || !visible.startsWith(existingVisible)) {
      return []
    }

    data.part.set(partID, kind)
    data.text.set(partID, text)
    data.sent.set(partID, sent)
    data.visible.set(partID, visible)
    const messageID = current.msg.get(partID)
    if (messageID) {
      data.msg.set(partID, messageID)
      const role = current.role.get(messageID)
      if (role) {
        data.role.set(messageID, role)
      }
    }

    const chunk = visible.slice(existingVisible.length)
    if (!chunk) {
      return []
    }

    return [
      {
        kind,
        text: chunk,
        phase: "progress",
        source: kind,
        ...(messageID ? { messageID } : {}),
        partID,
      },
    ] satisfies StreamCommit[]
  })
}
