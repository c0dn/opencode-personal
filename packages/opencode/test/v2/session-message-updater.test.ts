import { expect, test } from "bun:test"
import { Effect } from "effect"
import * as DateTime from "effect/DateTime"
import { EventV2 } from "@opencode-ai/core/event"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionMessageUpdater } from "@opencode-ai/core/session/message-updater"
import { ToolOutput } from "@opencode-ai/core/tool-output"
import { SessionID } from "../../src/session/schema"

const sessionID = SessionID.make("ses_test")
const model = {
  id: ModelV2.ID.make("model"),
  providerID: ProviderV2.ID.make("provider"),
  variant: ModelV2.VariantID.make("default"),
}

function msgID(id: string) {
  return SessionMessage.ID.make(`msg_${id}`)
}

function eventID(id: string) {
  return EventV2.ID.make(id)
}

function applyEvents(events: SessionEvent.Event[]) {
  const state: SessionMessageUpdater.MemoryState = { messages: [] }
  for (const event of events) {
    Effect.runSync(SessionMessageUpdater.update(SessionMessageUpdater.memory(state), event))
  }
  return state
}

test("step snapshots carry over to assistant messages", () => {
  const assistantMessageID = msgID("snapshot_assistant")
  const state = applyEvents([
    {
      id: eventID("evt_snapshot_step_started"),
      type: "session.next.step.started",
      data: { sessionID, assistantMessageID, timestamp: DateTime.makeUnsafe(1), agent: "build", model, snapshot: "before" },
    },
    {
      id: eventID("evt_snapshot_step_ended"),
      type: "session.next.step.ended",
      data: {
        sessionID,
        assistantMessageID,
        timestamp: DateTime.makeUnsafe(2),
        finish: "stop",
        cost: 0,
        tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
        snapshot: "after",
      },
    },
  ] satisfies SessionEvent.Event[])

  expect(state.messages[0]?.type).toBe("assistant")
  if (state.messages[0]?.type !== "assistant") return
  expect(state.messages[0].snapshot).toEqual({ start: "before", end: "after" })
  expect(state.messages[0].finish).toBe("stop")
})

test("targeted step and tool events update only the assistant named by assistantMessageID", () => {
  const firstAssistantID = msgID("first_assistant")
  const secondAssistantID = msgID("second_assistant")
  const state = applyEvents([
    {
      id: eventID("evt_first_step_started"),
      type: "session.next.step.started",
      data: { sessionID, assistantMessageID: firstAssistantID, timestamp: DateTime.makeUnsafe(1), agent: "build", model },
    },
    {
      id: eventID("evt_first_tool_started"),
      type: "session.next.tool.input.started",
      data: { sessionID, assistantMessageID: firstAssistantID, timestamp: DateTime.makeUnsafe(2), callID: "call-first", name: "bash" },
    },
    {
      id: eventID("evt_second_step_started"),
      type: "session.next.step.started",
      data: { sessionID, assistantMessageID: secondAssistantID, timestamp: DateTime.makeUnsafe(3), agent: "build", model },
    },
    {
      id: eventID("evt_first_tool_called"),
      type: "session.next.tool.called",
      data: {
        sessionID,
        assistantMessageID: firstAssistantID,
        timestamp: DateTime.makeUnsafe(4),
        callID: "call-first",
        tool: "bash",
        input: { command: "pwd" },
        provider: { executed: true },
      },
    },
    {
      id: eventID("evt_first_tool_success"),
      type: "session.next.tool.success",
      data: {
        sessionID,
        assistantMessageID: firstAssistantID,
        timestamp: DateTime.makeUnsafe(5),
        callID: "call-first",
        structured: {},
        content: [ToolOutput.text({ type: "text", text: "/tmp" })],
        provider: { executed: true },
      },
    },
    {
      id: eventID("evt_first_step_ended"),
      type: "session.next.step.ended",
      data: {
        sessionID,
        assistantMessageID: firstAssistantID,
        timestamp: DateTime.makeUnsafe(6),
        finish: "stop",
        cost: 1,
        tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    },
  ] satisfies SessionEvent.Event[])

  const first = state.messages.find((message) => message.id === firstAssistantID)
  const second = state.messages.find((message) => message.id === secondAssistantID)
  expect(first?.type).toBe("assistant")
  expect(second?.type).toBe("assistant")
  if (first?.type !== "assistant" || second?.type !== "assistant") return
  expect(first.finish).toBe("stop")
  expect(first.content[0]).toMatchObject({ type: "tool", id: "call-first", state: { status: "completed" } })
  expect(second.finish).toBeUndefined()
  expect(second.content).toEqual([])
})

test("tool settlement keeps call metadata separate from result metadata", () => {
  const assistantID = msgID("metadata_assistant")
  const state = applyEvents([
    {
      id: eventID("evt_metadata_step_started"),
      type: "session.next.step.started",
      data: { sessionID, assistantMessageID: assistantID, timestamp: DateTime.makeUnsafe(1), agent: "build", model },
    },
    {
      id: eventID("evt_metadata_tool_started"),
      type: "session.next.tool.input.started",
      data: { sessionID, assistantMessageID: assistantID, timestamp: DateTime.makeUnsafe(2), callID: "call-metadata", name: "bash" },
    },
    {
      id: eventID("evt_metadata_tool_called"),
      type: "session.next.tool.called",
      data: {
        sessionID,
        assistantMessageID: assistantID,
        timestamp: DateTime.makeUnsafe(3),
        callID: "call-metadata",
        tool: "bash",
        input: { command: "pwd" },
        provider: { executed: false, metadata: { fake: { call: "metadata" } } },
      },
    },
    {
      id: eventID("evt_metadata_tool_success"),
      type: "session.next.tool.success",
      data: {
        sessionID,
        assistantMessageID: assistantID,
        timestamp: DateTime.makeUnsafe(4),
        callID: "call-metadata",
        structured: {},
        content: [ToolOutput.text({ type: "text", text: "/tmp" })],
        provider: { executed: true, metadata: { fake: { result: "metadata" } } },
      },
    },
  ] satisfies SessionEvent.Event[])

  const assistant = state.messages[0]
  expect(assistant?.type).toBe("assistant")
  if (assistant?.type !== "assistant") return
  const item = assistant.content[0]
  expect(item?.type).toBe("tool")
  if (item?.type !== "tool") return
  expect(item.provider).toEqual({
    executed: true,
    metadata: { fake: { call: "metadata" } },
    resultMetadata: { fake: { result: "metadata" } },
  })
})

test("tool failed terminalizes pending tools without creating or overwriting terminal tools", () => {
  const completedTool = new SessionMessage.AssistantTool({
    type: "tool",
    id: "call-completed",
    name: "bash",
    time: { created: DateTime.makeUnsafe(1), ran: DateTime.makeUnsafe(2), completed: DateTime.makeUnsafe(3) },
    provider: { executed: true, metadata: { fake: { call: "metadata" } }, resultMetadata: { fake: { result: "ok" } } },
    state: new SessionMessage.ToolStateCompleted({
      status: "completed",
      input: { command: "pwd" },
      structured: { ok: true },
      content: [],
    }),
  })
  const assistantID = msgID("failure_assistant")
  const state: SessionMessageUpdater.MemoryState = {
    messages: [
      new SessionMessage.Assistant({
        id: assistantID,
        type: "assistant",
        agent: "build",
        model,
        time: { created: DateTime.makeUnsafe(1) },
        content: [completedTool],
      }),
    ],
  }

  for (const event of [
    {
      id: eventID("evt_pending_tool_started"),
      type: "session.next.tool.input.started",
      data: { sessionID, assistantMessageID: assistantID, timestamp: DateTime.makeUnsafe(4), callID: "call-pending", name: "bash" },
    },
    {
      id: eventID("evt_pending_tool_failed"),
      type: "session.next.tool.failed",
      data: {
        sessionID,
        assistantMessageID: assistantID,
        timestamp: DateTime.makeUnsafe(5),
        callID: "call-pending",
        error: { type: "unknown", message: "pending failed" },
        provider: { executed: false, metadata: { fake: { interrupted: true } } },
      },
    },
    {
      id: eventID("evt_completed_tool_failed"),
      type: "session.next.tool.failed",
      data: {
        sessionID,
        assistantMessageID: assistantID,
        timestamp: DateTime.makeUnsafe(6),
        callID: "call-completed",
        error: { type: "unknown", message: "late failure" },
        provider: { executed: false, metadata: { fake: { late: true } } },
      },
    },
    {
      id: eventID("evt_missing_tool_failed"),
      type: "session.next.tool.failed",
      data: {
        sessionID,
        assistantMessageID: assistantID,
        timestamp: DateTime.makeUnsafe(7),
        callID: "call-missing",
        error: { type: "unknown", message: "missing failure" },
        provider: { executed: false, metadata: { fake: { missing: true } } },
      },
    },
  ] satisfies SessionEvent.Event[]) {
    Effect.runSync(SessionMessageUpdater.update(SessionMessageUpdater.memory(state), event))
  }

  const assistant = state.messages[0]
  expect(assistant?.type).toBe("assistant")
  if (assistant?.type !== "assistant") return
  expect(assistant.content).toHaveLength(2)
  expect(assistant.content[0]).toMatchObject({
    type: "tool",
    id: "call-completed",
    provider: { executed: true, metadata: { fake: { call: "metadata" } }, resultMetadata: { fake: { result: "ok" } } },
    state: { status: "completed", structured: { ok: true } },
  })
  expect(assistant.content[1]).toMatchObject({
    type: "tool",
    id: "call-pending",
    provider: { executed: false, resultMetadata: { fake: { interrupted: true } } },
    state: { status: "error", input: {}, structured: {}, content: [], error: { type: "unknown", message: "pending failed" } },
  })
})

test("compaction events reduce to one summary message", () => {
  const messageID = msgID("compaction")
  const state = applyEvents([
    {
      id: eventID("evt_compaction_started"),
      type: "session.next.compaction.started",
      data: { sessionID, messageID, timestamp: DateTime.makeUnsafe(1), reason: "auto" },
    },
    {
      id: eventID("evt_compaction_delta_a"),
      type: "session.next.compaction.delta",
      data: { sessionID, timestamp: DateTime.makeUnsafe(2), text: "hello " },
    },
    {
      id: eventID("evt_compaction_delta_b"),
      type: "session.next.compaction.delta",
      data: { sessionID, timestamp: DateTime.makeUnsafe(3), text: "summary" },
    },
    {
      id: eventID("evt_compaction_ended"),
      type: "session.next.compaction.ended",
      data: { sessionID, timestamp: DateTime.makeUnsafe(4), text: "final summary", include: "recent context" },
    },
  ] satisfies SessionEvent.Event[])

  expect(state.messages).toHaveLength(1)
  expect(state.messages[0]).toMatchObject({
    id: messageID,
    type: "compaction",
    reason: "auto",
    summary: "final summary",
    include: "recent context",
    time: { created: DateTime.makeUnsafe(1) },
  })
})
