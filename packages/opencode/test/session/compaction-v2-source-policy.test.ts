import { describe, expect, test } from "bun:test"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { DateTime } from "effect"
import { CompactionV2SourcePolicy } from "../../src/session/compaction-v2-source-policy"

function id(suffix: string) {
  return EventV2.ID.make(`evt_source_policy_${suffix}`)
}

function compaction(
  suffix: string,
  time: number,
  input?: Partial<SessionMessage.Compaction>,
): SessionMessage.Compaction {
  return new SessionMessage.Compaction({
    id: id(suffix),
    type: "compaction",
    reason: "manual",
    summary: suffix,
    time: { created: DateTime.makeUnsafe(time) },
    ...input,
  })
}

describe("session.compaction-v2-source-policy", () => {
  test("current processor result wins over canonical rows", () => {
    const row = compaction("row", 1, { summary: "row summary", include: id("row_include") })

    expect(
      CompactionV2SourcePolicy.select({
        current: { summary: "current summary", include: id("current_include") },
        canonicalCompactions: [row],
      }),
    ).toStrictEqual({
      status: "selected",
      source: "current-result",
      summary: "current summary",
      include: id("current_include"),
    })
  })

  test("current object presence prevents canonical fallback even when empty", () => {
    const row = compaction("row", 1, { summary: "row summary", include: id("row_include") })

    expect(CompactionV2SourcePolicy.select({ current: {}, canonicalCompactions: [row] })).toStrictEqual({
      status: "not-ready",
      reason: "empty-summary",
      source: "current-result",
    })
  })

  test("selects latest canonical compaction by created time then id", () => {
    const older = compaction("older", 1, { summary: "older summary" })
    const lowerID = compaction("aaa_same_time", 2, { summary: "lower summary" })
    const higherID = compaction("zzz_same_time", 2, { summary: "higher summary", include: id("retained") })

    expect(CompactionV2SourcePolicy.select({ canonicalCompactions: [higherID, older, lowerID] })).toStrictEqual({
      status: "selected",
      source: "canonical-compaction",
      summary: "higher summary",
      include: id("retained"),
      compactionID: higherID.id,
    })
  })

  test("reports not-ready when no exact source is available", () => {
    expect(CompactionV2SourcePolicy.select({})).toStrictEqual({ status: "not-ready", reason: "no-exact-source" })
    expect(CompactionV2SourcePolicy.select({ canonicalCompactions: [] })).toStrictEqual({
      status: "not-ready",
      reason: "no-exact-source",
    })
  })

  test("reports empty summary as not-ready without guessing from another source", () => {
    expect(CompactionV2SourcePolicy.select({ current: { summary: "  " } })).toStrictEqual({
      status: "not-ready",
      reason: "empty-summary",
      source: "current-result",
    })

    const blank = compaction("blank", 1, { summary: "" })
    expect(CompactionV2SourcePolicy.select({ canonicalCompactions: [blank] })).toStrictEqual({
      status: "not-ready",
      reason: "empty-summary",
      source: "canonical-compaction",
      compactionID: blank.id,
    })

    const olderValid = compaction("older_valid", 1, { summary: "older summary" })
    const latestBlank = compaction("latest_blank", 2, { summary: "" })
    expect(CompactionV2SourcePolicy.select({ canonicalCompactions: [olderValid, latestBlank] })).toStrictEqual({
      status: "not-ready",
      reason: "empty-summary",
      source: "canonical-compaction",
      compactionID: latestBlank.id,
    })
  })

  test("rejects legacy-looking include IDs from current and canonical sources", () => {
    for (const include of ["msg_user", "prt_compaction", "legacy_tail", "tail_0001", "evt_"]) {
      expect(CompactionV2SourcePolicy.select({ current: { summary: "summary", include } })).toStrictEqual({
        status: "unsupported",
        reason: "invalid-include-id",
        detail: include,
        source: "current-result",
      })

      const row = compaction(`row_${include}`, 1, { include })
      expect(CompactionV2SourcePolicy.select({ canonicalCompactions: [row] })).toStrictEqual({
        status: "unsupported",
        reason: "invalid-include-id",
        detail: include,
        source: "canonical-compaction",
        compactionID: row.id,
      })
    }
  })

  test("accepts only canonical evt include IDs and preserves absent include", () => {
    expect(CompactionV2SourcePolicy.select({ current: { summary: "summary", include: id("ok") } })).toStrictEqual({
      status: "selected",
      source: "current-result",
      summary: "summary",
      include: id("ok"),
    })

    const row = compaction("without_include", 1, { include: undefined })
    expect(CompactionV2SourcePolicy.select({ canonicalCompactions: [row] })).toStrictEqual({
      status: "selected",
      source: "canonical-compaction",
      summary: "without_include",
      compactionID: row.id,
    })
  })

  test("source boundary stays pure, unwired, and free of mutation dependencies", async () => {
    const source = await Bun.file(new URL("../../src/session/compaction-v2-source-policy.ts", import.meta.url)).text()

    for (const blocked of [
      "SessionLegacy",
      "MessageV2",
      "Database",
      "SessionMessageTable",
      "SessionCompaction",
      "updatePart",
      "tail_start_id",
      "PartID",
    ]) {
      expect(source).not.toContain(blocked)
    }
  })
})
