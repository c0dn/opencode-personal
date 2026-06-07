import { describe, expect, test } from "bun:test"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { AgentAttachment } from "@opencode-ai/core/session/prompt"
import { DateTime } from "effect"
import { MessageV2Context } from "../../src/session/message-v2-context"

const model = {
  providerID: ProviderV2.ID.make("provider"),
  id: ModelV2.ID.make("model"),
  variant: ModelV2.VariantID.make("default"),
}

function id(suffix: string) {
  return SessionMessage.ID.make(`msg_${suffix}`)
}

function ids(messages: SessionMessage.Message[]) {
  return messages.map((message) => message.id)
}

function agent(name: string) {
  return new AgentAttachment({ name })
}

function taskIDs(tasks: MessageV2Context.Task[]) {
  return tasks.map((task) => task.id)
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

describe("session.message-v2-context", () => {
  test("chronological sorts descending input and same-timestamp IDs in binary order", () => {
    const later = user("later", 2)
    const sameB = user("same_b", 1)
    const sameA = user("same_a", 1)

    expect(ids(MessageV2Context.chronological([later, sameB, sameA]))).toStrictEqual([
      id("same_a"),
      id("same_b"),
      id("later"),
    ])
  })

  test("filterCompacted returns all chronological messages when no compaction exists", () => {
    const first = user("first", 1)
    const second = assistant("second", 2)

    expect(MessageV2Context.filterCompacted([second, first])).toStrictEqual([first, second])
  })

  test("latest compaction without include returns anchor and rows after it", () => {
    const before = user("before", 1)
    const anchor = compaction("anchor", 2)
    const after = assistant("after", 3)

    expect(MessageV2Context.filterCompacted([after, before, anchor])).toStrictEqual([anchor, after])
  })

  test("compaction include returns anchor, retained tail before compaction, and rows after compaction", () => {
    const dropped = user("dropped", 1)
    const retained = user("retained", 2)
    const beforeAnchor = assistant("before_anchor", 3)
    const anchor = compaction("anchor", 4, { include: retained.id })
    const after = user("after", 5)

    expect(MessageV2Context.filterCompacted([after, anchor, beforeAnchor, retained, dropped])).toStrictEqual([
      anchor,
      retained,
      beforeAnchor,
      after,
    ])
  })

  test("context matches filterCompacted for compacted messages", () => {
    const messages = [user("after", 3), compaction("anchor", 2), user("before", 1)]

    expect(MessageV2Context.context(messages)).toStrictEqual(MessageV2Context.filterCompacted(messages))
  })

  test("missing or invalid compaction include omits retained tail", () => {
    const before = user("before", 1)
    const anchor = compaction("anchor", 2, { include: id("missing") })
    const after = assistant("after", 3)
    const afterLatest = user("after_latest", 5)
    const includeAfter = compaction("include_after", 4, { include: afterLatest.id })

    expect(MessageV2Context.filterCompacted([after, anchor, before])).toStrictEqual([anchor, after])
    expect(MessageV2Context.filterCompacted([afterLatest, includeAfter, after, anchor, before])).toStrictEqual([
      includeAfter,
      afterLatest,
    ])
  })

  test("repeated compactions prefer the latest anchor", () => {
    const firstCompaction = compaction("first_compaction", 2)
    const between = user("between", 3)
    const latestCompaction = compaction("latest_compaction", 4)
    const after = assistant("after", 5)

    expect(MessageV2Context.filterCompacted([after, between, latestCompaction, firstCompaction])).toStrictEqual([
      latestCompaction,
      after,
    ])
  })

  test("latest uses chronological time and ID order rather than lexicographic max ID alone", () => {
    const lexicographicMaxOlder = user("zzzz", 1)
    const chronologicalLatest = user("aaaa", 2)
    const sameTimestampAssistantA = assistant("assistant_a", 3)
    const sameTimestampAssistantB = assistant("assistant_b", 3)

    expect(MessageV2Context.latest([chronologicalLatest, lexicographicMaxOlder]).user).toBe(chronologicalLatest)
    expect(MessageV2Context.latest([sameTimestampAssistantB, sameTimestampAssistantA]).assistant).toBe(
      sameTimestampAssistantB,
    )
  })

  test("latest finished assistant uses completed, finish, or error terminal signals", () => {
    const completed = assistant("completed", 1, {
      time: { created: DateTime.makeUnsafe(1), completed: DateTime.makeUnsafe(2) },
    })
    const finished = assistant("finished", 3, { finish: "stop" })
    const nonterminal = assistant("nonterminal", 4)
    const errored = assistant("errored", 5, { error: { type: "unknown", message: "failed" } })

    expect(MessageV2Context.latest([nonterminal, completed, finished]).assistant).toBe(nonterminal)
    expect(MessageV2Context.latest([nonterminal, completed, finished]).finishedAssistant).toBe(finished)
    expect(MessageV2Context.latest([errored, nonterminal, completed, finished]).finishedAssistant).toBe(errored)
  })

  test("latestWithTasks matches latest state and has no pending tasks before unfinished work", () => {
    const firstUser = user("first_user", 1, { agents: [agent("reviewer")] })
    const finished = assistant("finished", 2, { finish: "stop" })
    const nextUser = user("next_user", 3)
    const running = assistant("running", 4)

    const state = MessageV2Context.latestWithTasks([running, firstUser, nextUser, finished])

    expect(state.user).toBe(nextUser)
    expect(state.assistant).toBe(running)
    expect(state.finishedAssistant).toBe(finished)
    expect(state.tasks).toStrictEqual([])
  })

  test("latestWithTasks returns pending user agent tasks after latest finished assistant", () => {
    const before = user("before", 1, { agents: [agent("old")] })
    const finished = assistant("finished", 2, { finish: "stop" })
    const firstPending = user("first_pending", 3, { agents: [agent("reviewer"), agent("tester")] })
    const secondPending = user("second_pending", 4, { agents: [agent("builder")] })

    const state = MessageV2Context.latestWithTasks([secondPending, before, firstPending, finished])

    expect(taskIDs(state.tasks)).toStrictEqual([
      `${firstPending.id}/agent/0`,
      `${firstPending.id}/agent/1`,
      `${secondPending.id}/agent/0`,
    ])
    expect(state.tasks.at(-1)).toMatchObject({ type: "subtask", message: secondPending, index: 0 })
  })

  test("latestWithTasks returns all task requests when no assistant has finished yet", () => {
    const first = user("first", 1, { agents: [agent("reviewer")] })
    const second = user("second", 2, { agents: [agent("tester")] })
    const running = assistant("running", 3)

    const state = MessageV2Context.latestWithTasks([running, second, first])

    expect(taskIDs(state.tasks)).toStrictEqual([`${first.id}/agent/0`, `${second.id}/agent/0`])
  })

  test("latestWithTasks orders pending compaction and agent tasks by canonical chronology", () => {
    const finished = assistant("finished", 1, { finish: "stop" })
    const first = user("first", 2, { agents: [agent("reviewer")] })
    const autoCompaction = compaction("auto_compaction", 3, { reason: "auto", summary: "" })
    const manualCompaction = compaction("manual_compaction", 4, { summary: "" })
    const second = user("second", 5, { agents: [agent("tester")] })

    const state = MessageV2Context.latestWithTasks([second, manualCompaction, autoCompaction, first, finished])

    expect(state.tasks.map((task) => task.type)).toStrictEqual(["subtask", "compaction", "compaction", "subtask"])
    expect(taskIDs(state.tasks)).toStrictEqual([
      `${first.id}/agent/0`,
      autoCompaction.id,
      manualCompaction.id,
      `${second.id}/agent/0`,
    ])
    expect(state.tasks[1]).toMatchObject({ type: "compaction", auto: true })
    expect(state.tasks[2]).toMatchObject({ type: "compaction", auto: false })
  })

  test("latestWithTasks excludes completed compaction anchors from pending tasks", () => {
    const finished = assistant("finished", 1, { finish: "stop" })
    const pending = compaction("pending", 2, { summary: "" })
    const completed = compaction("completed", 3, { summary: "done", include: id("tail") })

    const state = MessageV2Context.latestWithTasks([completed, pending, finished])
    expect(taskIDs(state.tasks)).toStrictEqual([pending.id])
  })

  test("latestWithTasks handles same-timestamp task ordering by binary ID order", () => {
    const finished = assistant("finished", 1, { finish: "stop" })
    const sameB = user("same_b", 2, { agents: [agent("b")] })
    const sameA = user("same_a", 2, { agents: [agent("a")] })

    const state = MessageV2Context.latestWithTasks([sameB, finished, sameA])
    expect(taskIDs(state.tasks)).toStrictEqual([`${sameA.id}/agent/0`, `${sameB.id}/agent/0`])
  })

  test("latestWithTasks uses terminal errored assistant as pending task boundary", () => {
    const before = user("before_error", 1, { agents: [agent("old")] })
    const errored = assistant("errored", 2, { error: { type: "unknown", message: "failed" } })
    const after = user("after_error", 3, { agents: [agent("new")] })

    const state = MessageV2Context.latestWithTasks([after, before, errored])
    expect(state.finishedAssistant).toBe(errored)
    expect(taskIDs(state.tasks)).toStrictEqual([`${after.id}/agent/0`])
  })

  test("implementation is pure and has no database dependency", async () => {
    const source = await Bun.file(new URL("../../src/session/message-v2-context.ts", import.meta.url)).text()

    expect(source).not.toContain("SessionMessageTable")
    expect(source).not.toContain("Database")
    expect(source).not.toContain("@opencode-ai/core/session/sql")
  })
})
