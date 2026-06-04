import { describe, expect, test } from "bun:test"
import { EventV2 } from "@opencode-ai/core/event"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { DateTime } from "effect"
import { SessionV2MutationPolicy } from "../../src/session/session-v2-mutation-policy"

const model = {
  providerID: ProviderV2.ID.make("provider"),
  id: ModelV2.ID.make("model"),
  variant: ModelV2.VariantID.make("default"),
}

const operations = ["revert", "remove", "update", "fork"] as const

function id(suffix: string) {
  return EventV2.ID.make(`evt_${suffix}`)
}

function legacyId(value: string) {
  return value as SessionV2MutationPolicy.CanonicalId
}

function user(suffix: string): SessionMessage.User {
  return new SessionMessage.User({
    id: id(suffix),
    type: "user",
    text: "",
    files: [],
    agents: [],
    references: [],
    time: { created: DateTime.makeUnsafe(1) },
  })
}

function assistant(
  suffix: string,
  options?: Partial<SessionMessage.Assistant>,
): SessionMessage.Assistant {
  return new SessionMessage.Assistant({
    id: id(suffix),
    type: "assistant",
    agent: "build",
    model,
    content: [text(`${suffix}_text`)],
    snapshot: { start: `${suffix}_start`, end: `${suffix}_end` },
    time: { created: DateTime.makeUnsafe(2) },
    ...options,
  })
}

function text(suffix: string): SessionMessage.AssistantText {
  return new SessionMessage.AssistantText({ id: id(suffix), type: "text", text: "ok" })
}

function patch(suffix: string): SessionMessage.AssistantPatch {
  return new SessionMessage.AssistantPatch({ id: id(suffix), type: "patch", hash: "abc123", files: ["README.md"] })
}

type InputOverride = Omit<Partial<SessionV2MutationPolicy.Input>, "proof" | "target"> & {
  proof?: Partial<SessionV2MutationPolicy.Proof>
  target?: Partial<SessionV2MutationPolicy.Target>
}

function safeInput(
  input?: InputOverride,
): SessionV2MutationPolicy.Input {
  return {
    messages: [user("user"), assistant("assistant")],
    target: { startId: id("user"), endId: id("assistant"), ...input?.target },
    proof: {
      standaloneSnapshots: "absent",
      runtimePatchTargeting: "proven",
      rollback: "proven",
      ...input?.proof,
    },
    ...(input?.messages ? { messages: input.messages } : {}),
  }
}

function decide(input?: Parameters<typeof safeInput>[0]) {
  return SessionV2MutationPolicy.decide(safeInput(input))
}

function expectAllOperationsBlockedBy(
  result: SessionV2MutationPolicy.Decisions,
  reason: SessionV2MutationPolicy.BlockReason,
) {
  for (const operation of operations) {
    expect(result[operation].eligible).toBe(false)
    expect(result[operation].reasons).toContain(reason)
  }
}

describe("session-v2-mutation-policy", () => {
  test("canonical user/assistant target range is accepted only when proof inputs are explicit and safe", () => {
    expect(decide()).toStrictEqual({
      revert: { operation: "revert", eligible: true, reasons: [] },
      remove: { operation: "remove", eligible: true, reasons: [] },
      update: { operation: "update", eligible: true, reasons: [] },
      fork: { operation: "fork", eligible: true, reasons: [] },
    })
  })

  test("msg* target is rejected", () => {
    const result = decide({ target: { startId: legacyId("msgABC") } })

    expectAllOperationsBlockedBy(result, "legacy-looking-target-id")
  })

  test("prt* target/content ids are rejected", () => {
    const targetResult = decide({ target: { endId: legacyId("prtABC") } })
    const contentResult = decide({ target: { contentId: legacyId("prtABC") } })

    for (const operation of operations) {
      expect(targetResult[operation].eligible).toBe(false)
      expect(targetResult[operation].reasons).toContain("legacy-looking-target-id")
      expect(contentResult[operation].eligible).toBe(false)
      expect(contentResult[operation].reasons).toContain("legacy-looking-content-id")
    }
  })

  test("missing target message blocks all operations", () => {
    const result = decide({ target: { startId: id("missing") } })

    expectAllOperationsBlockedBy(result, "target-message-not-found")
  })

  test("invalid target range blocks all operations", () => {
    const result = decide({ target: { startId: id("assistant"), endId: id("user") } })

    expectAllOperationsBlockedBy(result, "target-range-invalid")
  })

  test("missing target content blocks all operations", () => {
    const result = decide({ target: { contentId: id("missing_content") } })

    expectAllOperationsBlockedBy(result, "target-content-not-found")
  })

  test("missing assistant snapshot start/end blocks revert/diff-relevant destructive policy", () => {
    const result = decide({ messages: [user("user"), assistant("assistant", { snapshot: { start: "base" } })] })

    expect(result.revert).toStrictEqual({
      operation: "revert",
      eligible: false,
      reasons: ["missing-assistant-snapshot-boundary"],
    })
    expect(result.remove.eligible).toBe(true)
    expect(result.update.eligible).toBe(true)
    expect(result.fork.eligible).toBe(true)
  })

  test("standalone snapshot present blocks", () => {
    const result = decide({ proof: { standaloneSnapshots: "present" } })

    for (const operation of operations) {
      expect(result[operation].eligible).toBe(false)
      expect(result[operation].reasons).toContain("standalone-snapshot-present")
    }
  })

  test("standalone snapshot unknown blocks", () => {
    const result = decide({ proof: { standaloneSnapshots: "unknown" } })

    for (const operation of operations) {
      expect(result[operation].eligible).toBe(false)
      expect(result[operation].reasons).toContain("standalone-snapshot-unknown")
    }
  })

  test("future standalone snapshot evidence fails closed as unknown", () => {
    const result = decide({ proof: { standaloneSnapshots: "future" as SessionV2MutationPolicy.StandaloneSnapshotEvidence } })

    expectAllOperationsBlockedBy(result, "standalone-snapshot-unknown")
  })

  test("runtime patch targeting missing/unknown blocks revert", () => {
    const messages = [
      user("user"),
      assistant("assistant", { content: [patch("patch")] }),
    ]

    expect(decide({ messages, proof: { runtimePatchTargeting: "missing" } }).revert).toStrictEqual({
      operation: "revert",
      eligible: false,
      reasons: ["runtime-patch-targeting-missing"],
    })
    expect(decide({ messages, proof: { runtimePatchTargeting: "unknown" } }).revert).toStrictEqual({
      operation: "revert",
      eligible: false,
      reasons: ["runtime-patch-targeting-unknown"],
    })
  })

  test("assistant patch content without target proof blocks destructive eligibility", () => {
    const result = decide({
      messages: [user("user"), assistant("assistant", { content: [patch("patch")] })],
      proof: { runtimePatchTargeting: "unknown" },
    })

    for (const operation of operations) {
      expect(result[operation].eligible).toBe(false)
      expect(result[operation].reasons).toContain("runtime-patch-targeting-unknown")
    }
  })

  test("future runtime patch targeting evidence fails closed as unknown when patch content exists", () => {
    const result = decide({
      messages: [user("user"), assistant("assistant", { content: [patch("patch")] })],
      proof: { runtimePatchTargeting: "future" as SessionV2MutationPolicy.RuntimePatchTargeting },
    })

    expectAllOperationsBlockedBy(result, "runtime-patch-targeting-unknown")
  })

  test("no patch / no rollback proof cases return operation-specific blocked reasons", () => {
    const result = decide({ proof: { rollback: "missing", runtimePatchTargeting: "missing" } })

    expect(result.revert).toStrictEqual({
      operation: "revert",
      eligible: false,
      reasons: ["missing-rollback-proof"],
    })
    expect(result.remove).toStrictEqual({ operation: "remove", eligible: true, reasons: [] })
    expect(result.update).toStrictEqual({ operation: "update", eligible: true, reasons: [] })
    expect(result.fork).toStrictEqual({ operation: "fork", eligible: true, reasons: [] })
  })

  test("unknown rollback proof reports a revert-specific reason", () => {
    const result = decide({ proof: { rollback: "unknown" } })

    expect(result.revert).toStrictEqual({
      operation: "revert",
      eligible: false,
      reasons: ["unknown-rollback-proof"],
    })
    expect(result.remove.eligible).toBe(true)
    expect(result.update.eligible).toBe(true)
    expect(result.fork.eligible).toBe(true)
  })

  test("remove/update/fork decisions do not imply revert eligibility", () => {
    const result = decide({ messages: [user("user"), assistant("assistant", { snapshot: undefined })] })

    expect(result.revert.eligible).toBe(false)
    expect(result.revert.reasons).toContain("missing-assistant-snapshot-boundary")
    expect(result.remove.eligible).toBe(true)
    expect(result.update.eligible).toBe(true)
    expect(result.fork.eligible).toBe(true)
  })

  test("source-purity guard", async () => {
    const source = await Bun.file(new URL("../../src/session/session-v2-mutation-policy.ts", import.meta.url)).text()

    for (const blocked of [
      "SessionLegacy",
      "MessageID",
      "PartID",
      "Session.Service",
      "DB",
      "database",
      "Snapshot.Service",
      "SessionSnapshot",
      "revertSession",
      "removeMessage",
      "updatePart",
      "forkSession",
    ]) {
      expect(source).not.toContain(blocked)
    }
  })
})
