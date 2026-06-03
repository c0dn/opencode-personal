import { describe, expect, test } from "bun:test"
import { EventV2 } from "@opencode-ai/core/event"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { DateTime } from "effect"
import { CompactionV2Context } from "../../src/session/compaction-v2-context"
import { CompactionV2Process } from "../../src/session/compaction-v2-process"

const model = {
  providerID: ProviderV2.ID.make("provider"),
  id: ModelV2.ID.make("model"),
  variant: ModelV2.VariantID.make("default"),
}

function id(suffix: string) {
  return EventV2.ID.make(`evt_${suffix}`)
}

function ids(messages: readonly SessionMessage.Message[]) {
  return messages.map((message) => message.id)
}

function user(suffix: string, time: number, input?: Partial<SessionMessage.User>): SessionMessage.User {
  return new SessionMessage.User({
    id: id(suffix),
    type: "user",
    text: suffix,
    files: [],
    agents: [],
    references: [],
    time: { created: DateTime.makeUnsafe(time) },
    ...input,
  })
}

function assistant(
  suffix: string,
  time: number,
  input?: Partial<SessionMessage.Assistant>,
): SessionMessage.Assistant {
  return new SessionMessage.Assistant({
    id: id(suffix),
    type: "assistant",
    agent: "build",
    model,
    content: [],
    time: { created: DateTime.makeUnsafe(time) },
    ...input,
  })
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

describe("session.compaction-v2-process", () => {
  test("no overflow delegates to normal v2 selection", () => {
    const first = user("first", 1)
    const second = assistant("second", 2)
    const third = user("third", 3)

    const options = { tailTurns: 1 }
    const selected = CompactionV2Process.selectForProcess([third, first, second], options)

    expect(selected).toStrictEqual({
      ...CompactionV2Context.select([third, first, second], options),
      replay: { status: "none", reason: "not-overflow" },
    })
  })

  test("overflow replay with earlier visible user selects only history before replay user", () => {
    const firstUser = user("first_user", 1)
    const firstAssistant = assistant("first_assistant", 2)
    const replayUser = user("replay_user", 3)
    const laterAssistant = assistant("later_assistant", 4)

    const selected = CompactionV2Process.selectForProcess([laterAssistant, replayUser, firstAssistant, firstUser], {
      overflow: true,
      overflowReplayStartID: replayUser.id,
    })

    expect(ids(selected.history)).toStrictEqual([firstUser.id, firstAssistant.id])
    expect(ids(selected.head)).toStrictEqual([firstUser.id, firstAssistant.id])
    expect(selected.replay).toStrictEqual({ status: "selected", startID: replayUser.id, message: replayUser })
  })

  test("overflow replay recomputes tailStartID over the pre-replay slice", () => {
    const firstUser = user("first_user", 1)
    const firstAssistant = assistant("first_assistant", 2)
    const secondUser = user("second_user", 3)
    const secondAssistant = assistant("second_assistant", 4)
    const replayUser = user("replay_user", 5)
    const laterAssistant = assistant("later_assistant", 6)

    const selected = CompactionV2Process.selectForProcess(
      [laterAssistant, replayUser, secondAssistant, secondUser, firstAssistant, firstUser],
      {
        overflow: true,
        overflowReplayStartID: replayUser.id,
        tailTurns: 1,
      },
    )

    expect(ids(selected.history)).toStrictEqual([firstUser.id, firstAssistant.id, secondUser.id, secondAssistant.id])
    expect(ids(selected.head)).toStrictEqual([firstUser.id, firstAssistant.id])
    expect(selected.tailStartID).toBe(secondUser.id)
    expect(selected.tailStartID).not.toBe(replayUser.id)
    expect(selected.replay).toStrictEqual({ status: "selected", startID: replayUser.id, message: replayUser })
  })

  test("overflow without replay ID keeps full history and reports missing replay start", () => {
    const first = user("first", 1)
    const second = assistant("second", 2)

    const selected = CompactionV2Process.selectForProcess([second, first], { overflow: true })

    expect(selected.history).toStrictEqual([first, second])
    expect(selected.head).toStrictEqual([first, second])
    expect(selected.replay).toStrictEqual({ status: "none", reason: "missing-replay-start-id" })
  })

  test("overflow replay candidate that is first visible user keeps full history and reports no earlier user", () => {
    const replayUser = user("replay_user", 1)
    const assistantAfter = assistant("assistant_after", 2)

    const selected = CompactionV2Process.selectForProcess([assistantAfter, replayUser], {
      overflow: true,
      overflowReplayStartID: replayUser.id,
    })

    expect(selected.history).toStrictEqual([replayUser, assistantAfter])
    expect(selected.replay).toStrictEqual({ status: "none", reason: "no-earlier-user" })
  })

  test("assistant, compaction, hidden user, and missing replay IDs are not visible replay users", () => {
    const hiddenUser = user("hidden_user", 1)
    const assistantReplay = assistant("assistant_replay", 2)
    const anchor = compaction("anchor", 3)
    const after = user("after", 4)

    for (const replayID of [assistantReplay.id, anchor.id, hiddenUser.id, id("missing")]) {
      const selected = CompactionV2Process.selectForProcess([after, anchor, assistantReplay, hiddenUser], {
        overflow: true,
        overflowReplayStartID: replayID,
      })
      expect(selected.history).toStrictEqual([after])
      expect(selected.replay).toStrictEqual({ status: "none", reason: "not-visible-user" })
    }
  })

  test("equal timestamps use canonical time and id ordering for replay slicing", () => {
    const olderIDUser = user("aaa_user", 1)
    const replayUser = user("bbb_user", 1)
    const later = assistant("ccc_assistant", 1)

    const selected = CompactionV2Process.selectForProcess([later, replayUser, olderIDUser], {
      overflow: true,
      overflowReplayStartID: replayUser.id,
    })

    expect(ids(selected.history)).toStrictEqual([olderIDUser.id])
    expect(selected.replay).toStrictEqual({ status: "selected", startID: replayUser.id, message: replayUser })
  })

  test("prior compaction include keeps summary and retained tail before replay", () => {
    const dropped = user("dropped", 1)
    const retained = user("retained", 2)
    const retainedAssistant = assistant("retained_assistant", 3)
    const anchor = compaction("anchor", 4, { include: retained.id, summary: "summary" })
    const replayUser = user("replay_user", 5)
    const later = assistant("later", 6)

    const selected = CompactionV2Process.selectForProcess([later, replayUser, anchor, retainedAssistant, retained, dropped], {
      overflow: true,
      overflowReplayStartID: replayUser.id,
    })

    expect(selected.previousSummary).toBe("summary")
    expect(selected.latestCompaction).toBe(anchor)
    expect(ids(selected.history)).toStrictEqual([retained.id, retainedAssistant.id])
    expect(selected.replay).toStrictEqual({ status: "selected", startID: replayUser.id, message: replayUser })
  })

  test("repeated compactions use latest summary only and exclude earlier compaction rows", () => {
    const firstUser = user("first_user", 1)
    const oldCompaction = compaction("old_compaction", 2, { include: firstUser.id, summary: "old" })
    const retained = user("retained", 3)
    const latest = compaction("latest_compaction", 4, { include: retained.id, summary: "latest" })
    const replayUser = user("replay_user", 5)

    const selected = CompactionV2Process.selectForProcess([replayUser, latest, retained, oldCompaction, firstUser], {
      overflow: true,
      overflowReplayStartID: replayUser.id,
    })

    expect(selected.previousSummary).toBe("latest")
    expect(selected.latestCompaction).toBe(latest)
    expect(ids(selected.history)).toStrictEqual([retained.id])
    expect(selected.history.some((message) => message.type === "compaction")).toBe(false)
    expect(selected.replay).toStrictEqual({ status: "selected", startID: replayUser.id, message: replayUser })
  })

  test("implementation is pure and has no database, legacy, plugin, session compaction, or provider conversion dependency", async () => {
    const source = await Bun.file(new URL("../../src/session/compaction-v2-process.ts", import.meta.url)).text()

    expect(source).not.toContain("SessionMessageTable")
    expect(source).not.toContain("Database")
    expect(source).not.toContain("SessionLegacy")
    expect(source).not.toContain("MessageV2Model")
    expect(source).not.toContain("SessionCompaction")
    expect(source).not.toContain("Plugin")
    expect(source).not.toContain("toModelMessages")
    expect(source).not.toContain("SessionV2")
    expect(source).not.toContain("SessionMessageBackfillService")
    expect(source).not.toContain("ensureBackfillReady")
    expect(source).not.toContain("SessionV2BackfillReadiness")
    expect(source).not.toContain("session-v2-backfill-readiness")
    expect(source).not.toContain("CompactionV2Session")
    expect(source).not.toContain("compaction-v2-session")
  })
})
