import { Session } from "@/session/session"
import { SessionID } from "../../session/schema"
import { TranscriptV2PublicExport } from "../../session/transcript-v2-public-export"
import type { TranscriptV2PublicPayload } from "../../session/transcript-v2-public-payload"
import { effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"
import * as prompts from "@clack/prompts"
import { EOL } from "os"
import { Effect } from "effect"

type ExportFormat = "legacy" | "v2"
const REDACTED_TEXT = "[redacted]" as const
const REDACTED_URI = "redacted://file" as const

export function validateExportOptions(args: { sanitize?: boolean; format?: ExportFormat }) {
  void args
  return undefined
}

export function resolveExportFormat(format?: ExportFormat): "v2" {
  void format
  return "v2"
}

function redact(kind: string, id: string, value: string) {
  return value.trim() ? `[redacted:${kind}:${id}]` : value
}

export function sanitizePublicTranscriptPayloadV2(
  data: TranscriptV2PublicPayload.PublicTranscriptPayloadV2,
): TranscriptV2PublicPayload.PublicTranscriptPayloadV2 {
  return {
    ...data,
    session: {
      ...data.session,
      title: redact("session-title", data.session.id, data.session.title),
    },
    messages: data.messages.map(sanitizePublicMessageV2),
  }
}

function sanitizePublicMessageV2(
  message: TranscriptV2PublicPayload.PublicTranscriptMessage,
): TranscriptV2PublicPayload.PublicTranscriptMessage {
  switch (message.type) {
    case "user":
      return {
        ...message,
        text: redact("user-text", message.id, message.text),
        ...(message.taskRequests ? { taskRequests: message.taskRequests.map(sanitizeTaskRequestV2) } : {}),
      }
    case "assistant":
      return {
        ...message,
        content: message.content.map(sanitizeAssistantContentV2),
      }
    case "compaction":
      return {
        ...message,
        summary: REDACTED_TEXT,
      }
  }
}

function sanitizeTaskRequestV2(
  request: TranscriptV2PublicPayload.PublicTaskRequest,
): TranscriptV2PublicPayload.PublicTaskRequest {
  return {
    ...request,
    prompt: REDACTED_TEXT,
    description: REDACTED_TEXT,
    ...(request.command ? { command: REDACTED_TEXT } : {}),
  }
}

function sanitizeAssistantContentV2(
  content: TranscriptV2PublicPayload.PublicAssistantContent,
): TranscriptV2PublicPayload.PublicAssistantContent {
  switch (content.type) {
    case "text":
      return { ...content, text: redact("assistant-text", content.id, content.text) }
    case "patch":
      return {
        ...content,
        hash: redact("patch-hash", content.id, content.hash),
        files: content.files.map((file, index) => redact("patch-file", `${content.id}-${index}`, file)),
      }
    case "tool":
      return {
        ...content,
        ...(content.title ? { title: REDACTED_TEXT } : {}),
        state: sanitizeToolStateV2(content.state),
      }
  }
}

function sanitizeToolStateV2(state: TranscriptV2PublicPayload.PublicToolState): TranscriptV2PublicPayload.PublicToolState {
  switch (state.status) {
    case "pending":
      return { ...state, input: REDACTED_TEXT }
    case "running":
    case "completed":
      return {
        ...state,
        input: REDACTED_TEXT,
        structured: REDACTED_TEXT,
        content: state.content.map(sanitizeToolOutputV2),
      }
    case "error":
      return {
        ...state,
        input: REDACTED_TEXT,
        structured: REDACTED_TEXT,
        content: state.content.map(sanitizeToolOutputV2),
        error: REDACTED_TEXT,
      }
  }
}

function sanitizeToolOutputV2(output: TranscriptV2PublicPayload.PublicToolOutput): TranscriptV2PublicPayload.PublicToolOutput {
  if (output.type === "text") return { ...output, text: REDACTED_TEXT }
  return {
    ...output,
    uri: REDACTED_URI,
    ...(output.name ? { name: REDACTED_TEXT } : {}),
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
      })
      .option("format", {
        describe: "export payload format",
        choices: ["legacy", "v2"] as const,
        default: "v2" as const,
      }),
  handler: Effect.fn("Cli.export")(function* (args) {
    return yield* run(args)
  }),
})

const run = Effect.fn("Cli.export.body")(function* (args: { sessionID?: string; sanitize?: boolean; format?: ExportFormat }) {
  const optionError = validateExportOptions(args)
  if (optionError) return yield* fail(optionError)
  resolveExportFormat(args.format)

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

  const exportData = yield* TranscriptV2PublicExport.loadPublicTranscriptPayloadV2(sessionID!).pipe(
    Effect.catch((error) => fail(error.message)),
  )

  process.stdout.write(JSON.stringify(args.sanitize ? sanitizePublicTranscriptPayloadV2(exportData) : exportData, null, 2))
  process.stdout.write(EOL)
})
