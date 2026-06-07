import { Session } from "@/session/session"
import { TranscriptV2Public } from "@/session/transcript-v2-public"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { AgentAttachment, FileAttachment, ReferenceAttachment, Source } from "@opencode-ai/core/session/prompt"
import { ToolOutput } from "@opencode-ai/core/tool-output"
import { SessionID } from "../../session/schema"
import { effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"
import * as prompts from "@clack/prompts"
import { EOL } from "os"
import { Effect } from "effect"

function redact(kind: string, id: string, value: string) {
  return value.trim() ? `[redacted:${kind}:${id}]` : value
}

function data(kind: string, id: string, value: Record<string, unknown>) {
  return Object.keys(value).length ? { redacted: `${kind}:${id}` } : value
}

function optionalData(kind: string, id: string, value: Record<string, unknown> | undefined) {
  if (!value) return value
  return data(kind, id, value)
}

function providerData(
  kind: string,
  id: string,
  value: SessionMessage.AssistantReasoning["providerMetadata"] | undefined,
) {
  if (!value) return value
  return Object.keys(value).length ? { redacted: { value: `${kind}:${id}` } } : value
}

function unknownData(kind: string, id: string, value: unknown) {
  if (value === undefined) return value
  if (typeof value === "string") return redact(kind, id, value)
  if (!value || typeof value !== "object") return value
  return data(kind, id, value as Record<string, unknown>)
}

function source(id: string, value: { text: string; start: number; end: number } | undefined) {
  if (!value) return value
  return new Source({
    ...value,
    text: redact("source-text", id, value.text),
  })
}

function diff<T extends { file?: string; patch?: string }>(kind: string, diffs: readonly T[] | undefined) {
  return diffs?.map((item, i) => ({
    ...item,
    file: item.file === undefined ? undefined : redact(`${kind}-file`, String(i), item.file),
    patch: item.patch === undefined ? undefined : redact(`${kind}-patch`, String(i), item.patch),
  }))
}

function fileAttachment(file: NonNullable<SessionMessage.User["files"]>[number], id: string) {
  return new FileAttachment({
    ...file,
    uri: redact("file-uri", id, file.uri),
    name: file.name === undefined ? undefined : redact("file-name", id, file.name),
    description: file.description === undefined ? undefined : redact("file-description", id, file.description),
    source: source(id, file.source),
  })
}

function referenceAttachment(reference: NonNullable<SessionMessage.User["references"]>[number], id: string) {
  return new ReferenceAttachment({
    ...reference,
    uri: reference.uri === undefined ? undefined : redact("reference-uri", id, reference.uri),
    repository: reference.repository === undefined ? undefined : redact("reference-repository", id, reference.repository),
    branch: reference.branch === undefined ? undefined : redact("reference-branch", id, reference.branch),
    target: reference.target === undefined ? undefined : redact("reference-target", id, reference.target),
    targetUri: reference.targetUri === undefined ? undefined : redact("reference-target-uri", id, reference.targetUri),
    problem: reference.problem === undefined ? undefined : redact("reference-problem", id, reference.problem),
    source: source(id, reference.source),
  })
}

function toolContent(content: SessionMessage.ToolStateCompleted["content"][number], id: string) {
  if (content.type === "text") {
    return ToolOutput.text({ ...content, text: redact("tool-content", id, content.text) })
  }
  return ToolOutput.file({
    ...content,
    source:
      content.source.type === "data"
        ? { ...content.source, data: redact("tool-file-data", id, content.source.data) }
        : content.source.type === "url"
          ? { ...content.source, url: redact("tool-file-url", id, content.source.url) }
          : { ...content.source, uri: redact("tool-file-uri", id, content.source.uri) },
    name: content.name === undefined ? undefined : redact("tool-file-name", id, content.name),
  })
}

function toolState(state: SessionMessage.ToolState, id: string): SessionMessage.ToolState {
  if (state.status === "pending") {
    return new SessionMessage.ToolStatePending({ ...state, input: redact("tool-input", id, state.input) })
  }
  if (state.status === "running") {
    return new SessionMessage.ToolStateRunning({
      ...state,
      input: data("tool-input", id, state.input),
      structured: data("tool-structured", id, state.structured),
      content: state.content.map((content) => toolContent(content, id)),
    })
  }
  if (state.status === "completed") {
    return new SessionMessage.ToolStateCompleted({
      ...state,
      input: data("tool-input", id, state.input),
      attachments: state.attachments?.map((file, index) => fileAttachment(file, `${id}-${index}`)),
      content: state.content.map((content) => toolContent(content, id)),
      structured: data("tool-structured", id, state.structured),
      result: unknownData("tool-result", id, state.result),
    })
  }
  return new SessionMessage.ToolStateError({
    ...state,
    input: data("tool-input", id, state.input),
    content: state.content.map((content) => toolContent(content, id)),
    structured: data("tool-structured", id, state.structured),
    error: { ...state.error, message: redact("tool-error", id, state.error.message) },
    result: unknownData("tool-result", id, state.result),
  })
}

function assistantContent(content: SessionMessage.AssistantContent, messageID: string): SessionMessage.AssistantContent {
  if (content.type === "text") {
    return new SessionMessage.AssistantText({ ...content, text: redact("assistant-text", content.id, content.text) })
  }
  if (content.type === "reasoning") {
    return new SessionMessage.AssistantReasoning({
      ...content,
      text: redact("assistant-reasoning", content.id, content.text),
      providerMetadata: providerData("reasoning-provider-metadata", content.id, content.providerMetadata),
    })
  }
  return new SessionMessage.AssistantTool({
    ...content,
    provider: !content.provider
      ? content.provider
      : {
          ...content.provider,
          metadata: providerData("tool-provider-metadata", content.id, content.provider.metadata),
          resultMetadata: providerData("tool-result-metadata", content.id, content.provider.resultMetadata),
        },
    state: toolState(content.state, `${messageID}-${content.id}`),
  })
}

function assistantError(error: SessionMessage.Assistant["error"], id: string) {
  if (!error) return error
  return { ...error, message: redact("assistant-error", id, error.message) }
}

function message(message: SessionMessage.Message): SessionMessage.Message {
  switch (message.type) {
    case "user":
      return new SessionMessage.User({
        ...message,
        text: redact("user-text", message.id, message.text),
        files: message.files?.map((file, index) => fileAttachment(file, `${message.id}-${index}`)),
        agents: message.agents?.map((agent) => new AgentAttachment({ ...agent, source: source(message.id, agent.source) })),
        references: message.references?.map((reference, index) => referenceAttachment(reference, `${message.id}-${index}`)),
        metadata: optionalData("message-metadata", message.id, message.metadata),
      })
    case "synthetic":
      return new SessionMessage.Synthetic({
        ...message,
        text: redact("synthetic-text", message.id, message.text),
        metadata: optionalData("message-metadata", message.id, message.metadata),
      })
    case "shell":
      return new SessionMessage.Shell({
        ...message,
        command: redact("shell-command", message.id, message.command),
        output: redact("shell-output", message.id, message.output),
        metadata: optionalData("message-metadata", message.id, message.metadata),
      })
    case "assistant":
      return new SessionMessage.Assistant({
        ...message,
        content: message.content.map((content) => assistantContent(content, message.id)),
        snapshot: !message.snapshot
          ? message.snapshot
          : {
              start:
                message.snapshot.start === undefined
                  ? undefined
                  : redact("assistant-snapshot-start", message.id, message.snapshot.start),
              end:
                message.snapshot.end === undefined
                  ? undefined
                  : redact("assistant-snapshot-end", message.id, message.snapshot.end),
            },
        error: assistantError(message.error, message.id),
        metadata: optionalData("message-metadata", message.id, message.metadata),
      })
    case "compaction":
      return new SessionMessage.Compaction({
        ...message,
        summary: redact("compaction-summary", message.id, message.summary),
        metadata: optionalData("message-metadata", message.id, message.metadata),
      })
    case "agent-switched":
      return new SessionMessage.AgentSwitched({
        ...message,
        metadata: optionalData("message-metadata", message.id, message.metadata),
      })
    case "model-switched":
      return new SessionMessage.ModelSwitched({
        ...message,
        metadata: optionalData("message-metadata", message.id, message.metadata),
      })
    default:
      return message
  }
}

export function sanitizeTranscript(data: TranscriptV2Public.Payload): TranscriptV2Public.Payload {
  return {
    version: 2,
    info: {
      ...data.info,
      title: redact("session-title", data.info.id, data.info.title),
      directory: redact("session-directory", data.info.id, data.info.directory),
      path: data.info.path === undefined ? undefined : redact("session-path", data.info.id, data.info.path),
      metadata: optionalData("session-metadata", data.info.id, data.info.metadata),
      summary: !data.info.summary
        ? data.info.summary
        : {
            ...data.info.summary,
            diffs: diff("session-diff", data.info.summary.diffs),
          },
      revert: !data.info.revert
        ? data.info.revert
        : {
            ...data.info.revert,
            snapshot:
              data.info.revert.snapshot === undefined
                ? undefined
                : redact("revert-snapshot", data.info.id, data.info.revert.snapshot),
            diff:
              data.info.revert.diff === undefined
                ? undefined
                : redact("revert-diff", data.info.id, data.info.revert.diff),
          },
    },
    messages: data.messages.map(message),
  }
}

export const ExportCommand = effectCmd({
  command: "export [sessionID]",
  describe: "export session data as JSON",
  builder: (yargs) =>
    yargs
      .positional("sessionID", {
        describe: "session id to export",
        type: "string",
      })
      .option("sanitize", {
        describe: "redact sensitive transcript and file data",
        type: "boolean",
      }),
  handler: Effect.fn("Cli.export")(function* (args) {
    return yield* run(args)
  }),
})

const run = Effect.fn("Cli.export.body")(function* (args: { sessionID?: string; sanitize?: boolean }) {
  const svc = yield* Session.Service
  let sessionID = args.sessionID ? SessionID.make(args.sessionID) : undefined
  process.stderr.write(`Exporting session: ${sessionID ?? "latest"}\n`)

  if (!sessionID) {
    UI.empty()
    prompts.intro("Export session", { output: process.stderr })

    const sessions = yield* svc.list()

    if (sessions.length === 0) {
      prompts.log.error("No sessions found", { output: process.stderr })
      prompts.outro("Done", { output: process.stderr })
      return
    }

    sessions.sort((a, b) => b.time.updated - a.time.updated)

    const selectedSession = yield* Effect.promise(() =>
      prompts.autocomplete({
        message: "Select session to export",
        maxItems: 10,
        options: sessions.map((session) => ({
          label: session.title,
          value: session.id,
          hint: `${new Date(session.time.updated).toLocaleString()} • ${session.id.slice(-8)}`,
        })),
        output: process.stderr,
      }),
    )

    if (prompts.isCancel(selectedSession)) {
      return yield* Effect.die(new UI.CancelledError())
    }

    sessionID = selectedSession

    prompts.outro("Exporting session...", { output: process.stderr })
  }

  // Match legacy try/catch — catches both typed failures and defects
  // (Session.Service.get throws NotFoundError as a defect, not a typed E).
  return yield* Effect.gen(function* () {
    const exportData = yield* TranscriptV2Public.load(sessionID!).pipe(Effect.provide(SessionV2.defaultLayer))

    process.stdout.write(
      JSON.stringify(TranscriptV2Public.encode(args.sanitize ? sanitizeTranscript(exportData) : exportData), null, 2),
    )
    process.stdout.write(EOL)
  }).pipe(Effect.catchCause(() => fail(`Session not found: ${sessionID!}`)))
})
