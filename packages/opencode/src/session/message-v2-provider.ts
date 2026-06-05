import { SessionMessage } from "@opencode-ai/core/session/message"
import type { ModelMessage } from "ai"
import { MessageV2Model } from "./message-v2-model"
import type { CompactionCandidateMessage, CompactionReadiness, PromptReadiness } from "./message-v2-readiness"
import { MessageV2Readiness } from "./message-v2-readiness"

export type Converter = (messages: SessionMessage.Message[]) => Promise<ModelMessage[]>

export type PromptProviderMessages =
  | (Extract<PromptReadiness, { type: "ready" }> & { modelMessages: ModelMessage[] })
  | Exclude<PromptReadiness, { type: "ready" }>

export type CompactionProviderMessages =
  | (Extract<CompactionReadiness, { type: "ready" }> & { modelMessages: ModelMessage[] })
  | Exclude<CompactionReadiness, { type: "ready" }>

export async function preparePromptProviderMessages(input: {
  messages: readonly SessionMessage.Message[]
  convert?: Converter
}): Promise<PromptProviderMessages> {
  const readiness = MessageV2Readiness.promptProviderReadiness(input.messages)

  if (readiness.type !== "ready") return readiness

  const convert = input.convert ?? MessageV2Model.toModelMessages
  return {
    ...readiness,
    modelMessages: await convert(readiness.messages),
  }
}

export async function prepareCompactionProviderMessages(input: {
  messages: readonly CompactionCandidateMessage[]
  convert?: Converter
}): Promise<CompactionProviderMessages> {
  const readiness = MessageV2Readiness.compactionProviderReadiness(input.messages)

  if (readiness.type !== "ready") return readiness

  const convert = input.convert ?? MessageV2Model.toModelMessages
  return {
    ...readiness,
    modelMessages: await convert(readiness.messages),
  }
}

// Caller owns canonical v2 context/candidate selection. This leaf only gates the
// caller-provided messages and converts the readiness-returned slice.
export * as MessageV2Provider from "./message-v2-provider"
