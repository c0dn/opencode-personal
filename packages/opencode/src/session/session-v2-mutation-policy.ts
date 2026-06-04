import type { SessionMessage } from "@opencode-ai/core/session/message"

export type StandaloneSnapshotEvidence = "absent" | "present" | "unknown"
export type RuntimePatchTargeting = "proven" | "missing" | "unknown"
export type RollbackProof = "proven" | "missing" | "unknown"

export type Operation = "revert" | "remove" | "update" | "fork"

export type BlockReason =
  | "legacy-looking-target-id"
  | "legacy-looking-content-id"
  | "target-message-not-found"
  | "target-range-invalid"
  | "target-content-not-found"
  | "standalone-snapshot-present"
  | "standalone-snapshot-unknown"
  | "missing-assistant-snapshot-boundary"
  | "runtime-patch-targeting-missing"
  | "runtime-patch-targeting-unknown"
  | "missing-rollback-proof"
  | "unknown-rollback-proof"

type NonEmptyBlockReasons = [BlockReason, ...BlockReason[]]

export type Decision =
  | {
      operation: Operation
      eligible: true
      reasons: []
    }
    | {
        operation: Operation
        eligible: false
        reasons: [BlockReason, ...BlockReason[]]
      }

export type Decisions = {
  revert: Decision
  remove: Decision
  update: Decision
  fork: Decision
}

export type Input = {
  messages: CanonicalMessage[]
  target: Target
  proof: Proof
}

export type Target = {
  startId: CanonicalId
  endId: CanonicalId
  contentId?: CanonicalId
}

export type Proof = {
  standaloneSnapshots: StandaloneSnapshotEvidence
  runtimePatchTargeting: RuntimePatchTargeting
  rollback: RollbackProof
}

export type CanonicalMessage = SessionMessage.Message

export type AssistantContent = SessionMessage.AssistantContent

export type AssistantSnapshot = NonNullable<SessionMessage.Assistant["snapshot"]>

export type CanonicalId = SessionMessage.ID

export function decide(input: Input): Decisions {
  const range = resolveRange(input.messages, input.target)
  const commonReasons = commonBlockReasons(input, range)
  const diffReasons = diffRelevantBlockReasons(input, range)

  return {
    revert: decision("revert", [...commonReasons, ...diffReasons, ...rollbackBlockReasons(input.proof.rollback)]),
    remove: decision("remove", commonReasons),
    update: decision("update", commonReasons),
    fork: decision("fork", commonReasons),
  }
}

function decision(operation: Operation, reasons: BlockReason[]): Decision {
  const uniqueReasons = Array.from(new Set(reasons))
  if (uniqueReasons.length === 0) return { operation, eligible: true, reasons: [] }
  const nonEmptyReasons: NonEmptyBlockReasons = [uniqueReasons[0]!, ...uniqueReasons.slice(1)]
  return { operation, eligible: false, reasons: nonEmptyReasons }
}

function commonBlockReasons(input: Input, range: RangeResolution): BlockReason[] {
  return [
    ...targetIdBlockReasons(input.target),
    ...rangeBlockReasons(range),
    ...contentTargetBlockReasons(input.target, range),
    ...standaloneSnapshotBlockReasons(input.proof.standaloneSnapshots),
    ...patchTargetingBlockReasons(input.proof.runtimePatchTargeting, range.messages),
  ]
}

function targetIdBlockReasons(target: Target): BlockReason[] {
  const reasons: BlockReason[] = []
  if (isLegacyLookingId(target.startId) || isLegacyLookingId(target.endId)) reasons.push("legacy-looking-target-id")
  if (target.contentId && isLegacyLookingId(target.contentId)) reasons.push("legacy-looking-content-id")
  return reasons
}

function rangeBlockReasons(range: RangeResolution): BlockReason[] {
  if (range.status === "missing") return ["target-message-not-found"]
  if (range.status === "invalid") return ["target-range-invalid"]
  return []
}

function contentTargetBlockReasons(target: Target, range: RangeResolution): BlockReason[] {
  if (!target.contentId || range.status !== "resolved") return []
  const contentId = target.contentId
  if (range.messages.some((message) => hasAssistantContent(message, contentId))) return []
  return ["target-content-not-found"]
}

function standaloneSnapshotBlockReasons(evidence: StandaloneSnapshotEvidence): BlockReason[] {
  if (evidence === "present") return ["standalone-snapshot-present"]
  if (evidence === "absent") return []
  return ["standalone-snapshot-unknown"]
}

function diffRelevantBlockReasons(input: Input, range: RangeResolution): BlockReason[] {
  if (range.status !== "resolved") return []
  const reasons: BlockReason[] = []
  if (range.messages.some(isAssistantWithMissingSnapshotBoundary)) reasons.push("missing-assistant-snapshot-boundary")
  return reasons
}

function patchTargetingBlockReasons(proof: RuntimePatchTargeting, messages: CanonicalMessage[]): BlockReason[] {
  if (!messages.some(hasPatchContent)) return []
  if (proof === "missing") return ["runtime-patch-targeting-missing"]
  if (proof === "proven") return []
  return ["runtime-patch-targeting-unknown"]
}

function rollbackBlockReasons(proof: RollbackProof): BlockReason[] {
  if (proof === "missing") return ["missing-rollback-proof"]
  if (proof === "proven") return []
  return ["unknown-rollback-proof"]
}

type RangeResolution =
  | { status: "resolved"; messages: CanonicalMessage[] }
  | { status: "missing"; messages: [] }
  | { status: "invalid"; messages: [] }

function resolveRange(messages: CanonicalMessage[], target: Target): RangeResolution {
  const startIndex = messages.findIndex((message) => message.id === target.startId)
  const endIndex = messages.findIndex((message) => message.id === target.endId)
  if (startIndex === -1 || endIndex === -1) return { status: "missing", messages: [] }
  if (startIndex > endIndex) return { status: "invalid", messages: [] }
  return { status: "resolved", messages: messages.slice(startIndex, endIndex + 1) }
}

function isAssistantWithMissingSnapshotBoundary(message: CanonicalMessage) {
  return message.type === "assistant" && (!message.snapshot?.start || !message.snapshot?.end)
}

function hasPatchContent(message: CanonicalMessage) {
  return message.type === "assistant" && message.content.some((content) => content.type === "patch")
}

function hasAssistantContent(message: CanonicalMessage, contentId: CanonicalId) {
  return message.type === "assistant" && message.content.some((content) => content.id === contentId)
}

function isLegacyLookingId(id: string) {
  return id.startsWith("msg") || id.startsWith("prt")
}

export * as SessionV2MutationPolicy from "./session-v2-mutation-policy"
