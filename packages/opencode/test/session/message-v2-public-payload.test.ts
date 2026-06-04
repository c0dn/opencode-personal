import { describe, expect, test } from "bun:test"
import { EventV2 } from "@opencode-ai/core/event"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { ToolOutput } from "@opencode-ai/core/tool-output"
import { DateTime } from "effect"
import type { Session } from "../../src/session/session"
import { TranscriptV2PublicPayload } from "../../src/session/transcript-v2-public-payload"

const model = {
  providerID: ProviderV2.ID.make("provider"),
  id: ModelV2.ID.make("model"),
  variant: ModelV2.VariantID.make("default"),
}

const sessionModel = {
  providerID: ProviderV2.ID.make("provider"),
  id: ProviderV2.ModelID.make("model"),
  variant: "default",
}

describe("session.transcript-v2-public-payload", () => {
  test("wraps public envelope and strictly whitelists session fields", () => {
    const payload = TranscriptV2PublicPayload.toPublicTranscriptPayloadV2(session(), [user("one", 1)], { status: "ready" })

    expect(payload.kind).toBe(TranscriptV2PublicPayload.PUBLIC_TRANSCRIPT_KIND)
    expect(payload.version).toBe(TranscriptV2PublicPayload.PUBLIC_TRANSCRIPT_VERSION)
    expect(payload.session).toStrictEqual({
      id: "ses_public",
      title: "Public transcript",
      version: "2.0.0",
      agent: "build",
      model: sessionModel,
      time: { created: 100, updated: 200 },
    })

    const json = JSON.stringify(payload)
    for (const unsafe of ["directory", "path", "projectID", "workspaceID", "parentID", "metadata", "permission", "share", "revert", "summary", "cost", "tokens"]) {
      expect(json).not.toContain(unsafe)
    }
  })

  test("orders messages by canonical created time then ID and rejects legacy-looking IDs", () => {
    const output = TranscriptV2PublicPayload.toPublicTranscriptPayloadV2(session(), [user("later", 2), user("same_b", 1), user("same_a", 1)], {
      status: "ready",
    })

    expect(output.messages.map((message) => message.id)).toStrictEqual([id("same_a"), id("same_b"), id("later")])
    expectNoLegacyIDs(output)
    expect(() => TranscriptV2PublicPayload.toPublicTranscriptPayloadV2(session(), [user("legacy", 1, { id: EventV2.ID.make("msg_legacy") })], { status: "ready" })).toThrow(
      TranscriptV2PublicPayload.PublicTranscriptUnsupportedError,
    )
  })

  test("readiness fails closed unless explicitly ready", () => {
    const messages = [user("ready", 1)]
    const failures: Array<TranscriptV2PublicPayload.PublicTranscriptReadiness | undefined> = [
      undefined,
      { status: "upgrade_pending", reason: "partial" },
      { status: "upgrade_unavailable", reason: "missing-source" },
      { status: "aborted", reason: "mixed_cutoff_ambiguous" },
      { status: "failure", reason: "backfill_failed" },
      { status: "future-status" },
    ]

    expect(TranscriptV2PublicPayload.toPublicTranscriptPayloadV2(session(), messages, { status: "ready" }).messages).toHaveLength(1)
    for (const readiness of failures) {
      expect(() => TranscriptV2PublicPayload.requireReady(readiness)).toThrow(TranscriptV2PublicPayload.PublicTranscriptNotReadyError)
      expect(() => TranscriptV2PublicPayload.toPublicTranscriptPayloadV2(session(), messages, readiness)).toThrow(
        TranscriptV2PublicPayload.PublicTranscriptNotReadyError,
      )
    }
  })

  test("redacts unsafe public fields and excludes reasoning and synthetic content by default", () => {
    const output = TranscriptV2PublicPayload.toPublicTranscriptPayloadV2(
      session(),
      [
        user("request", 1, {
          text: "safe user text",
          taskRequests: [
            new SessionMessage.UserTaskRequest({
              type: "task-request",
              id: id("task_request"),
              prompt: "secret prompt /home/william/project",
              description: "secret description",
              agent: "reviewer",
              model,
              command: "cat /home/william/project/secret.txt",
            }),
          ],
          metadata: { unsafe: "msg_user_metadata" },
        }),
        assistant("answer", 2, [
          text("answer", "safe assistant text"),
          reasoning("reason", "private chain of thought"),
          patch("patch", ["/home/william/project/src/index.ts", "relative/private.txt"]),
          tool(
            "completed",
            new SessionMessage.ToolStateCompleted({
              status: "completed",
              input: { path: "/home/william/project/secret.txt" },
              structured: { output: "secret structured output" },
              content: [
                new ToolOutput.TextContent({ type: "text", text: "secret output" }),
                new ToolOutput.FileContent({ type: "file", uri: "file:///home/william/project/out.txt", mime: "text/plain", name: "out.txt" }),
              ],
            }),
          ),
        ]),
        new SessionMessage.Synthetic({
          type: "synthetic",
          id: id("synthetic"),
          sessionID: SessionV2.ID.make("ses_child"),
          text: "background result",
          time: { created: time(3) },
        }),
        new SessionMessage.Compaction({
          type: "compaction",
          id: id("compaction"),
          reason: "manual",
          summary: "private summary",
          include: id("request"),
          metadata: { unsafe: "prt_compaction_metadata" },
          time: { created: time(4) },
        }),
      ],
      { status: "ready" },
    )

    expect(output.messages.map((message) => message.type)).toStrictEqual(["user", "assistant", "compaction"])
    expect(output.messages[0]).toMatchObject({
      type: "user",
      text: "safe user text",
      taskRequests: [{ id: id("task_request"), prompt: "[redacted]", description: "[redacted]", agent: "reviewer", model, command: "[redacted]" }],
    })
    const answer = output.messages[1]
    if (answer.type !== "assistant") throw new Error("expected assistant")
    expect(answer.content).toStrictEqual([
      { type: "text", id: id("text_answer"), text: "safe assistant text" },
      { type: "patch", id: id("patch_patch"), hash: "hash-patch", files: ["redacted-file-1", "redacted-file-2"] },
      {
        type: "tool",
        id: id("tool_completed"),
        callID: "call-completed",
        name: "bash",
        title: "[redacted]",
        provider: { executed: true },
        state: {
          status: "completed",
          input: "[redacted]",
          structured: "[redacted]",
          content: [
            { type: "text", text: "[redacted]" },
            { type: "file", uri: "redacted://file", mime: "text/plain", name: "[redacted]" },
          ],
        },
        time: { created: 2, ran: 3, completed: 4, pruned: 5 },
      },
    ])
    expect(output.messages[2]).toMatchObject({ type: "compaction", summary: "[redacted]", include: id("request") })

    const json = JSON.stringify(output)
    for (const unsafe of ["metadata", "resultMetadata", "providerMetadata", "private", "/home/william", "secret", "reasoning", "synthetic", "msg_", "prt_"]) {
      expect(json).not.toContain(unsafe)
    }
    expect(json).not.toContain("Search /home/william/project/secret.txt")
  })

  test("unknown and intentionally unsupported current variants fail closed", () => {
    const failures: SessionMessage.Message[] = [
      { ...user("unknown_message", 1), type: "future" } as unknown as SessionMessage.Message,
      new SessionMessage.Shell({ type: "shell", id: id("shell"), callID: "call", command: "pwd", output: "/home/william", time: { created: time(1) } }),
      new SessionMessage.AgentSwitched({ type: "agent-switched", id: id("agent"), agent: "build", time: { created: time(1) } }),
      new SessionMessage.ModelSwitched({ type: "model-switched", id: id("model"), model, time: { created: time(1) } }),
    ]

    for (const message of failures) {
      expect(() => TranscriptV2PublicPayload.toPublicTranscriptPayloadV2(session(), [message], { status: "ready" })).toThrow(
        TranscriptV2PublicPayload.PublicTranscriptUnsupportedError,
      )
    }

    expect(() =>
      TranscriptV2PublicPayload.toPublicTranscriptPayloadV2(
        session(),
        [assistantRaw("unknown_content", 1, [{ type: "future", id: id("future_content") } as unknown as SessionMessage.AssistantContent])],
        { status: "ready" },
      ),
    ).toThrow(TranscriptV2PublicPayload.PublicTranscriptUnsupportedError)

    expect(() =>
      TranscriptV2PublicPayload.toPublicTranscriptPayloadV2(
        session(),
        [assistantRaw("unknown_tool", 1, [toolRaw("future", { status: "future", input: {} } as unknown as SessionMessage.ToolState)])],
        { status: "ready" },
      ),
    ).toThrow(TranscriptV2PublicPayload.PublicTranscriptUnsupportedError)

    expect(() =>
      TranscriptV2PublicPayload.toPublicTranscriptPayloadV2(
        session(),
        [assistantRaw("unknown_output", 1, [toolRaw("output", { status: "completed", input: {}, structured: {}, content: [{ type: "future" }] } as unknown as SessionMessage.ToolState)])],
        { status: "ready" },
      ),
    ).toThrow(TranscriptV2PublicPayload.PublicTranscriptUnsupportedError)
  })

  test("local envelope validator rejects non-public transcript shapes", () => {
    const valid = TranscriptV2PublicPayload.toPublicTranscriptPayloadV2(session(), [user("ok", 1)], { status: "ready" })

    expect(() => TranscriptV2PublicPayload.assertPublicTranscriptPayloadV2(valid)).not.toThrow()
    for (const invalid of [
      { ...valid, kind: undefined },
      { ...valid, version: undefined },
      { ...valid, version: 1 },
      { info: valid.session, messages: valid.messages },
      valid.messages,
      { messages: valid.messages },
    ]) {
      expect(() => TranscriptV2PublicPayload.assertPublicTranscriptPayloadV2(invalid)).toThrow(
        TranscriptV2PublicPayload.PublicTranscriptPayloadValidationError,
      )
    }
  })

  test("source-purity guard does not import legacy readers, database services, or CLI export", async () => {
    const source = await Bun.file(new URL("../../src/session/transcript-v2-public-payload.ts", import.meta.url)).text()

    for (const blocked of ["MessageV2", "SessionLegacy", "MessageTable", "PartTable", "Database.Service", "cmd/export", "cli/cmd/export"]) {
      expect(source).not.toContain(blocked)
    }
  })
})

function session(input?: Partial<Session.Info>): Session.Info {
  return {
    id: SessionV2.ID.make("ses_public"),
    slug: "public",
    projectID: "proj_secret" as Session.Info["projectID"],
    workspaceID: "workspace_secret" as Session.Info["workspaceID"],
    directory: "/home/william/project",
    path: "/home/william/project/.opencode/session.json",
    parentID: SessionV2.ID.make("ses_parent"),
    summary: { additions: 1, deletions: 2, files: 1 },
    cost: 12.5,
    tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } },
    share: { url: "https://example.test/share" },
    title: "Public transcript",
    agent: "build",
    model: sessionModel,
    version: "2.0.0",
    metadata: { unsafe: "metadata" },
    time: { created: 100, updated: 200 },
    permission: [],
    revert: { messageID: "msg_secret" as NonNullable<Session.Info["revert"]>["messageID"], partID: "prt_secret" as NonNullable<Session.Info["revert"]>["partID"] },
    ...input,
  }
}

function id(suffix: string) {
  return EventV2.ID.make(`evt_public_${suffix}`)
}

function time(value: number) {
  return DateTime.makeUnsafe(value)
}

function user(suffix: string, created: number, input?: Partial<SessionMessage.User>): SessionMessage.User {
  return new SessionMessage.User({
    type: "user",
    id: id(suffix),
    text: suffix,
    files: [],
    agents: [],
    references: [],
    time: { created: time(created) },
    ...input,
  })
}

function assistant(
  suffix: string,
  created: number,
  content: SessionMessage.AssistantContent[],
  input?: Partial<SessionMessage.Assistant>,
): SessionMessage.Assistant {
  return new SessionMessage.Assistant({
    type: "assistant",
    id: id(suffix),
    agent: "build",
    model,
    content,
    time: { created: time(created) },
    ...input,
  })
}

function assistantRaw(suffix: string, created: number, content: SessionMessage.AssistantContent[]): SessionMessage.Assistant {
  return { type: "assistant", id: id(suffix), agent: "build", model, content, time: { created: time(created) } } as SessionMessage.Assistant
}

function text(suffix: string, value = suffix) {
  return new SessionMessage.AssistantText({ type: "text", id: id(`text_${suffix}`), text: value })
}

function reasoning(suffix: string, value = suffix) {
  return new SessionMessage.AssistantReasoning({ type: "reasoning", id: id(`reasoning_${suffix}`), reasoningID: `reasoning-${suffix}`, text: value })
}

function patch(suffix: string, files: string[] = ["README.md"]) {
  return new SessionMessage.AssistantPatch({ type: "patch", id: id(`patch_${suffix}`), hash: `hash-${suffix}`, files })
}

function tool(suffix: string, state: SessionMessage.ToolState) {
  return new SessionMessage.AssistantTool({
    type: "tool",
    id: id(`tool_${suffix}`),
    callID: `call-${suffix}`,
    name: "bash",
    title: `Search /home/william/project/secret.txt ${suffix}`,
    provider: {
      executed: true,
      metadata: { provider: { secret: `provider_${suffix}` } },
      resultMetadata: { provider: { secret: `result_${suffix}` } },
    },
    state,
    time: { created: time(2), ran: time(3), completed: time(4), pruned: time(5) },
  })
}

function toolRaw(suffix: string, state: SessionMessage.ToolState) {
  return { type: "tool", id: id(`tool_${suffix}`), callID: `call-${suffix}`, name: "bash", state, time: { created: time(1) } } as SessionMessage.AssistantTool
}

function expectNoLegacyIDs(value: unknown) {
  const json = JSON.stringify(value)
  expect(json).not.toContain("msg_")
  expect(json).not.toContain("prt_")
}
