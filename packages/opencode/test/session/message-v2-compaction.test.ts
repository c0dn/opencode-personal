import { describe, expect, test } from "bun:test"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { DateTime } from "effect"
import { MessageV2Compaction } from "../../src/session/message-v2-compaction"

const model = {
  providerID: ProviderV2.ID.make("provider"),
  id: ModelV2.ID.make("model"),
  variant: ModelV2.VariantID.make("default"),
}

function id(suffix: string) {
  return SessionMessage.ID.make(`msg_${suffix}`)
}

function ids(messages: readonly MessageV2Compaction.ProviderMessage[]) {
  return messages.map((message) => message.id)
}

function anchor(suffix: string, time: number): MessageV2Compaction.Anchor {
  return { id: id(suffix), time: DateTime.makeUnsafe(time) }
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
    summary: "",
    time: { created: DateTime.makeUnsafe(time) },
    ...input,
  })
}

function shell(suffix: string, time: number): SessionMessage.Shell {
  return new SessionMessage.Shell({
    id: id(suffix),
    type: "shell",
    callID: `call_${suffix}`,
    command: suffix,
    output: suffix,
    time: { created: DateTime.makeUnsafe(time) },
  })
}

async function select(input: {
  messages: readonly SessionMessage.Message[]
  anchor?: MessageV2Compaction.Anchor
  tailTurns?: number
  preserveRecentTokens?: number
  estimate?: MessageV2Compaction.Estimate
}) {
  return MessageV2Compaction.select({
    messages: input.messages,
    anchor: input.anchor ?? anchor("future", 99),
    tailTurns: input.tailTurns,
    preserveRecentTokens: input.preserveRecentTokens ?? Number.POSITIVE_INFINITY,
    estimate: input.estimate ?? ((messages) => messages.length),
  })
}

describe("session.message-v2-compaction.select", () => {
  test("sorts by canonical time/id around anchor boundary", async () => {
    const early = user("early", 1)
    const sameBefore = user("same_a", 2)
    const sameAfter = user("same_z", 2)
    const later = user("later", 3)

    const result = await select({
      messages: [later, sameAfter, sameBefore, early],
      anchor: anchor("same_m", 2),
      tailTurns: 0,
    })

    expect(result.type).toBe("selected")
    if (result.type !== "selected") return
    expect(ids(result.messages)).toStrictEqual([early.id, sameBefore.id])
    expect(result.include).toBeUndefined()
  })

  test("blocks when a completed compaction row with same anchor ID exists", async () => {
    const completed = compaction("future", 2, { summary: "done" })

    const result = await select({ messages: [completed, user("first", 1)], anchor: anchor("future", 2) })

    expect(result).toStrictEqual({ type: "blocked", reason: "compaction-completed" })
  })

  test("does not treat an empty compaction row with same anchor ID as completed", async () => {
    const first = user("first", 1)
    // Canonical v2 compaction starts should not create empty Compaction rows, but
    // the helper still must not confuse such a row with a completed compaction.
    const pending = compaction("future", 2, { summary: "", include: undefined })

    const result = await select({ messages: [pending, first], anchor: anchor("future", 2), tailTurns: 0 })

    expect(result.type).toBe("selected")
    if (result.type !== "selected") return
    expect(ids(result.messages)).toStrictEqual([first.id])
    expect(result.include).toBeUndefined()
  })

  test("blocks no visible user before anchor", async () => {
    const hidden = user("hidden", 1)
    const completed = compaction("completed", 2, { summary: "done" })

    const result = await select({ messages: [completed, hidden], anchor: anchor("future", 3) })

    expect(result).toStrictEqual({ type: "blocked", reason: "no-user-before-compaction" })
  })

  test("applies latest completed compaction include visibility before anchor", async () => {
    const dropped = user("dropped", 1)
    const retained = user("retained", 2)
    const before = assistant("before", 3)
    const completed = compaction("completed", 4, { summary: "summary", include: retained.id })
    const after = assistant("after", 5)

    const result = await select({
      messages: [after, completed, before, retained, dropped],
      anchor: anchor("future", 6),
      tailTurns: 0,
    })

    expect(result.type).toBe("selected")
    if (result.type !== "selected") return
    expect(result.previousSummary).toBe("summary")
    expect(ids(result.messages)).toStrictEqual([retained.id, before.id, after.id])
  })

  test("previousSummary comes from latest visible completed compaction and ignores empty rows", async () => {
    const first = compaction("first", 1, { summary: "older" })
    const latest = compaction("latest", 2, { summary: "latest" })
    const retained = user("retained", 3)
    const after = assistant("after", 4)
    const empty = compaction("empty", 5, { include: latest.id })

    const result = await select({ messages: [empty, after, retained, latest, first], anchor: anchor("future", 6) })

    expect(result.type).toBe("selected")
    if (result.type !== "selected") return
    expect(result.previousSummary).toBe("latest")
  })

  test("excludes compaction rows from selected provider candidate history", async () => {
    const first = user("first", 1)
    const completed = compaction("completed", 2, { summary: "summary", include: first.id })
    const after = assistant("after", 3)

    const result = await select({ messages: [after, completed, first], tailTurns: 0 })

    expect(result.type).toBe("selected")
    if (result.type !== "selected") return
    expect(result.previousSummary).toBe("summary")
    expect(ids(result.messages)).toStrictEqual([first.id, after.id])
  })

  test("tailTurns <= 0 returns all candidate history and no include", async () => {
    const first = user("first", 1)
    const firstAssistant = assistant("first_assistant", 2)
    const second = user("second", 3)

    const result = await select({ messages: [second, firstAssistant, first], tailTurns: 0, preserveRecentTokens: 0 })

    expect(result.type).toBe("selected")
    if (result.type !== "selected") return
    expect(ids(result.messages)).toStrictEqual([first.id, firstAssistant.id, second.id])
    expect(result.include).toBeUndefined()
  })

  test("no tail trimming when kept tail starts at index 0", async () => {
    const first = user("first", 1)
    const firstAssistant = assistant("first_assistant", 2)
    const second = user("second", 3)
    const secondAssistant = assistant("second_assistant", 4)

    const result = await select({
      messages: [secondAssistant, second, firstAssistant, first],
      tailTurns: 2,
      preserveRecentTokens: 4,
    })

    expect(result.type).toBe("selected")
    if (result.type !== "selected") return
    expect(ids(result.messages)).toStrictEqual([first.id, firstAssistant.id, second.id, secondAssistant.id])
    expect(result.include).toBeUndefined()
  })

  test("returns head/include when recent tail fits budget", async () => {
    const first = user("first", 1)
    const firstAssistant = assistant("first_assistant", 2)
    const second = user("second", 3)
    const secondAssistant = assistant("second_assistant", 4)
    const third = user("third", 5)
    const thirdAssistant = assistant("third_assistant", 6)

    const result = await select({
      messages: [thirdAssistant, third, secondAssistant, second, firstAssistant, first],
      tailTurns: 1,
      preserveRecentTokens: 2,
    })

    expect(result.type).toBe("selected")
    if (result.type !== "selected") return
    expect(ids(result.messages)).toStrictEqual([first.id, firstAssistant.id, second.id, secondAssistant.id])
    expect(result.include).toBe(third.id)
  })

  test("tailTurns 2 keeps only the newest fitting turn when the older recent turn exceeds budget", async () => {
    const first = user("first", 1)
    const firstAssistant = assistant("first_assistant", 2)
    const second = user("second", 3)
    const secondAssistant = assistant("second_assistant", 4)
    const third = user("third", 5)
    const thirdAssistant = assistant("third_assistant", 6)
    const estimate: MessageV2Compaction.Estimate = (messages) => {
      if (messages.some((message) => message.id === second.id)) return 100
      return messages.length
    }

    const result = await select({
      messages: [thirdAssistant, third, secondAssistant, second, firstAssistant, first],
      tailTurns: 2,
      preserveRecentTokens: 2,
      estimate,
    })

    expect(result.type).toBe("selected")
    if (result.type !== "selected") return
    expect(ids(result.messages)).toStrictEqual([first.id, firstAssistant.id, second.id, secondAssistant.id])
    expect(result.include).toBe(third.id)
  })

  test("tailTurns 2 keeps newest turn and splits the older turn with remaining budget", async () => {
    const first = user("first", 1)
    const firstAssistant = assistant("first_assistant", 2)
    const second = user("second", 3)
    const secondAssistantA = assistant("second_assistant_a", 4)
    const secondAssistantB = assistant("second_assistant_b", 5)
    const third = user("third", 6)
    const thirdAssistant = assistant("third_assistant", 7)
    const estimate: MessageV2Compaction.Estimate = (messages) => {
      if (messages.some((message) => message.id === third.id)) return 2
      if (messages.some((message) => message.id === second.id)) return 100
      if (messages.some((message) => message.id === secondAssistantA.id)) return 2
      return 1
    }

    const result = await select({
      messages: [thirdAssistant, third, secondAssistantB, secondAssistantA, second, firstAssistant, first],
      tailTurns: 2,
      preserveRecentTokens: 3,
      estimate,
    })

    expect(result.type).toBe("selected")
    if (result.type !== "selected") return
    expect(ids(result.messages)).toStrictEqual([first.id, firstAssistant.id, second.id, secondAssistantA.id])
    expect(result.include).toBe(secondAssistantB.id)
  })

  test("awaits async estimate before selecting the retained tail", async () => {
    const first = user("first", 1)
    const firstAssistant = assistant("first_assistant", 2)
    const second = user("second", 3)
    const secondAssistant = assistant("second_assistant", 4)
    const estimate: MessageV2Compaction.Estimate = async (messages) => {
      await Promise.resolve()
      return messages.length
    }

    const result = await select({
      messages: [secondAssistant, second, firstAssistant, first],
      tailTurns: 1,
      preserveRecentTokens: 2,
      estimate,
    })

    expect(result.type).toBe("selected")
    if (result.type !== "selected") return
    expect(ids(result.messages)).toStrictEqual([first.id, firstAssistant.id])
    expect(result.include).toBe(second.id)
  })

  test("splitTurn returns include pointing to an assistant inside the turn when suffix fits", async () => {
    const first = user("first", 1)
    const firstAssistant = assistant("first_assistant", 2)
    const second = user("second", 3)
    const secondAssistantA = assistant("second_assistant_a", 4)
    const secondAssistantB = assistant("second_assistant_b", 5)
    const estimate: MessageV2Compaction.Estimate = (messages) => {
      if (messages.some((message) => message.id === second.id)) return 100
      if (messages.some((message) => message.id === secondAssistantA.id)) return 10
      return 4
    }

    const result = await select({
      messages: [secondAssistantB, secondAssistantA, second, firstAssistant, first],
      tailTurns: 1,
      preserveRecentTokens: 5,
      estimate,
    })

    expect(result.type).toBe("selected")
    if (result.type !== "selected") return
    expect(ids(result.messages)).toStrictEqual([first.id, firstAssistant.id, second.id, secondAssistantA.id])
    expect(result.include).toBe(secondAssistantB.id)
  })

  test("too-small budget with no keep returns all candidate history and no include", async () => {
    const first = user("first", 1)
    const firstAssistant = assistant("first_assistant", 2)
    const second = user("second", 3)
    const secondAssistant = assistant("second_assistant", 4)

    const result = await select({
      messages: [secondAssistant, second, firstAssistant, first],
      tailTurns: 1,
      preserveRecentTokens: 0,
      estimate: () => 100,
    })

    expect(result.type).toBe("selected")
    if (result.type !== "selected") return
    expect(ids(result.messages)).toStrictEqual([first.id, firstAssistant.id, second.id, secondAssistant.id])
    expect(result.include).toBeUndefined()
  })

  test("candidate scope excludes non user/assistant rows", async () => {
    const first = user("first", 1)
    const hidden = shell("shell", 2)
    const after = assistant("after", 3)

    const result = await select({ messages: [after, hidden, first], tailTurns: 0 })

    expect(result.type).toBe("selected")
    if (result.type !== "selected") return
    expect(ids(result.messages)).toStrictEqual([first.id, after.id])
  })
})

test("implementation is pure and has no production compaction or conversion dependencies", async () => {
  const source = await Bun.file(new URL("../../src/session/message-v2-compaction.ts", import.meta.url)).text()
  const forbiddenImports = [
    "@opencode-ai/core/v1/session",
    "@opencode-ai/core/session/sql",
    "@opencode-ai/core/session/session",
    "@opencode-ai/llm",
    "ai",
    "./message-v2",
    "./message-v2-provider",
    "./message-v2-model",
    "./message-v2-readiness",
    "./compaction",
    "./prompt",
    "../provider/provider",
    "../config/config",
    "../plugin/plugin",
  ]
  const forbiddenSymbols = [
    "SessionMessageTable",
    "MessageTable",
    "PartTable",
    "Database",
    "SessionV1",
    "SessionV2",
    "llm.stream",
    "Effect.gen",
  ]

  for (const specifier of forbiddenImports) {
    const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    expect(source).not.toMatch(new RegExp(`from\\s+["']${escaped}["']|import\\(["']${escaped}["']\\)`))
  }
  for (const symbol of forbiddenSymbols) {
    expect(source).not.toContain(symbol)
  }
})
