import type { ContentBlock, ContentChunk, ResourceLink, Role } from "@agentclientprotocol/sdk"
import path from "node:path"
import { pathToFileURL } from "node:url"
import type { TranscriptV2Display } from "../session/transcript-v2-display"

export type PromptPart =
  | {
      type: "text"
      text: string
      synthetic?: boolean
      ignored?: boolean
    }
  | {
      type: "file"
      url: string
      mime: string
      filename?: string
    }

export type ReplayPart =
  | {
      type: "text"
      text: string
      synthetic?: boolean
      ignored?: boolean
    }
  | {
      type: "file"
      url: string
      mime: string
      filename?: string
    }
  | {
      type: "reasoning"
      text: string
    }

export function promptContentToParts(content: readonly ContentBlock[]): PromptPart[] {
  return content.flatMap(contentBlockToParts)
}

export function contentBlockToParts(block: ContentBlock): PromptPart[] {
  switch (block.type) {
    case "text":
      return [
        {
          type: "text",
          text: block.text,
          ...audienceFlags(block.annotations?.audience ?? undefined),
        },
      ]

    case "image":
      if (block.data) {
        return [
          {
            type: "file",
            url: `data:${block.mimeType};base64,${block.data}`,
            filename: filenameFromUri(block.uri ?? undefined) ?? "image",
            mime: block.mimeType,
          },
        ]
      }
      if (block.uri?.startsWith("data:")) {
        return [
          {
            type: "file",
            url: block.uri,
            filename: filenameFromUri(block.uri) ?? "image",
            mime: block.mimeType,
          },
        ]
      }
      if (block.uri?.startsWith("http://") || block.uri?.startsWith("https://")) {
        return [
          {
            type: "file",
            url: block.uri,
            filename: filenameFromUri(block.uri) ?? "image",
            mime: block.mimeType,
          },
        ]
      }
      return []

    case "resource_link":
      return [resourceLinkToPart(block)]

    case "resource":
      if ("text" in block.resource) {
        return [{ type: "text", text: block.resource.text }]
      }
      if (block.resource.mimeType) {
        return [
          {
            type: "file",
            url: block.resource.uri.startsWith("data:")
              ? block.resource.uri
              : `data:${block.resource.mimeType};base64,${block.resource.blob}`,
            filename: filenameFromUri(block.resource.uri) ?? "file",
            mime: block.resource.mimeType,
          },
        ]
      }
      return []

    default:
      return []
  }
}

export function partsToContentChunks(parts: readonly ReplayPart[]): ContentChunk[] {
  return parts.flatMap(partToContentChunks)
}

export function displayTranscriptToReplayParts(
  messages: readonly TranscriptV2Display.DisplayTranscriptMessage[],
): ReplayPart[] {
  return messages.flatMap(displayMessageToReplayParts)
}

export function displayTranscriptToContentChunks(
  messages: readonly TranscriptV2Display.DisplayTranscriptMessage[],
): ContentChunk[] {
  return partsToContentChunks(displayTranscriptToReplayParts(messages))
}

export function partToContentChunks(part: ReplayPart): ContentChunk[] {
  switch (part.type) {
    case "text":
      if (!part.text) return []
      return [
        {
          content: {
            type: "text",
            text: part.text,
            ...partAudience(part),
          },
        },
      ]

    case "file":
      return filePartToContentChunks(part)

    case "reasoning":
      if (!part.text) return []
      return [
        {
          content: {
            type: "text",
            text: part.text,
          },
        },
      ]
  }
}

function resourceLinkToPart(link: ResourceLink): PromptPart {
  const parsed = uriToFilePart(link.uri, link.mimeType ?? "text/plain", link.name)
  if (parsed.type === "file") return parsed
  return { type: "text", text: parsed.text }
}

function uriToFilePart(
  uri: string,
  mime: string,
  filename?: string,
): Extract<PromptPart, { type: "file" }> | Extract<PromptPart, { type: "text" }> {
  try {
    if (uri.startsWith("file://")) {
      return {
        type: "file",
        url: uri,
        filename: filename ?? filenameFromUri(uri) ?? "file",
        mime,
      }
    }
    if (uri.startsWith("zed://")) {
      const pathname = new URL(uri).searchParams.get("path")
      if (pathname) {
        return {
          type: "file",
          url: pathToFileURL(pathname).href,
          filename: filename ?? (path.basename(pathname) || "file"),
          mime,
        }
      }
    }
    return { type: "text", text: uri }
  } catch {
    return { type: "text", text: uri }
  }
}

function displayMessageToReplayParts(message: TranscriptV2Display.DisplayTranscriptMessage): ReplayPart[] {
  switch (message.type) {
    case "user":
      return compactParts([
        textReplayPart(message.text),
        ...(message.files ?? []).map(displayFileToReplayPart),
        ...(message.taskRequests ?? []).map(displayTaskRequestToReplayPart),
      ])

    case "assistant":
      return compactParts([
        ...message.content.flatMap(displayAssistantContentToReplayParts),
      ])

    case "shell":
      return compactParts([textReplayPart(["Shell", `$ ${message.command}`, message.output].filter(Boolean).join("\n"))])

    case "synthetic":
      return compactParts([textReplayPart(message.text, { synthetic: true })])

    case "compaction":
      return compactParts([textReplayPart([`Compaction (${message.reason})`, message.summary].filter(Boolean).join("\n"))])

    case "agent-switched":
      return compactParts([textReplayPart(`Agent switched to ${message.agent}`)])

    case "model-switched":
      return compactParts([textReplayPart(`Model switched to ${message.model.providerID}/${message.model.id}`)])

    default:
      return assertNever(message, "display message")
  }
}

function displayAssistantContentToReplayParts(content: TranscriptV2Display.DisplayAssistantContent): ReplayPart[] {
  switch (content.type) {
    case "text":
      return compactParts([textReplayPart(content.text)])
    case "reasoning":
      return compactParts([reasoningReplayPart(content.text)])
    case "patch":
      return compactParts([textReplayPart(["Patch", ...content.files].join("\n"))])
    case "tool":
      return displayToolToReplayParts(content)
    default:
      return assertNever(content, "display assistant content")
  }
}

function displayToolToReplayParts(tool: TranscriptV2Display.DisplayAssistantTool): ReplayPart[] {
  const label = tool.title ?? tool.name
  const header = `Tool ${label} ${tool.state.status}`
  switch (tool.state.status) {
    case "pending":
      return compactParts([textReplayPart([header, stringifyDisplayValue(tool.state.input)].filter(Boolean).join("\n"))])
    case "running":
    case "completed":
      return compactParts([
        textReplayPart([header, stringifyDisplayValue(tool.state.input)].filter(Boolean).join("\n")),
        ...tool.state.content.map(displayToolOutputToReplayPart),
      ])
    case "error":
      return compactParts([
        textReplayPart(
          [header, stringifyDisplayValue(tool.state.input), displayToolError(tool.state.error)].filter(Boolean).join("\n"),
        ),
        ...tool.state.content.map(displayToolOutputToReplayPart),
      ])
    default:
      return assertNever(tool.state, "display tool state")
  }
}

function displayTaskRequestToReplayPart(request: TranscriptV2Display.DisplayTaskRequest): ReplayPart | undefined {
  return textReplayPart(
    [
      `Task request for ${request.agent}`,
      request.command ? `Command: ${request.command}` : undefined,
      request.description,
      request.prompt,
    ]
      .filter(Boolean)
      .join("\n"),
  )
}

function displayFileToReplayPart(file: NonNullable<TranscriptV2Display.DisplayUser["files"]>[number]): ReplayPart | undefined {
  if (!file.uri || !file.mime) return undefined
  return { type: "file", url: file.uri, mime: file.mime, filename: file.name }
}

function displayToolOutputToReplayPart(output: TranscriptV2Display.DisplayToolOutput): ReplayPart | undefined {
  switch (output.type) {
    case "text":
      return textReplayPart(output.text)
    case "file":
      return { type: "file", url: output.uri, mime: output.mime, filename: output.name }
    default:
      return assertNever(output, "display tool output")
  }
}

function assertNever(value: never, kind: string): never {
  throw new Error(`Unsupported ACP ${kind}: ${variantType(value)}`)
}

function variantType(value: unknown) {
  if (value && typeof value === "object" && "type" in value) return String((value as { type?: unknown }).type)
  if (value && typeof value === "object" && "status" in value) return String((value as { status?: unknown }).status)
  return typeof value
}

function textReplayPart(text: string, flags?: Pick<Extract<ReplayPart, { type: "text" }>, "synthetic" | "ignored">): ReplayPart | undefined {
  if (!text) return undefined
  return { type: "text", text, ...flags }
}

function reasoningReplayPart(text: string): ReplayPart | undefined {
  if (!text) return undefined
  return { type: "reasoning", text }
}

function compactParts(parts: readonly (ReplayPart | undefined)[]): ReplayPart[] {
  return parts.filter((part): part is ReplayPart => Boolean(part))
}

function stringifyDisplayValue(value: unknown) {
  if (typeof value === "string") return value
  if (value === undefined || value === null) return ""
  return JSON.stringify(value)
}

function displayToolError(error: { message?: string; type?: string }) {
  if (error.message) return `Error: ${error.message}`
  if (error.type) return `Error: ${error.type}`
  return "Error"
}

function filePartToContentChunks(part: Extract<ReplayPart, { type: "file" }>): ContentChunk[] {
  if (part.url.startsWith("file://")) {
    return [
      {
        content: {
          type: "resource_link",
          uri: part.url,
          name: part.filename ?? "file",
          mimeType: part.mime,
        },
      },
    ]
  }
  if (!part.url.startsWith("data:")) return []

  const data = decodeDataUrl(part.url)
  if (!data) return []
  if (data.mime.startsWith("image/")) {
    return [
      {
        content: {
          type: "image",
          mimeType: data.mime,
          data: data.base64,
          uri: pathToFileURL(part.filename ?? "image").href,
        },
      },
    ]
  }

  return [
    {
      content: {
        type: "resource",
        resource:
          data.mime.startsWith("text/") || data.mime === "application/json"
            ? {
                uri: pathToFileURL(part.filename ?? "file").href,
                mimeType: data.mime,
                text: Buffer.from(data.base64, "base64").toString("utf8"),
              }
            : {
                uri: pathToFileURL(part.filename ?? "file").href,
                mimeType: data.mime,
                blob: data.base64,
              },
      },
    },
  ]
}

function decodeDataUrl(url: string) {
  const match = /^data:([^;]+);base64,(.*)$/.exec(url)
  if (!match) return
  return { mime: match[1], base64: match[2] }
}

function audienceFlags(audience: readonly Role[] | null | undefined) {
  if (audience?.length === 1 && audience[0] === "assistant") return { synthetic: true }
  if (audience?.length === 1 && audience[0] === "user") return { ignored: true }
  return {}
}

function partAudience(part: Extract<ReplayPart, { type: "text" }>) {
  const audience: Role[] | undefined = part.synthetic ? ["assistant"] : part.ignored ? ["user"] : undefined
  if (!audience) return {}
  return { annotations: { audience } }
}

function filenameFromUri(uri: string | undefined) {
  if (!uri) return
  if (uri.startsWith("data:")) return
  try {
    const parsed = new URL(uri)
    const name = path.basename(parsed.pathname)
    return name || undefined
  } catch {
    return path.basename(uri) || undefined
  }
}
