import { SessionMessage } from "@opencode-ai/core/session/message"
import type { ModelMessage } from "ai"
import type { CompactionV2Context } from "./compaction-v2-context"
import { MessageV2Model } from "./message-v2-model"

export const TOOL_OUTPUT_MAX_CHARS = 2_000

export const SUMMARY_TEMPLATE = `Output exactly the Markdown structure shown inside <template> and keep the section order unchanged. Do not include the <template> tags in your response.
<template>
## Goal
- [single-sentence task summary]

## Constraints & Preferences
- [user constraints, preferences, specs, or "(none)"]

## Progress
### Done
- [completed work or "(none)"]

### In Progress
- [current work or "(none)"]

### Blocked
- [blockers or "(none)"]

## Key Decisions
- [decision and why, or "(none)"]

## Next Steps
- [ordered next actions or "(none)"]

## Critical Context
- [important technical facts, errors, open questions, or "(none)"]

## Relevant Files
- [file or directory path: why it matters, or "(none)"]
</template>

Rules:
- Keep every section, even when empty.
- Use terse bullets, not prose paragraphs.
- Preserve exact file paths, commands, error strings, and identifiers when known.
- Do not mention the summary process or that context was compacted.`

export type PromptInput = {
  previousSummary?: string
  context?: readonly string[]
  promptOverride?: string
}

export type TransformMessages = (messages: SessionMessage.Message[]) => readonly SessionMessage.Message[]

export type ProviderMessagesInput = Pick<CompactionV2Context.Selection, "head" | "previousSummary"> &
  PromptInput & {
    transform?: TransformMessages
  }

export function buildPrompt(input: PromptInput = {}) {
  return input.promptOverride ?? [anchor(input.previousSummary), SUMMARY_TEMPLATE, ...(input.context ?? [])].join("\n\n")
}

export async function toProviderMessages(input: ProviderMessagesInput): Promise<ModelMessage[]> {
  const head = input.transform ? input.transform(input.head.slice()) : input.head
  const messages = await MessageV2Model.toModelMessages(Array.from(head), {
    stripMedia: true,
    toolOutputMaxChars: TOOL_OUTPUT_MAX_CHARS,
  })
  return [
    ...messages,
    {
      role: "user",
      content: [{ type: "text", text: buildPrompt(input) }],
    },
  ]
}

function anchor(previousSummary: string | undefined) {
  return previousSummary
    ? [
        "Update the anchored summary below using the conversation history above.",
        "Preserve still-true details, remove stale details, and merge in the new facts.",
        "<previous-summary>",
        previousSummary,
        "</previous-summary>",
      ].join("\n")
    : "Create a new anchored summary from the conversation history above."
}

export * as CompactionV2Prompt from "./compaction-v2-prompt"
