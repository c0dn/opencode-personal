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

const modelWithoutVariant = {
  providerID: ProviderV2.ID.make("provider"),
  id: ModelV2.ID.make("model"),
} satisfies SessionMessage.Assistant["model"]

const sessionModel = {
  providerID: ProviderV2.ID.make("provider"),
  id: ProviderV2.ModelID.make("model"),
  variant: "default",
}

const sessionModelWithoutVariant = {
  providerID: ProviderV2.ID.make("provider"),
  id: ProviderV2.ModelID.make("model"),
} satisfies NonNullable<Session.Info["model"]>

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

  test("omits current control rows from public payload by default", () => {
    const output = TranscriptV2PublicPayload.toPublicTranscriptPayloadV2(
      session(),
      [
        user("visible", 1),
        new SessionMessage.Shell({ type: "shell", id: id("shell"), callID: "call", command: "pwd", output: "/home/william", time: { created: time(1) } }),
        new SessionMessage.AgentSwitched({ type: "agent-switched", id: id("agent"), agent: "build", time: { created: time(1) } }),
        new SessionMessage.ModelSwitched({ type: "model-switched", id: id("model"), model, time: { created: time(1) } }),
      ],
      { status: "ready" },
    )

    expect(output.messages.map((message) => message.type)).toStrictEqual(["user"])
    const json = JSON.stringify(output)
    for (const unsafe of ["shell", "agent-switched", "model-switched", "command", "output", "pwd", "/home/william"]) {
      expect(json).not.toContain(unsafe)
    }
  })

  test("unknown future variants fail closed", () => {
    expect(() =>
      TranscriptV2PublicPayload.toPublicTranscriptPayloadV2(session(), [{ ...user("unknown_message", 1), type: "future" } as unknown as SessionMessage.Message], {
        status: "ready",
      }),
    ).toThrow(TranscriptV2PublicPayload.PublicTranscriptUnsupportedError)

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

  test("local envelope validator accepts producer output with variant-less models and remaining content branches", () => {
    const payload = TranscriptV2PublicPayload.toPublicTranscriptPayloadV2(
      session({ model: sessionModelWithoutVariant }),
      [
        user("variantless", 1, {
          taskRequests: [
            new SessionMessage.UserTaskRequest({
              type: "task-request",
              id: id("variantless_task"),
              prompt: "secret prompt",
              description: "secret description",
              agent: "build",
              model: modelWithoutVariant,
            }),
          ],
        }),
        assistant(
          "variantless",
          2,
          [
            patch("variantless", ["/home/william/project/src/index.ts"]),
            tool("pending", new SessionMessage.ToolStatePending({ status: "pending", input: "ls" })),
            tool(
              "running",
              new SessionMessage.ToolStateRunning({
                status: "running",
                input: { cmd: "pwd" },
                structured: { cwd: "/home/william/project" },
                content: [new ToolOutput.TextContent({ type: "text", text: "running output" })],
              }),
            ),
          ],
          { model: modelWithoutVariant },
        ),
      ],
      { status: "ready" },
    )

    expect(payload.session.model).toStrictEqual(sessionModelWithoutVariant)
    const taskRequests = payload.messages[0]?.type === "user" ? payload.messages[0].taskRequests : undefined
    expect(taskRequests?.[0]?.model).toStrictEqual(modelWithoutVariant)
    const assistantMessage = payload.messages[1]
    if (assistantMessage?.type !== "assistant") throw new Error("expected assistant")
    expect(assistantMessage.model).toStrictEqual(modelWithoutVariant)
    expect(assistantMessage.content.map((item) => item.type)).toStrictEqual(["patch", "tool", "tool"])
    expect(() => TranscriptV2PublicPayload.assertPublicTranscriptPayloadV2(payload)).not.toThrow()
  })

  test("converts public v2 import payload to canonical redacted messages", () => {
    const payload = withValue(publicPayloadForValidation(), ["messages", 1, "id"], id("validation_assistant")) as TranscriptV2PublicPayload.PublicTranscriptPayloadV2

    const messages = TranscriptV2PublicPayload.publicTranscriptPayloadV2ToCanonicalMessages(payload)

    expect(messages[0]).toMatchObject({ type: "user", files: [], agents: [], references: [] })
    const assistantMessage = messages[1]
    if (assistantMessage?.type !== "assistant") throw new Error("expected assistant")
    const toolContent = assistantMessage.content.find((item) => item.type === "tool")
    if (toolContent?.type !== "tool" || toolContent.state.status !== "error") throw new Error("expected error tool")
    expect(toolContent.state.input).toStrictEqual({ redacted: true })
    expect(toolContent.state.structured).toStrictEqual({ redacted: true })
    expect(toolContent.state.error).toStrictEqual({ type: "unknown", message: "[redacted]" })
    expect(toolContent.state.content).toEqual([
      { type: "text", text: "[redacted]" },
      { type: "file", uri: "redacted://file", mime: "text/plain", name: "[redacted]" },
    ])
    expect(() => TranscriptV2PublicPayload.publicTranscriptPayloadV2ToCanonicalMessages(withValue(payload, ["messages", 2, "reason"], "future") as TranscriptV2PublicPayload.PublicTranscriptPayloadV2)).toThrow(
      TranscriptV2PublicPayload.PublicTranscriptPayloadValidationError,
    )
    expect(() => TranscriptV2PublicPayload.publicTranscriptPayloadV2ToCanonicalMessages(withValue(payload, ["messages", 1, "id"], payload.messages[0]!.id) as TranscriptV2PublicPayload.PublicTranscriptPayloadV2)).toThrow(
      TranscriptV2PublicPayload.PublicTranscriptPayloadValidationError,
    )
  })

  test("local envelope validator deeply rejects unknown fields and unsafe variants", () => {
    const valid = publicPayloadForValidation()

    for (const invalid of [
      withValue(valid, ["extra"], true),
      withValue(valid, ["session", "metadata"], { unsafe: true }),
      withValue(valid, ["messages", 0, "parts"], []),
      withValue(valid, ["messages", 0, "taskRequests", 0, "metadata"], { unsafe: true }),
      withValue(valid, ["messages", 0, "type"], "synthetic"),
      withValue(valid, ["messages", 0, "type"], "shell"),
      withValue(valid, ["messages", 0, "type"], "agent-switched"),
      withValue(valid, ["messages", 0, "type"], "model-switched"),
      withValue(valid, ["messages", 1, "content", 0, "metadata"], { unsafe: true }),
      withValue(valid, ["messages", 1, "content", 1, "metadata"], { unsafe: true }),
      withValue(valid, ["messages", 1, "content", 0, "type"], "reasoning"),
      withValue(valid, ["messages", 1, "content", 1, "state", "status"], "future"),
      withValue(valid, ["messages", 1, "content", 1, "state", "content", 0, "type"], "json"),
      withValue(valid, ["messages", 1, "content", 1, "provider", "metadata"], { secret: true }),
      withValue(valid, ["messages", 1, "content", 1, "state", "output"], "secret"),
    ]) {
      expect(() => TranscriptV2PublicPayload.assertPublicTranscriptPayloadV2(invalid)).toThrow()
    }
  })

  test("local envelope validator rejects malformed fields, legacy IDs, and unredacted public-only fields", () => {
    const valid = publicPayloadForValidation()

    for (const invalid of [
      null,
      [],
      withValue(valid, ["session", "id"], "msg_session"),
      withValue(valid, ["session", "title"], 123),
      withValue(valid, ["session", "version"], 2),
      withValue(valid, ["session", "time", "created"], Number.NaN),
      withValue(valid, ["session", "time", "updated"], Infinity),
      withValue(valid, ["session", "model", "id"], 123),
      withValue(valid, ["session", "model", "variant"], 123),
      withValue(valid, ["messages", 0, "id"], "msg_user"),
      withValue(valid, ["messages", 0, "time", "created"], "100"),
      withValue(valid, ["messages", 0, "taskRequests", 0, "id"], "prt_task"),
      withValue(valid, ["messages", 0, "taskRequests", 0, "model", "variant"], 123),
      withValue(valid, ["messages", 0, "taskRequests", 0, "prompt"], "secret prompt"),
      withValue(valid, ["messages", 0, "taskRequests", 0, "description"], "secret description"),
      withValue(valid, ["messages", 0, "taskRequests", 0, "command"], "cat secret"),
      withValue(valid, ["messages", 1, "model", "variant"], 123),
      withValue(valid, ["messages", 1, "content", 0, "id"], "prt_text"),
      withValue(valid, ["messages", 1, "content", 1, "callID"], "msg_call"),
      withValue(valid, ["messages", 1, "content", 1, "title"], "secret title"),
      withValue(valid, ["messages", 1, "content", 1, "state", "input"], { path: "/home/william" }),
      withValue(valid, ["messages", 1, "content", 1, "state", "structured"], { output: "secret" }),
      withValue(valid, ["messages", 1, "content", 1, "state", "content", 0, "text"], "secret output"),
      withValue(valid, ["messages", 1, "content", 1, "state", "content", 1, "uri"], "file:///home/william/secret.txt"),
      withValue(valid, ["messages", 1, "content", 1, "state", "content", 1, "name"], "secret.txt"),
      withValue(valid, ["messages", 1, "content", 1, "state", "error"], "secret error"),
      withValue(valid, ["messages", 2, "include"], "prt_include"),
      withValue(valid, ["messages", 2, "summary"], "secret summary"),
    ]) {
      expect(() => TranscriptV2PublicPayload.assertPublicTranscriptPayloadV2(invalid)).toThrow()
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

function publicPayloadForValidation() {
  const payload = TranscriptV2PublicPayload.toPublicTranscriptPayloadV2(
    session(),
    [
      user("validation", 1, {
        taskRequests: [
          new SessionMessage.UserTaskRequest({
            type: "task-request",
            id: id("validation_task"),
            prompt: "secret prompt",
            description: "secret description",
            agent: "build",
            model,
            command: "secret command",
          }),
        ],
      }),
      assistant("validation", 2, [
        text("validation", "safe text"),
        tool(
          "validation",
          new SessionMessage.ToolStateError({
            status: "error",
            input: { secret: true },
            structured: { output: "secret" },
            content: [
              new ToolOutput.TextContent({ type: "text", text: "secret output" }),
              new ToolOutput.FileContent({ type: "file", uri: "file:///home/william/secret.txt", mime: "text/plain", name: "secret.txt" }),
            ],
            error: { type: "unknown", message: "secret error" },
          }),
        ),
      ]),
      new SessionMessage.Compaction({ type: "compaction", id: id("validation_compaction"), reason: "manual", summary: "secret summary", include: id("validation"), time: { created: time(3) } }),
    ],
    { status: "ready" },
  )
  expect(() => TranscriptV2PublicPayload.assertPublicTranscriptPayloadV2(payload)).not.toThrow()
  return payload
}

function withValue(value: unknown, path: readonly (string | number)[], replacement: unknown) {
  const copy = structuredClone(value)
  let cursor = copy as Record<string | number, unknown>
  for (const key of path.slice(0, -1)) cursor = cursor[key] as Record<string | number, unknown>
  cursor[path[path.length - 1]!] = replacement
  return copy
}

function expectNoLegacyIDs(value: unknown) {
  const json = JSON.stringify(value)
  expect(json).not.toContain("msg_")
  expect(json).not.toContain("prt_")
}
