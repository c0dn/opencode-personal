import { describe, expect, test } from "bun:test"
import { EventV2 } from "@opencode-ai/core/event"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { DateTime } from "effect"
import { CompactionV2Context } from "../../src/session/compaction-v2-context"

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

function patch(suffix: string): SessionMessage.AssistantPatch {
  return new SessionMessage.AssistantPatch({
    id: id(suffix),
    type: "patch",
    hash: suffix,
    files: ["README.md"],
  })
}

describe("session.compaction-v2-context", () => {
  test("no prior compaction returns chronological history and selects head/tail with estimator and tailTurns", () => {
    const firstUser = user("first_user", 1)
    const firstAssistant = assistant("first_assistant", 2)
    const secondUser = user("second_user", 3)
    const secondAssistant = assistant("second_assistant", 4)
    const thirdUser = user("third_user", 5)
    const thirdAssistant = assistant("third_assistant", 6)

    const selected = CompactionV2Context.select(
      [thirdAssistant, secondAssistant, firstAssistant, thirdUser, secondUser, firstUser],
      {
        tailTurns: 2,
        preserveRecentBudget: 2,
        estimate: (messages) => messages.length,
      },
    )

    expect(ids(selected.history)).toStrictEqual([
      firstUser.id,
      firstAssistant.id,
      secondUser.id,
      secondAssistant.id,
      thirdUser.id,
      thirdAssistant.id,
    ])
    expect(ids(selected.head)).toStrictEqual([firstUser.id, firstAssistant.id, secondUser.id, secondAssistant.id])
    expect(selected.tailStartID).toBe(thirdUser.id)
    expect(selected.previousSummary).toBeUndefined()
    expect(selected.latestCompaction).toBeUndefined()
  })

  test("budgeted recent context can split a multi-message turn at a mid-turn assistant", () => {
    const olderUser = user("older_user", 1)
    const olderAssistant = assistant("older_assistant", 2)
    const recentUser = user("recent_user", 3)
    const firstAssistant = assistant("first_assistant", 4)
    const secondAssistant = assistant("second_assistant", 5)

    const selected = CompactionV2Context.select(
      [secondAssistant, firstAssistant, recentUser, olderAssistant, olderUser],
      {
        tailTurns: 1,
        preserveRecentBudget: 2,
        estimate: (messages) => messages.length,
      },
    )

    expect(selected.tailStartID).toBe(firstAssistant.id)
    expect(ids(selected.head)).toStrictEqual([olderUser.id, olderAssistant.id, recentUser.id])
  })

  test("latest completed compaction provides previousSummary, is excluded from history/head, and rows after it remain visible", () => {
    const before = user("before", 1)
    const anchor = compaction("anchor", 2, { summary: "latest summary" })
    const afterUser = user("after_user", 3)
    const afterAssistant = assistant("after_assistant", 4)

    const selected = CompactionV2Context.select([afterAssistant, before, afterUser, anchor])

    expect(selected.latestCompaction).toBe(anchor)
    expect(selected.previousSummary).toBe("latest summary")
    expect(selected.history).toStrictEqual([afterUser, afterAssistant])
    expect(selected.head).toStrictEqual([afterUser, afterAssistant])
  })

  test("include retains tail before compaction and excludes dropped prefix", () => {
    const dropped = user("dropped", 1)
    const retainedUser = user("retained_user", 2)
    const retainedAssistant = assistant("retained_assistant", 3)
    const anchor = compaction("anchor", 4, { include: retainedUser.id, summary: "summary" })
    const after = user("after", 5)

    const selected = CompactionV2Context.select([after, anchor, retainedAssistant, retainedUser, dropped])

    expect(selected.previousSummary).toBe("summary")
    expect(selected.history).toStrictEqual([retainedUser, retainedAssistant, after])
    expect(selected.head).toStrictEqual([retainedUser, retainedAssistant, after])
  })

  test("missing or invalid include does not retain the pre-compaction tail", () => {
    const before = user("before", 1)
    const missingInclude = compaction("missing_include", 2, { include: id("missing") })
    const after = assistant("after", 3)

    expect(CompactionV2Context.history([after, missingInclude, before])).toStrictEqual({
      history: [after],
      previousSummary: missingInclude.summary,
      latestCompaction: missingInclude,
    })

    const includeAfterTarget = user("include_after_target", 5)
    const includeAfter = compaction("include_after", 4, { include: includeAfterTarget.id })

    expect(CompactionV2Context.history([includeAfterTarget, includeAfter, after, missingInclude, before])).toStrictEqual({
      history: [includeAfterTarget],
      previousSummary: includeAfter.summary,
      latestCompaction: includeAfter,
    })
  })

  test("repeated compactions use latest summary only and exclude earlier compaction rows as intent", () => {
    const firstCompaction = compaction("first_compaction", 2, { summary: "old summary" })
    const between = user("between", 3)
    const latestCompaction = compaction("latest_compaction", 4, {
      include: firstCompaction.id,
      summary: "new summary",
    })
    const after = assistant("after", 5)

    const selected = CompactionV2Context.select([after, latestCompaction, between, firstCompaction])

    expect(selected.latestCompaction).toBe(latestCompaction)
    expect(selected.previousSummary).toBe("new summary")
    expect(selected.history).toStrictEqual([between, after])
    expect(selected.head).toStrictEqual([between, after])
  })

  test("taskRequests and assistant patch content remain on messages without special turn/provider intent handling", () => {
    const taskRequest = new SessionMessage.UserTaskRequest({
      type: "task-request",
      id: id("task_request"),
      prompt: "delegate this",
      description: "review",
      agent: "reviewer",
    })
    const taskUser = user("task_user", 1, { taskRequests: [taskRequest] })
    const patchAssistant = assistant("patch_assistant", 2, { content: [patch("patch_content")] })
    const plainUser = user("plain_user", 3)
    const plainAssistant = assistant("plain_assistant", 4)

    const selected = CompactionV2Context.select([plainAssistant, plainUser, patchAssistant, taskUser], {
      tailTurns: 1,
    })

    expect(selected.history).toStrictEqual([taskUser, patchAssistant, plainUser, plainAssistant])
    expect(selected.head).toStrictEqual([taskUser, patchAssistant])
    expect(selected.tailStartID).toBe(plainUser.id)
    expect((selected.head[0] as SessionMessage.User).taskRequests).toStrictEqual([taskRequest])
    expect((selected.head[1] as SessionMessage.Assistant).content).toStrictEqual([patchAssistant.content[0]])
  })

  test("implementation is pure and has no database, Effect, or provider conversion dependency", async () => {
    const source = await Bun.file(new URL("../../src/session/compaction-v2-context.ts", import.meta.url)).text()

    expect(source).not.toContain("SessionMessageTable")
    expect(source).not.toContain("Database")
    expect(source).not.toContain("Effect")
    expect(source).not.toContain("MessageV2Model")
    expect(source).not.toContain("toModelMessages")
  })
})
