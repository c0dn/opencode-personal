import { describe, expect, test } from "bun:test"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageV2Context } from "../../src/session/message-v2-context"
import { MessageV2Model } from "../../src/session/message-v2-model"
import {
  contextFixture,
  compactLegacyCompactionSummary,
  contextSemantic,
  expectNoLegacyIDs,
  latestSemantic,
  legacyModel,
  modelFixture,
  modelSemantic,
} from "./transcript-semantic.fixture"

describe("session.message-v2 transitional semantic parity", () => {
  test("model helper matches legacy provider-visible semantics after dropping legacy-only prompt artifacts", async () => {
    const legacy = await MessageV2.toModelMessages(modelFixture.legacy, legacyModel)
    const v2 = await MessageV2Model.toModelMessages(modelFixture.v2)

    // Transitional legacy-oracle parity is intentionally provider-visible only:
    // compare role order plus text/file/tool/reasoning outputs after helper
    // conversion, while dropping row IDs, raw legacy provenance, provider
    // metadata, signed reasoning metadata/providerOptions, and legacy-only
    // compaction/subtask prompt injections. taskRequests and patches are
    // permanent v2 transcript metadata/display content, not model output.
    const expected = modelSemantic(legacy)
    const actual = modelSemantic(v2)
    expectNoLegacyIDs(modelFixture.v2)
    expectNoLegacyIDs(actual)
    expectNoLegacyIDs(expected)
    expect(actual).toStrictEqual(expected)
  })

  test("filterCompacted matches legacy context summary/include/tail semantics without row-shape equality", () => {
    const legacy = MessageV2.filterCompacted(contextFixture.legacy.slice().reverse())
    const v2 = MessageV2Context.filterCompacted(contextFixture.v2)

    // Legacy compaction is a user marker plus summary assistant row. Canonical
    // v2 represents the same semantic anchor as one compaction row, so this
    // assertion compares retained labels/text/kinds and summary/include behavior
    // instead of legacy row equality.
    const legacySummary = contextSemantic(legacy, contextFixture.legacyLabels)
    const v2Summary = contextSemantic(v2, contextFixture.v2Labels)

    expectNoLegacyIDs(contextFixture.v2)
    expectNoLegacyIDs(v2Summary)
    expect(v2Summary).toStrictEqual(compactLegacyCompactionSummary(legacySummary))
    expect(v2Summary).toStrictEqual([
      { kind: "compaction", label: "compaction", summary: "summary text", include: "retained" },
      { kind: "user", label: "retained", text: "keep me" },
      { kind: "assistant", label: "beforeAnchor", text: "before compaction" },
      { kind: "user", label: "laterUser", text: "continue" },
      { kind: "assistant", label: "latestAssistant", text: "latest answer" },
      { kind: "user", label: "freshTaskUser", text: "" },
    ])
    expect(legacySummary).toStrictEqual([
      { kind: "compaction", label: "compaction", include: "retained" },
      { kind: "compaction-summary", label: "summary", summary: "summary text" },
      { kind: "user", label: "retained", text: "keep me" },
      { kind: "assistant", label: "beforeAnchor", text: "before compaction" },
      { kind: "user", label: "laterUser", text: "continue" },
      { kind: "assistant", label: "latestAssistant", text: "latest answer" },
      { kind: "user", label: "freshTaskUser", text: "" },
    ])
  })

  test("latest matches semantic latest user, assistant, and terminal assistant while ignoring task metadata", () => {
    const legacy = latestSemantic(
      MessageV2.latest(MessageV2.filterCompacted(contextFixture.legacy.slice().reverse())),
      contextFixture.legacyLabels,
    )
    const v2 = latestSemantic(MessageV2Context.latest(MessageV2Context.filterCompacted(contextFixture.v2)), contextFixture.v2Labels)

    // Latest parity deliberately ignores legacy latest.tasks shape. User-side
    // v2 taskRequests are metadata and must not become latest-task output.
    expectNoLegacyIDs(v2)
    expect(v2).toStrictEqual(legacy)
    expect(v2).toStrictEqual({
      user: "freshTaskUser",
      assistant: "latestAssistant",
      finishedAssistant: "latestAssistant",
    })
  })
})
