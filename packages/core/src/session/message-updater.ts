import { produce, type WritableDraft } from "immer"
import { DateTime, Effect, Schema } from "effect"
import { ToolOutput } from "../tool-output"
import { SessionEvent } from "./event"
import { SessionMessage } from "./message"

const decodeToolContent = Schema.decodeUnknownSync(ToolOutput.Content)

export type MemoryState = {
  messages: SessionMessage.Message[]
  pendingCompactions?: PendingCompaction[]
}

export type PendingCompaction = {
  id: SessionMessage.ID
  metadata?: Record<string, unknown>
  sessionID: SessionEvent.Compaction.Started["data"]["sessionID"]
  reason: SessionMessage.Compaction["reason"]
  time: SessionMessage.Compaction["time"]
}

export interface Adapter {
  readonly getAssistant: (messageID: SessionMessage.ID) => Effect.Effect<SessionMessage.Assistant | undefined>
  readonly getCurrentAssistant: () => Effect.Effect<SessionMessage.Assistant | undefined>
  readonly getCurrentCompaction: () => Effect.Effect<SessionMessage.Compaction | undefined>
  readonly getCurrentShell: (callID: string) => Effect.Effect<SessionMessage.Shell | undefined>
  readonly updateAssistant: (assistant: SessionMessage.Assistant) => Effect.Effect<void>
  readonly updateCompaction: (compaction: SessionMessage.Compaction) => Effect.Effect<void>
  readonly updateShell: (shell: SessionMessage.Shell) => Effect.Effect<void>
  readonly appendMessage: (message: SessionMessage.Message) => Effect.Effect<void>
  readonly appendCompaction: (message: SessionMessage.Compaction) => Effect.Effect<void>
  readonly recordCompactionStarted: (compaction: PendingCompaction) => Effect.Effect<void>
  readonly getPendingCompactionStarted: (
    event: SessionEvent.Compaction.Ended,
  ) => Effect.Effect<PendingCompaction | undefined>
  readonly clearPendingCompactionStarted: (id: SessionMessage.ID) => Effect.Effect<void>
}

export function memory(state: MemoryState): Adapter {
  const assistantIndex = (messageID: SessionMessage.ID) =>
    state.messages.findIndex((message) => message.type === "assistant" && message.id === messageID)
  const activeAssistantIndex = () => {
    const newestIndex = state.messages.reduce<number>((selected, message, index) => {
      if (message.type !== "assistant") return selected
      if (selected < 0) return index
      const current = state.messages[selected]
      if (current?.type !== "assistant") return index
      const currentCreated = DateTime.toEpochMillis(current.time.created)
      const messageCreated = DateTime.toEpochMillis(message.time.created)
      if (messageCreated > currentCreated) return index
      if (messageCreated === currentCreated && message.id > current.id) return index
      return selected
    }, -1)
    const newest = state.messages[newestIndex]
    return newest?.type === "assistant" && !newest.time.completed ? newestIndex : -1
  }
  const activeCompactionIndex = () => state.messages.findLastIndex((message) => message.type === "compaction")
  const activeShellIndex = (callID: string) =>
    state.messages.findLastIndex((message) => message.type === "shell" && message.callID === callID)

  return {
    getAssistant(messageID) {
      return Effect.sync(() => {
        const index = assistantIndex(messageID)
        if (index < 0) return
        const assistant = state.messages[index]
        return assistant?.type === "assistant" ? assistant : undefined
      })
    },
    getCurrentAssistant() {
      return Effect.sync(() => {
        const index = activeAssistantIndex()
        if (index < 0) return
        const assistant = state.messages[index]
        return assistant?.type === "assistant" ? assistant : undefined
      })
    },
    getCurrentCompaction() {
      return Effect.sync(() => {
        const index = activeCompactionIndex()
        if (index < 0) return
        const compaction = state.messages[index]
        return compaction?.type === "compaction" ? compaction : undefined
      })
    },
    getCurrentShell(callID) {
      return Effect.sync(() => {
        const index = activeShellIndex(callID)
        if (index < 0) return
        const shell = state.messages[index]
        return shell?.type === "shell" ? shell : undefined
      })
    },
    updateAssistant(assistant) {
      return Effect.sync(() => {
        const index = assistantIndex(assistant.id)
        if (index < 0) return
        const current = state.messages[index]
        if (current?.type !== "assistant") return
        state.messages[index] = assistant
      })
    },
    updateCompaction(compaction) {
      return Effect.sync(() => {
        const index = activeCompactionIndex()
        if (index < 0) return
        const current = state.messages[index]
        if (current?.type !== "compaction") return
        state.messages[index] = compaction
      })
    },
    updateShell(shell) {
      return Effect.sync(() => {
        const index = activeShellIndex(shell.callID)
        if (index < 0) return
        const current = state.messages[index]
        if (current?.type !== "shell") return
        state.messages[index] = shell
      })
    },
    appendMessage(message) {
      return Effect.sync(() => {
        state.messages.push(message)
      })
    },
    appendCompaction(message) {
      return Effect.sync(() => {
        if (state.messages.some((existing) => existing.id === message.id)) return
        state.messages.push(message)
      })
    },
    recordCompactionStarted(compaction) {
      return Effect.sync(() => {
        state.pendingCompactions = [
          ...(state.pendingCompactions ?? []).filter((pending) => pending.sessionID !== compaction.sessionID),
          compaction,
        ]
      })
    },
    getPendingCompactionStarted(event) {
      return Effect.sync(() => {
        return (state.pendingCompactions ?? []).findLast((compaction) => compaction.sessionID === event.data.sessionID)
      })
    },
    clearPendingCompactionStarted(id) {
      return Effect.sync(() => {
        state.pendingCompactions = (state.pendingCompactions ?? []).filter((compaction) => compaction.id !== id)
      })
    },
  }
}

export function update(adapter: Adapter, event: SessionEvent.Event) {
  type DraftAssistant = WritableDraft<SessionMessage.Assistant>
  type DraftTool = WritableDraft<SessionMessage.AssistantTool>
  type DraftText = WritableDraft<SessionMessage.AssistantText>
  type DraftReasoning = WritableDraft<SessionMessage.AssistantReasoning>

  const latestTool = (assistant: DraftAssistant | undefined, callID?: string) =>
    assistant?.content.findLast(
      (item): item is DraftTool => item.type === "tool" && (callID === undefined || item.callID === callID),
    )

  const latestText = (assistant: DraftAssistant | undefined) =>
    assistant?.content.findLast((item): item is DraftText => item.type === "text")

  const latestReasoning = (assistant: DraftAssistant | undefined, reasoningID: string) =>
    assistant?.content.findLast(
      (item): item is DraftReasoning => item.type === "reasoning" && item.reasoningID === reasoningID,
    )

  const targetAssistant = (assistantMessageID?: string) =>
    assistantMessageID ? adapter.getAssistant(SessionMessage.ID.make(assistantMessageID)) : adapter.getCurrentAssistant()

  return Effect.gen(function* () {
    yield* SessionEvent.All.match(event, {
      "session.next.agent.switched": (event) => {
        return adapter.appendMessage(
          new SessionMessage.AgentSwitched({
            id: event.id,
            type: "agent-switched",
            metadata: event.metadata,
            agent: event.data.agent,
            time: { created: event.data.timestamp },
          }),
        )
      },
      "session.next.model.switched": (event) => {
        return adapter.appendMessage(
          new SessionMessage.ModelSwitched({
            id: event.id,
            type: "model-switched",
            metadata: event.metadata,
            model: event.data.model,
            time: { created: event.data.timestamp },
          }),
        )
      },
      "session.next.prompted": (event) => {
        return adapter.appendMessage(
          new SessionMessage.User({
            id: event.id,
            type: "user",
            metadata: event.metadata,
            text: event.data.prompt.text,
            files: event.data.prompt.files,
            agents: event.data.prompt.agents,
            references: event.data.prompt.references,
            time: { created: event.data.timestamp },
          }),
        )
      },
      "session.next.synthetic": (event) => {
        return adapter.appendMessage(
          new SessionMessage.Synthetic({
            sessionID: event.data.sessionID,
            text: event.data.text,
            id: event.id,
            type: "synthetic",
            time: { created: event.data.timestamp },
          }),
        )
      },
      "session.next.shell.started": (event) => {
        return adapter.appendMessage(
          new SessionMessage.Shell({
            id: event.id,
            type: "shell",
            metadata: event.metadata,
            callID: event.data.callID,
            command: event.data.command,
            output: "",
            time: { created: event.data.timestamp },
          }),
        )
      },
      "session.next.shell.ended": (event) => {
        return Effect.gen(function* () {
          const currentShell = yield* adapter.getCurrentShell(event.data.callID)
          if (currentShell) {
            yield* adapter.updateShell(
              produce(currentShell, (draft) => {
                draft.output = event.data.output
                draft.time.completed = event.data.timestamp
              }),
            )
          }
        })
      },
      "session.next.step.started": (event) => {
        return Effect.gen(function* () {
          const currentAssistant = yield* adapter.getCurrentAssistant()
          if (currentAssistant) {
            yield* adapter.updateAssistant(
              produce(currentAssistant, (draft) => {
                draft.time.completed = event.data.timestamp
              }),
            )
          }
          yield* adapter.appendMessage(
            new SessionMessage.Assistant({
              id: event.id,
              type: "assistant",
              agent: event.data.agent,
              model: event.data.model,
              time: { created: event.data.timestamp },
              content: [],
              snapshot: event.data.snapshot ? { start: event.data.snapshot } : undefined,
            }),
          )
        })
      },
      "session.next.step.ended": (event) => {
        return Effect.gen(function* () {
          const currentAssistant = yield* targetAssistant(event.data.assistantMessageID)
          if (currentAssistant) {
            yield* adapter.updateAssistant(
              produce(currentAssistant, (draft) => {
                draft.time.completed = event.data.timestamp
                draft.finish = event.data.finish
                draft.cost = event.data.cost
                draft.tokens = event.data.tokens
                if (event.data.snapshot) draft.snapshot = { ...draft.snapshot, end: event.data.snapshot }
              }),
            )
          }
        })
      },
      "session.next.step.failed": (event) => {
        return Effect.gen(function* () {
          const currentAssistant = yield* targetAssistant(event.data.assistantMessageID)
          if (currentAssistant) {
            yield* adapter.updateAssistant(
              produce(currentAssistant, (draft) => {
                draft.time.completed = event.data.timestamp
                draft.finish = "error"
                draft.error = event.data.error
              }),
            )
          }
        })
      },
      "session.next.text.started": (event) => {
        return Effect.gen(function* () {
          const currentAssistant = yield* adapter.getCurrentAssistant()
          if (currentAssistant) {
            yield* adapter.updateAssistant(
              produce(currentAssistant, (draft) => {
                draft.content.push(new SessionMessage.AssistantText({ type: "text", id: event.id, text: "" }) as DraftText)
              }),
            )
          }
        })
      },
      "session.next.text.delta": (event) => {
        return Effect.gen(function* () {
          const currentAssistant = yield* adapter.getCurrentAssistant()
          if (currentAssistant) {
            yield* adapter.updateAssistant(
              produce(currentAssistant, (draft) => {
                const match = latestText(draft)
                if (match) match.text += event.data.delta
              }),
            )
          }
        })
      },
      "session.next.text.ended": (event) => {
        return Effect.gen(function* () {
          const currentAssistant = yield* adapter.getCurrentAssistant()
          if (currentAssistant) {
            yield* adapter.updateAssistant(
              produce(currentAssistant, (draft) => {
                const match = latestText(draft)
                if (match) match.text = event.data.text
              }),
            )
          }
        })
      },
      "session.next.tool.input.started": (event) => {
        return Effect.gen(function* () {
          const currentAssistant = yield* targetAssistant(event.data.assistantMessageID)
          if (currentAssistant) {
            yield* adapter.updateAssistant(
              produce(currentAssistant, (draft) => {
                draft.content.push(
                  new SessionMessage.AssistantTool({
                    type: "tool",
                    id: event.id,
                    callID: event.data.callID,
                    name: event.data.name,
                    time: { created: event.data.timestamp },
                    state: new SessionMessage.ToolStatePending({ status: "pending", input: "" }),
                  }) as DraftTool,
                )
              }),
            )
          }
        })
      },
      "session.next.tool.input.delta": (event) => {
        return Effect.gen(function* () {
          const currentAssistant = yield* adapter.getCurrentAssistant()
          if (currentAssistant) {
            yield* adapter.updateAssistant(
              produce(currentAssistant, (draft) => {
                const match = latestTool(draft, event.data.callID)
                // oxlint-disable-next-line no-base-to-string -- event.delta is a Schema.String (runtime string)
                if (match && match.state.status === "pending") match.state.input += event.data.delta
              }),
            )
          }
        })
      },
      "session.next.tool.input.ended": () => Effect.void,
      "session.next.tool.called": (event) => {
        return Effect.gen(function* () {
          const currentAssistant = yield* targetAssistant(event.data.assistantMessageID)
          if (currentAssistant) {
            yield* adapter.updateAssistant(
              produce(currentAssistant, (draft) => {
                const match = latestTool(draft, event.data.callID)
                if (match && match.state.status === "pending") {
                  match.provider = event.data.provider
                  match.time.ran = event.data.timestamp
                  match.state = new SessionMessage.ToolStateRunning({
                    status: "running",
                    input: event.data.input,
                    structured: {},
                    content: [],
                  }) as DraftTool["state"]
                }
              }),
            )
          }
        })
      },
      "session.next.tool.progress": (event) => {
        return Effect.gen(function* () {
          const currentAssistant = yield* adapter.getCurrentAssistant()
          if (currentAssistant) {
            yield* adapter.updateAssistant(
              produce(currentAssistant, (draft) => {
                const match = latestTool(draft, event.data.callID)
                if (match && match.state.status === "running") {
                  match.state.structured = event.data.structured
                  match.state.content = event.data.content.map((item) => decodeToolContent(item))
                }
              }),
            )
          }
        })
      },
      "session.next.tool.success": (event) => {
        return Effect.gen(function* () {
          const currentAssistant = yield* targetAssistant(event.data.assistantMessageID)
          if (currentAssistant) {
            yield* adapter.updateAssistant(
              produce(currentAssistant, (draft) => {
                const match = latestTool(draft, event.data.callID)
                if (match && match.state.status === "running") {
                  match.provider = event.data.provider
                  if (event.data.title !== undefined) match.title = event.data.title
                  match.time.completed = event.data.timestamp
                  match.state = new SessionMessage.ToolStateCompleted({
                    status: "completed",
                    input: match.state.input,
                    structured: event.data.structured,
                    content: event.data.content.map((item) => decodeToolContent(item)),
                  }) as DraftTool["state"]
                }
              }),
            )
          }
        })
      },
      "session.next.tool.failed": (event) => {
        return Effect.gen(function* () {
          const currentAssistant = yield* targetAssistant(event.data.assistantMessageID)
          if (currentAssistant) {
            yield* adapter.updateAssistant(
              produce(currentAssistant, (draft) => {
                const match = latestTool(draft, event.data.callID)
                if (match && match.state.status === "running") {
                  match.provider = event.data.provider
                  match.time.completed = event.data.timestamp
                  match.state = new SessionMessage.ToolStateError({
                    status: "error",
                    error: event.data.error,
                    input: match.state.input,
                    structured: match.state.structured,
                    content: match.state.content.map((item) => decodeToolContent(item)),
                  }) as DraftTool["state"]
                }
              }),
            )
          }
        })
      },
      "session.next.reasoning.started": (event) => {
        return Effect.gen(function* () {
          const currentAssistant = yield* adapter.getCurrentAssistant()
          if (currentAssistant) {
            yield* adapter.updateAssistant(
              produce(currentAssistant, (draft) => {
                draft.content.push(
                  new SessionMessage.AssistantReasoning({
                    type: "reasoning",
                    id: event.id,
                    reasoningID: event.data.reasoningID,
                    text: "",
                  }) as DraftReasoning,
                )
              }),
            )
          }
        })
      },
      "session.next.reasoning.delta": (event) => {
        return Effect.gen(function* () {
          const currentAssistant = yield* adapter.getCurrentAssistant()
          if (currentAssistant) {
            yield* adapter.updateAssistant(
              produce(currentAssistant, (draft) => {
                const match = latestReasoning(draft, event.data.reasoningID)
                if (match) match.text += event.data.delta
              }),
            )
          }
        })
      },
      "session.next.reasoning.ended": (event) => {
        return Effect.gen(function* () {
          const currentAssistant = yield* adapter.getCurrentAssistant()
          if (currentAssistant) {
            yield* adapter.updateAssistant(
              produce(currentAssistant, (draft) => {
                const match = latestReasoning(draft, event.data.reasoningID)
                if (match) match.text = event.data.text
              }),
            )
          }
        })
      },
      "session.next.retried": (event) => {
        return Effect.gen(function* () {
          const currentAssistant = yield* adapter.getCurrentAssistant()
          if (currentAssistant) {
            yield* adapter.updateAssistant(
              produce(currentAssistant, (draft) => {
                if (
                  draft.retries?.some(
                    (retry) =>
                      retry.attempt === event.data.attempt &&
                      DateTime.toEpochMillis(retry.time.created) === DateTime.toEpochMillis(event.data.timestamp),
                  )
                )
                  return
                draft.retries = [
                  ...(draft.retries ?? []),
                  new SessionMessage.AssistantRetry({
                    attempt: event.data.attempt,
                    error: event.data.error,
                    time: { created: event.data.timestamp },
                  }),
                ]
              }),
            )
          }
        })
      },
      "session.next.compaction.started": (event) => {
        return adapter.recordCompactionStarted({
          id: event.id,
          metadata: event.metadata,
          sessionID: event.data.sessionID,
          reason: event.data.reason,
          time: { created: event.data.timestamp },
        })
      },
      "session.next.compaction.delta": () => {
        return Effect.void
      },
      "session.next.compaction.ended": (event) => {
        return Effect.gen(function* () {
          const started = yield* adapter.getPendingCompactionStarted(event)
          if (!started) return
          yield* adapter.appendCompaction(
            new SessionMessage.Compaction({
              id: started.id,
              type: "compaction",
              metadata: started.metadata,
              reason: started.reason,
              summary: event.data.text,
              include: event.data.include,
              time: started.time,
            }),
          )
          yield* adapter.clearPendingCompactionStarted(started.id)
        })
      },
    })
  })
}

export * as SessionMessageUpdater from "./message-updater"
