import { describe, expect, test } from "bun:test"
import { EventV2 } from "@opencode-ai/core/event"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { ToolOutput } from "@opencode-ai/core/tool-output"
import { DateTime } from "effect"
import { TranscriptV2PublicShare } from "../../src/share/transcript-v2-public-share"
import { TranscriptV2PublicPayload } from "../../src/session/transcript-v2-public-payload"
import type { Session } from "../../src/session/session"

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

describe("share.transcript-v2-public-share", () => {
  test("wraps exactly one versioned v2 public transcript payload item", () => {
    const payload = TranscriptV2PublicPayload.toPublicTranscriptPayloadV2(session(), [user("one", 1)], { status: "ready" })

    const body = TranscriptV2PublicShare.toPublicTranscriptShareSyncBodyV2("sec_test", payload)

    expect(body.secret).toBe("sec_test")
    expect(body.data).toHaveLength(1)
    expect(body.data[0]).toStrictEqual({ type: TranscriptV2PublicShare.PUBLIC_TRANSCRIPT_SHARE_ITEM_TYPE, payload })
    expect(body.data[0].payload.kind).toBe(TranscriptV2PublicPayload.PUBLIC_TRANSCRIPT_KIND)
    expect(body.data[0].payload.version).toBe(TranscriptV2PublicPayload.PUBLIC_TRANSCRIPT_VERSION)
  })

  test("does not emit legacy share item types", () => {
    const body = TranscriptV2PublicShare.toPublicTranscriptShareSyncBodyV2FromRows("sec_test", session(), [user("one", 1)], { status: "ready" })

    const itemTypes = body.data.map((item) => item.type)
    for (const legacyType of ["session", "message", "part", "session_diff", "model"]) {
      expect(itemTypes).not.toContain(legacyType)
    }
  })

  test("delegates canonical rows to existing public payload redaction policy", () => {
    const body = TranscriptV2PublicShare.toPublicTranscriptShareSyncBodyV2FromRows(
      "sec_test",
      session(),
      [
        user("request", 1, {
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
        }),
        assistant("answer", 2, [
          tool(
            "error",
            new SessionMessage.ToolStateError({
              status: "error",
              input: { path: "/home/william/project/secret.txt" },
              structured: { output: "secret structured output" },
              content: [
                new ToolOutput.TextContent({ type: "text", text: "secret output" }),
                new ToolOutput.FileContent({ type: "file", uri: "file:///home/william/project/out.txt", mime: "text/plain", name: "out.txt" }),
              ],
              error: { type: "unknown", message: "secret error" },
            }),
          ),
        ]),
        new SessionMessage.Compaction({
          type: "compaction",
          id: id("compaction"),
          reason: "manual",
          summary: "private summary",
          include: id("request"),
          time: { created: time(3) },
        }),
      ],
      { status: "ready" },
    )

    const payload = body.data[0].payload
    expect(payload.messages[0]).toMatchObject({
      type: "user",
      taskRequests: [{ prompt: "[redacted]", description: "[redacted]", command: "[redacted]" }],
    })
    const answer = payload.messages[1]
    if (answer?.type !== "assistant") throw new Error("expected assistant")
    expect(answer.content).toStrictEqual([
      {
        type: "tool",
        id: id("tool_error"),
        callID: "call-error",
        name: "bash",
        title: "[redacted]",
        provider: { executed: true },
        state: {
          status: "error",
          input: "[redacted]",
          structured: "[redacted]",
          content: [
            { type: "text", text: "[redacted]" },
            { type: "file", uri: "redacted://file", mime: "text/plain", name: "[redacted]" },
          ],
          error: "[redacted]",
        },
        time: { created: 2, ran: 3, completed: 4, pruned: 5 },
      },
    ])
    expect(payload.messages[2]).toMatchObject({ type: "compaction", summary: "[redacted]" })

    const json = JSON.stringify(body)
    for (const unsafe of ["secret prompt", "secret description", "secret structured output", "/home/william", "private summary", "out.txt", "secret output", "secret error"]) {
      expect(json).not.toContain(unsafe)
    }
  })

  test("fails closed on not-ready and ambiguous readiness", () => {
    for (const readiness of [undefined, { status: "upgrade_pending", reason: "partial" }, { status: "aborted", reason: "mixed_cutoff_ambiguous" }]) {
      expect(() => TranscriptV2PublicShare.toPublicTranscriptShareSyncBodyV2FromRows("sec_test", session(), [user("one", 1)], readiness)).toThrow(
        TranscriptV2PublicPayload.PublicTranscriptNotReadyError,
      )
    }
  })

  test("fails closed on raw legacy-looking ids from rows or payloads", () => {
    expect(() =>
      TranscriptV2PublicShare.toPublicTranscriptShareSyncBodyV2FromRows("sec_test", session(), [user("legacy", 1, { id: EventV2.ID.make("msg_legacy") })], {
        status: "ready",
      }),
    ).toThrow(TranscriptV2PublicPayload.PublicTranscriptUnsupportedError)

    const payload = TranscriptV2PublicPayload.toPublicTranscriptPayloadV2(session(), [user("one", 1)], { status: "ready" })
    const legacyPayload = { ...payload, session: { ...payload.session, id: "prt_session" } }
    expect(() => TranscriptV2PublicShare.toPublicTranscriptShareItemV2(legacyPayload)).toThrow(
      TranscriptV2PublicPayload.PublicTranscriptPayloadValidationError,
    )
  })

  test("source guard keeps helper unwired from share runtime, services, readers, and CLI import/export", async () => {
    const source = await Bun.file(new URL("../../src/share/transcript-v2-public-share.ts", import.meta.url)).text()

    for (const blocked of ["ShareNext", "HttpClient", "Database", "Session.Service", "Provider", "MessageV2", "SessionLegacy", "MessageTable", "PartTable", "cli/cmd/export", "cli/cmd/import"]) {
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
    title: "Public transcript",
    agent: "build",
    model: sessionModel,
    version: "2.0.0",
    metadata: { unsafe: "metadata" },
    time: { created: 100, updated: 200 },
    permission: [],
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

function assistant(suffix: string, created: number, content: SessionMessage.AssistantContent[]): SessionMessage.Assistant {
  return new SessionMessage.Assistant({
    type: "assistant",
    id: id(suffix),
    agent: "build",
    model,
    content,
    time: { created: time(created) },
  })
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
