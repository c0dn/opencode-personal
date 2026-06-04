import type { SessionMessage } from "@opencode-ai/core/session/message"
import type { Session } from "../session/session"
import { TranscriptV2PublicPayload } from "../session/transcript-v2-public-payload"

export const PUBLIC_TRANSCRIPT_SHARE_ITEM_TYPE = "public_transcript_v2" as const

export type PublicTranscriptShareItemV2 = {
  type: typeof PUBLIC_TRANSCRIPT_SHARE_ITEM_TYPE
  payload: TranscriptV2PublicPayload.PublicTranscriptPayloadV2
}

export type PublicTranscriptShareSyncBodyV2 = {
  secret: string
  data: readonly [PublicTranscriptShareItemV2]
}

export function toPublicTranscriptShareItemV2(payload: TranscriptV2PublicPayload.PublicTranscriptPayloadV2): PublicTranscriptShareItemV2 {
  TranscriptV2PublicPayload.assertPublicTranscriptPayloadV2(payload)
  return { type: PUBLIC_TRANSCRIPT_SHARE_ITEM_TYPE, payload }
}

export function toPublicTranscriptShareSyncBodyV2(secret: string, payload: TranscriptV2PublicPayload.PublicTranscriptPayloadV2): PublicTranscriptShareSyncBodyV2 {
  return { secret, data: [toPublicTranscriptShareItemV2(payload)] }
}

export function toPublicTranscriptShareSyncBodyV2FromRows(
  secret: string,
  session: Session.Info,
  messages: readonly SessionMessage.Message[],
  readiness: TranscriptV2PublicPayload.PublicTranscriptReadiness | undefined,
): PublicTranscriptShareSyncBodyV2 {
  return toPublicTranscriptShareSyncBodyV2(secret, TranscriptV2PublicPayload.toPublicTranscriptPayloadV2(session, messages, readiness))
}

export * as TranscriptV2PublicShare from "./transcript-v2-public-share"
