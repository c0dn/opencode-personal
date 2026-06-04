import { describe, expect, test } from "bun:test"
import { EventV2 } from "@opencode-ai/core/event"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { DateTime } from "effect"
import { PromptV2LoopState } from "../../src/session/prompt-v2-loop-state"

const model = {
  providerID: ProviderV2.ID.make("provider"),
  id: ModelV2.ID.make("model"),
  variant: ModelV2.VariantID.make("default"),
}

describe("session.prompt-v2-loop-state", () => {
  test("orders canonical messages by time.created and id before computing latest outputs", () => {
    const sameTimeB = user("b", 10)
    const latestAssistant = assistant("z", 30, { finish: "stop" })
    const latestUser = user("y", 20)
    const sameTimeA = assistant("a", 10)

    const state = PromptV2LoopState.compute({ messages: [latestAssistant, sameTimeB, latestUser, sameTimeA] })

    expect(state.orderedMessages.map((message) => message.id)).toStrictEqual([id("a"), id("b"), id("y"), id("z")])
    expect(state.latestUser?.id).toBe(latestUser.id)
    expect(state.latestAssistant?.id).toBe(latestAssistant.id)
    expect(state.latestFinishedAssistant?.id).toBe(latestAssistant.id)
    expect(state.assistantAfterUser).toBe(true)
    expect(state.exitEligibility).toStrictEqual({
      eligible: true,
      reason: "assistant-after-user-finished-without-tools",
    })
  })

  test("keeps latest assistant separate from latest finished assistant for cutoff and overflow", () => {
    const finished = assistant("finished", 10, { finish: "stop" })
    const pending = assistant("pending", 30, { time: { created: DateTime.makeUnsafe(30) } })
    const request = taskRequest("follow-up")
    const afterFinished = user("after_finished", 20, { taskRequests: [request] })

    const state = PromptV2LoopState.compute({ messages: [pending, afterFinished, finished] })

    expect(state.latestAssistant?.id).toBe(pending.id)
    expect(state.latestFinishedAssistant?.id).toBe(finished.id)
    expect(state.exitEligibility).toStrictEqual({ eligible: false, reason: "assistant-not-finished" })
    expect(state.pendingRequests).toStrictEqual([
      { type: "task-request", id: request.id, messageID: afterFinished.id, request },
    ])
  })

  test("requires explicit non-row input for pending compaction requests", () => {
    const finished = assistant("finished", 10, { finish: "stop" })
    const completedAnchor = compaction("completed_anchor", 20)

    expect(PromptV2LoopState.compute({ messages: [finished, completedAnchor] }).pendingRequests).toStrictEqual([])
    expect(PromptV2LoopState.compute({ messages: [finished, completedAnchor] }).pendingCompactionPolicy).toBe(
      "requires-explicit-pending-compaction-input",
    )

    const pendingCompaction = pendingCompactionRequest("pending_compaction", 30)
    expect(
      PromptV2LoopState.compute({ messages: [finished, completedAnchor], pendingCompactionRequests: [pendingCompaction] })
        .pendingRequests,
    ).toStrictEqual([{ type: "compaction", id: pendingCompaction.id, request: pendingCompaction }])
  })

  test("orders pending task requests by canonical user row order and in-row taskRequests order", () => {
    const laterFirst = taskRequest("later first")
    const laterSecond = taskRequest("later second")
    const earlier = taskRequest("earlier")
    const sameTimeA = taskRequest("same time a")
    const sameTimeB = taskRequest("same time b")

    const state = PromptV2LoopState.compute({
      messages: [
        user("z_later", 30, { taskRequests: [laterFirst, laterSecond] }),
        user("b_same", 20, { taskRequests: [sameTimeB] }),
        user("a_same", 20, { taskRequests: [sameTimeA] }),
        user("earlier", 10, { taskRequests: [earlier] }),
      ],
    })

    expect(state.pendingRequests.map((item) => item.id)).toStrictEqual([
      earlier.id,
      sameTimeA.id,
      sameTimeB.id,
      laterFirst.id,
      laterSecond.id,
    ])
  })

  test("orders pending compaction input together with task requests by canonical key", () => {
    const taskA = taskRequest("task a")
    const taskB = taskRequest("task b")
    const compactionA = pendingCompactionRequest("a_compaction", 20)
    const compactionZ = pendingCompactionRequest("z_compaction", 10)

    const state = PromptV2LoopState.compute({
      messages: [user("m_user", 20, { taskRequests: [taskA, taskB] })],
      pendingCompactionRequests: [compactionA, compactionZ],
    })

    expect(state.pendingRequests.map((item) => `${item.type}:${item.id}`)).toStrictEqual([
      `compaction:${compactionZ.id}`,
      `compaction:${compactionA.id}`,
      `task-request:${taskA.id}`,
      `task-request:${taskB.id}`,
    ])
  })

  test("uses latest finished assistant as pending request cutoff", () => {
    const oldRequest = taskRequest("old")
    const newRequest = taskRequest("new")
    const finished = assistant("finished", 20, { finish: "stop" })
    const pendingCompactionBefore = pendingCompactionRequest("before_cutoff", 10)
    const pendingCompactionAfter = pendingCompactionRequest("after_cutoff", 40)

    const state = PromptV2LoopState.compute({
      messages: [user("old_user", 10, { taskRequests: [oldRequest] }), finished, user("new_user", 30, { taskRequests: [newRequest] })],
      pendingCompactionRequests: [pendingCompactionAfter, pendingCompactionBefore],
    })

    expect(state.pendingRequests.map((item) => item.id)).toStrictEqual([newRequest.id, pendingCompactionAfter.id])
  })

  test("blocks exit when latest assistant is not after latest user", () => {
    const state = PromptV2LoopState.compute({ messages: [assistant("answer", 10, { finish: "stop" }), user("next", 20)] })

    expect(state.assistantAfterUser).toBe(false)
    expect(state.exitEligibility).toStrictEqual({ eligible: false, reason: "assistant-not-after-user" })
  })

  test("blocks exit when latest assistant finishes with tool calls", () => {
    const state = PromptV2LoopState.compute({ messages: [user("ask", 1), assistant("answer", 2, { finish: "tool-calls" })] })

    expect(state.exitEligibility).toStrictEqual({ eligible: false, reason: "assistant-finish-tool-calls" })
  })

  test("blocks exit when there is no latest user", () => {
    const state = PromptV2LoopState.compute({ messages: [assistant("answer", 2, { finish: "stop" })] })

    expect(state.exitEligibility).toStrictEqual({ eligible: false, reason: "no-latest-user" })
  })

  test("blocks exit when there is a latest user but no assistant", () => {
    const state = PromptV2LoopState.compute({ messages: [user("ask", 1)] })

    expect(state.exitEligibility).toStrictEqual({ eligible: false, reason: "no-latest-assistant" })
  })

  test("defines tool-call exit semantics for pending, running, completed, and error v2 tool content", () => {
    for (const status of ["pending", "running", "completed", "error"] as const) {
      const state = PromptV2LoopState.compute({
        messages: [user(`user_${status}`, 1), assistant(`assistant_${status}`, 2, { finish: "stop", content: [tool(status)] })],
      })

      expect(state.exitEligibility).toStrictEqual({
        eligible: false,
        reason: "assistant-has-unacknowledged-tools",
        tools: [{ status, providerExecuted: false, blocksExit: true }],
      })
    }
  })

  test("provider-executed v2 tools do not block exit", () => {
    const state = PromptV2LoopState.compute({
      messages: [user("ask", 1), assistant("answer", 2, { finish: "stop", content: [tool("completed", true)] })],
    })

    expect(state.exitEligibility).toStrictEqual({
      eligible: true,
      reason: "assistant-after-user-finished-without-tools",
    })
  })

  test("marks legacy interrupted orphan tool parity as unsupported without guessing", () => {
    const state = PromptV2LoopState.compute({
      messages: [user("ask", 1), assistant("answer", 2, { finish: "stop", content: [tool("error")] })],
    })

    expect(state.unsupported.interruptedOrphanTools).toBe("unsupported-v2-signal-missing")
    expect(PromptV2LoopState.InterruptedOrphanToolPolicy).toBe("unsupported-v2-signal-missing")
  })

  test("source boundary stays pure and unwired", async () => {
    const source = await Bun.file(new URL("../../src/session/prompt-v2-loop-state.ts", import.meta.url)).text()

    for (const blocked of [
      "MessageV2",
      "SessionLegacy",
      "Session.messages",
      "SessionMessageTable",
      "Database",
      "prompt.ts",
      "compaction.ts",
    ]) {
      expect(source).not.toContain(blocked)
    }
  })
})

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
    time: { created: DateTime.makeUnsafe(time), completed: DateTime.makeUnsafe(time + 1) },
    ...input,
  })
}

function compaction(suffix: string, time: number): SessionMessage.Compaction {
  return new SessionMessage.Compaction({
    id: id(suffix),
    type: "compaction",
    reason: "manual",
    summary: "completed summary",
    time: { created: DateTime.makeUnsafe(time) },
  })
}

function taskRequest(prompt: string): SessionMessage.UserTaskRequest {
  return new SessionMessage.UserTaskRequest({
    id: id(prompt.replace(/[^a-z0-9]+/gi, "_")),
    type: "task-request",
    prompt,
    description: "task",
    agent: "build",
  })
}

function pendingCompactionRequest(suffix: string, time: number): PromptV2LoopState.PendingCompactionRequest {
  return { id: id(suffix), type: "compaction", time: { created: DateTime.makeUnsafe(time) }, auto: true }
}

function tool(status: "pending" | "running" | "completed" | "error", providerExecuted = false): SessionMessage.AssistantTool {
  return new SessionMessage.AssistantTool({
    id: id(`tool_${status}_${providerExecuted}`),
    type: "tool",
    callID: `call-${status}`,
    name: "bash",
    provider: providerExecuted ? { executed: true } : undefined,
    state: toolState(status),
    time: { created: DateTime.makeUnsafe(2) },
  })
}

function toolState(status: "pending" | "running" | "completed" | "error"): SessionMessage.ToolState {
  if (status === "pending") return new SessionMessage.ToolStatePending({ status, input: "{}" })
  if (status === "running") return new SessionMessage.ToolStateRunning({ status, input: {}, structured: {}, content: [] })
  if (status === "completed") return new SessionMessage.ToolStateCompleted({ status, input: {}, structured: {}, content: [] })
  return new SessionMessage.ToolStateError({
    status,
    input: {},
    structured: {},
    content: [],
    error: { type: "unknown", message: "failed" },
  })
}

function id(suffix: string) {
  return EventV2.ID.make(`evt_loop_${suffix}`)
}
