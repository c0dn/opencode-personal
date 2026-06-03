import { SessionMessage } from "@opencode-ai/core/session/message"
import type { JSONValue, SharedV3ProviderMetadata } from "@ai-sdk/provider"
import { isMedia } from "@/util/media"
import { DateTime } from "effect"
import { convertToModelMessages, type ModelMessage, type UIMessage } from "ai"

const PrunedToolOutput = "[Old tool result content cleared]"
const InterruptedToolOutput = "[Tool execution was interrupted]"

export type ToModelMessagesOptions = {
  stripMedia?: boolean
  toolOutputMaxChars?: number
  model?: ToolMediaModel
}

export type ToolMediaModel = { api: { npm: string; id: string } }

export async function toModelMessages(
  input: SessionMessage.Message[],
  options?: ToModelMessagesOptions,
): Promise<ModelMessage[]> {
  const toolNames = new Set<string>()
  const messages: UIMessage[] = []

  for (const message of chronological(input)) {
    if (message.type === "user") {
      // User task requests are transcript/task orchestration metadata, not provider
      // prompt content. Keep them out of model context even when they are the
      // only user-side payload on the turn.
      const parts: UIMessage["parts"] = [
        ...(message.text === "" ? [] : [{ type: "text" as const, text: message.text }]),
        ...(message.files ?? []).map((file) => userFilePart(file, options)),
      ]
      if (parts.length > 0) messages.push({ id: message.id, role: "user", parts })
      continue
    }

    if (message.type === "assistant") {
      if (message.error && !isAbortedAssistantWithContent(message)) continue

      const parts: UIMessage["parts"] = []
      const extractedMedia: ToolOutputFile[] = []
      for (const content of message.content) {
        if (content.type === "text") {
          // Provider metadata on assistant text is intentionally deferred for the
          // v2 migration slice; the canonical v2 text shape only carries text.
          parts.push({ type: "text", text: content.text })
          continue
        }

        if (content.type === "reasoning") {
          // Signed/provider reasoning metadata is intentionally deferred until a
          // first-class v2 schema field exists for it.
          parts.push({ type: "reasoning", text: content.text })
          continue
        }

        if (content.type === "patch") {
          // Patch content is transcript/display data only. It is intentionally
          // excluded from provider model context and must not become a tool call.
          continue
        }

        toolNames.add(content.name)
        const tool = toolPart(content, options)
        parts.push(tool.part)
        extractedMedia.push(...tool.extractedMedia)
      }
      if (parts.length > 0) messages.push({ id: message.id, role: "assistant", parts })
      if (extractedMedia.length > 0) {
        messages.push({
          id: `${message.id}_tool_media`,
          role: "user",
          parts: [
            { type: "text", text: "Attached media from tool result:" },
            ...extractedMedia.map((file) => userFilePart({ uri: file.uri, mime: file.mime, name: file.name }, undefined)),
          ],
        })
      }
    }
  }

  return await convertToModelMessages(messages, {
    // @ts-expect-error convertToModelMessages only needs tools[name]?.toModelOutput here.
    tools: Object.fromEntries(Array.from(toolNames).map((toolName) => [toolName, { toModelOutput }])),
  })
}

function userFilePart(file: NonNullable<SessionMessage.User["files"]>[number], options: ToModelMessagesOptions | undefined) {
  if (options?.stripMedia && isMedia(file.mime)) {
    return {
      type: "text" as const,
      text: `[Attached ${file.mime}: ${file.name ?? "file"}]`,
    }
  }
  return {
    type: "file" as const,
    url: file.uri,
    mediaType: file.mime,
    filename: file.name,
  }
}

function chronological(input: SessionMessage.Message[]) {
  return input.slice().sort((left, right) => {
    const time = DateTime.toEpochMillis(left.time.created) - DateTime.toEpochMillis(right.time.created)
    if (time !== 0) return time
    if (left.id < right.id) return -1
    if (left.id > right.id) return 1
    return 0
  })
}

function isAbortedAssistantWithContent(message: SessionMessage.Assistant) {
  return message.error?.type === "aborted" && message.content.some(isMeaningfulAssistantContent)
}

function isMeaningfulAssistantContent(content: SessionMessage.AssistantContent) {
  if (content.type === "text") return content.text.trim().length > 0
  if (content.type === "tool") return true
  return false
}

function toolPart(
  content: SessionMessage.AssistantTool,
  options: ToModelMessagesOptions | undefined,
): { part: UIMessage["parts"][number]; extractedMedia: ToolOutputFile[] } {
  const metadata = providerMetadata(content.provider?.metadata)
  const base = {
    type: `tool-${content.name}` as `tool-${string}`,
    toolCallId: content.callID,
    input: content.state.input,
    ...(content.provider?.executed ? { providerExecuted: true } : {}),
    ...(metadata ? { callProviderMetadata: metadata } : {}),
  }

  if (content.state.status === "completed") {
    const output = content.time.pruned ? { value: PrunedToolOutput, extractedMedia: [] } : toolOutput(content.state.content, options)
    return {
      part: {
        ...base,
        state: "output-available",
        output: output.value,
      },
      extractedMedia: output.extractedMedia,
    }
  }

  if (content.state.status === "error") {
    return {
      part: {
        ...base,
        state: "output-error",
        errorText: content.state.error.message,
      },
      extractedMedia: [],
    }
  }

  return {
    part: {
      ...base,
      state: "output-error",
      errorText: InterruptedToolOutput,
    },
    extractedMedia: [],
  }
}

function providerMetadata(input: Record<string, unknown> | undefined): SharedV3ProviderMetadata | undefined {
  if (!input) return undefined
  const entries = Object.entries(input).filter((entry): entry is [string, Record<string, JSONValue>] => {
    return isJSONObject(entry[1])
  })
  if (entries.length === 0) return undefined
  return Object.fromEntries(entries)
}

function isJSONObject(input: unknown): input is Record<string, JSONValue> {
  return Boolean(input && typeof input === "object" && !Array.isArray(input) && Object.values(input).every(isJSONValue))
}

function isJSONValue(input: unknown): input is JSONValue {
  if (input === null) return true
  if (typeof input === "string" || typeof input === "boolean") return true
  if (typeof input === "number") return Number.isFinite(input)
  if (Array.isArray(input)) return input.every(isJSONValue)
  return isJSONObject(input)
}

type ToolOutputFile = { uri: string; mime: string; name?: string }

function toolOutput(
  content: SessionMessage.ToolStateCompleted["content"],
  options: ToModelMessagesOptions | undefined,
): { value: string | { text: string; attachments: Array<{ mime: string; url: string; filename?: string }> }; extractedMedia: ToolOutputFile[] } {
  const text = truncateToolOutput(
    content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join(""),
    options?.toolOutputMaxChars,
  )
  const files = content.filter((item): item is ToolOutputFile & { type: "file" } => item.type === "file")
  const extractedMedia = options?.stripMedia ? [] : files.filter((item) => shouldExtractToolMedia(item, options?.model))
  const attachments = options?.stripMedia
    ? []
    : files
        .filter((item) => !shouldExtractToolMedia(item, options?.model))
        .map((item) => ({ mime: item.mime, url: item.uri, filename: item.name }))

  if (attachments.length === 0) return { value: text, extractedMedia }
  return { value: { text, attachments }, extractedMedia }
}

function shouldExtractToolMedia(file: ToolOutputFile, model: ToolMediaModel | undefined) {
  if (!model) return false
  if (!isMedia(file.mime)) return false
  return !isToolResultMediaSupported(file.mime, model)
}

function isToolResultMediaSupported(mime: string, model: ToolMediaModel) {
  switch (model.api.npm) {
    case "@ai-sdk/anthropic":
    case "@ai-sdk/openai":
    case "@ai-sdk/google-vertex/anthropic":
      return true
    case "@ai-sdk/amazon-bedrock":
    case "@ai-sdk/xai":
      return mime.startsWith("image/")
    case "@ai-sdk/google": {
      const id = model.api.id.toLowerCase()
      return id.includes("gemini-3") && !id.includes("gemini-2")
    }
    default:
      return false
  }
}

function truncateToolOutput(text: string, maxChars?: number) {
  if (!maxChars || maxChars <= 0 || text.length <= maxChars) return text
  const omitted = text.length - maxChars
  return `${text.slice(0, maxChars)}\n[Tool output truncated for compaction: omitted ${omitted} chars]`
}

function toModelOutput(options: { output: unknown }) {
  if (typeof options.output === "string") return { type: "text", value: options.output }
  if (isToolOutputWithAttachments(options.output)) {
    const attachments = options.output.attachments.filter((attachment) => {
      return attachment.url.startsWith("data:") && attachment.url.includes(",")
    })
    return {
      type: "content",
      value: [
        ...(options.output.text ? [{ type: "text" as const, text: options.output.text }] : []),
        ...attachments.map((attachment) => ({
          type: "media" as const,
          mediaType: attachment.mime,
          data: dataUrlPayload(attachment.url),
        })),
      ],
    }
  }
  return { type: "json", value: options.output as never }
}

function isToolOutputWithAttachments(input: unknown): input is {
  text: string
  attachments: Array<{ mime: string; url: string; filename?: string }>
} {
  return Boolean(
    input &&
      typeof input === "object" &&
      "text" in input &&
      "attachments" in input &&
      typeof input.text === "string" &&
      Array.isArray(input.attachments),
  )
}

function dataUrlPayload(input: string) {
  const comma = input.indexOf(",")
  if (comma === -1) return input
  return input.slice(comma + 1)
}

export * as MessageV2Model from "./message-v2-model"
