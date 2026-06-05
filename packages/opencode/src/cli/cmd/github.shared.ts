import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionEvent } from "@opencode-ai/core/session/event"
import type { SessionID } from "../../session/schema"
import { UI } from "../ui"

export { parseGitHubRemote } from "@/util/repository"

const TOOL: Record<string, [string, string]> = {
  todowrite: ["Todo", UI.Style.TEXT_WARNING_BOLD],
  bash: ["Shell", UI.Style.TEXT_DANGER_BOLD],
  edit: ["Edit", UI.Style.TEXT_SUCCESS_BOLD],
  glob: ["Glob", UI.Style.TEXT_INFO_BOLD],
  grep: ["Grep", UI.Style.TEXT_INFO_BOLD],
  list: ["List", UI.Style.TEXT_INFO_BOLD],
  read: ["Read", UI.Style.TEXT_HIGHLIGHT_BOLD],
  write: ["Write", UI.Style.TEXT_SUCCESS_BOLD],
  websearch: ["Search", UI.Style.TEXT_DIM_BOLD],
}

export type GitHubSessionEventPayload = Pick<EventV2.Payload, "type" | "data">
type GitHubToolCall = {
  tool: string
  input: Record<string, unknown>
  title: string
}
export type GitHubSessionEventDisplayAction =
  | {
      type: "text"
      text: string
    }
  | {
      type: "tool"
      color: string
      tool: string
      title: string
    }

/**
 * Extracts displayable text from assistant response parts.
 * Returns null for non-text responses (signals summary needed).
 * Throws only for truly empty responses.
 */
export function extractResponseText(parts: SessionV1.Part[]): string | null {
  const textPart = parts.findLast((p) => p.type === "text")
  if (textPart) return textPart.text

  // Non-text parts (tools, reasoning, step-start/step-finish, etc.) - signal summary needed
  if (parts.length > 0) return null

  throw new Error("Failed to parse response: no parts returned")
}

/**
 * Formats a PROMPT_TOO_LARGE error message with details about files in the prompt.
 * Content is base64 encoded, so we calculate original size by multiplying by 0.75.
 */
export function formatPromptTooLargeError(files: { filename: string; content: string }[]): string {
  const fileDetails =
    files.length > 0
      ? `\n\nFiles in prompt:\n${files.map((f) => `  - ${f.filename} (${((f.content.length * 0.75) / 1024).toFixed(0)} KB)`).join("\n")}`
      : ""
  return `PROMPT_TOO_LARGE: The prompt exceeds the model's context limit.${fileDetails}`
}

export function createGitHubSessionEventDisplay(sessionID: SessionID) {
  const toolCalls = new Map<string, GitHubToolCall>()

  return (evt: GitHubSessionEventPayload): GitHubSessionEventDisplayAction | undefined => {
    if (evt.type === SessionEvent.Text.Ended.type) {
      const data = evt.data as EventV2.Data<typeof SessionEvent.Text.Ended>
      if (data.sessionID !== sessionID) return
      return { type: "text", text: data.text }
    }

    if (evt.type === SessionEvent.Tool.Called.type) {
      const data = evt.data as EventV2.Data<typeof SessionEvent.Tool.Called>
      if (data.sessionID !== sessionID) return
      toolCalls.set(data.callID, { tool: data.tool, input: data.input, title: toolTitle(data.input) })
      return
    }

    if (evt.type === SessionEvent.Tool.Success.type) {
      const data = evt.data as EventV2.Data<typeof SessionEvent.Tool.Success>
      if (data.sessionID !== sessionID) return
      const call = toolCalls.get(data.callID)
      toolCalls.delete(data.callID)
      if (!call) return
      const [tool, color] = TOOL[call.tool] ?? [call.tool, UI.Style.TEXT_INFO_BOLD]
      return {
        type: "tool",
        color,
        tool,
        title: call.title,
      }
    }

    if (evt.type === SessionEvent.Tool.Failed.type) {
      const data = evt.data as EventV2.Data<typeof SessionEvent.Tool.Failed>
      if (data.sessionID !== sessionID) return
      toolCalls.delete(data.callID)
    }
  }
}

function toolTitle(input: Record<string, unknown>) {
  const title = text(input.title)
  if (title) return title
  const command = text(input.command)
  if (command) return command
  const description = text(input.description)
  if (description) return description
  if (Object.keys(input).length > 0) return JSON.stringify(input)
  return "Unknown"
}

function text(value: unknown) {
  if (typeof value !== "string") return
  return value.trim()
}
