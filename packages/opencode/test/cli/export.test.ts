import { describe, expect, test } from "bun:test"
import { EventV2 } from "@opencode-ai/core/event"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
import type { SessionMessageBackfillService } from "@opencode-ai/core/session/message-backfill-service"
import { ToolOutput } from "@opencode-ai/core/tool-output"
import { DateTime, Effect, Exit } from "effect"
import { resolveExportFormat, sanitizePublicTranscriptPayloadV2, validateExportOptions } from "../../src/cli/cmd/export"
import type { Session } from "../../src/session/session"
import { TranscriptV2PublicPayload } from "../../src/session/transcript-v2-public-payload"
import { TranscriptV2PublicExport } from "../../src/session/transcript-v2-public-export"

const sessionID = SessionV2.ID.make("ses_export_v2")
const sessionModel = {
  providerID: ProviderV2.ID.make("provider"),
  id: ProviderV2.ModelID.make("model"),
  variant: "default",
}

const model = {
  providerID: ProviderV2.ID.make("provider"),
  id: ModelV2.ID.make("model"),
  variant: ModelV2.VariantID.make("default"),
}

describe("cli export", () => {
  test("accepts --sanitize with default, legacy alias, and v2 formats", () => {
    expect(validateExportOptions({ sanitize: true })).toBeUndefined()
    expect(validateExportOptions({ format: "legacy", sanitize: true })).toBeUndefined()
    expect(validateExportOptions({ format: "v2", sanitize: true })).toBeUndefined()
  })

  test("normalizes default, legacy alias, and v2 formats to v2 export behavior", () => {
    expect(resolveExportFormat()).toBe("v2")
    expect(resolveExportFormat("legacy")).toBe("v2")
    expect(resolveExportFormat("v2")).toBe("v2")
  })

  test("v2 export helper emits public v2 envelope from canonical rows only", async () => {
    let readInput: { sessionID: SessionV2.ID; order: "asc" } | undefined
    const payload = await Effect.runPromise(
      TranscriptV2PublicExport.loadPublicTranscriptPayloadV2WithDeps(sessionID, {
        getSessionInfo: () => Effect.succeed(session()),
        ensureBackfilled: () => Effect.succeed({ status: "already_completed" }),
        readMessages: (input) => {
          readInput = input
          return Effect.succeed([
            user("later", 20),
            new SessionMessage.Shell({ type: "shell", id: id("shell"), callID: "call-secret", command: "cat msg_secret", output: "prt_secret output", time: { created: DateTime.makeUnsafe(15) } }),
            new SessionMessage.AgentSwitched({ type: "agent-switched", id: id("agent"), agent: "reviewer", time: { created: DateTime.makeUnsafe(16) } }),
            new SessionMessage.ModelSwitched({ type: "model-switched", id: id("model"), model, time: { created: DateTime.makeUnsafe(17) } }),
            user("earlier", 10),
          ])
        },
      }),
    )

    expect(readInput).toStrictEqual({ sessionID, order: "asc" })
    expect(payload.kind).toBe("opencode.transcript")
    expect(payload.version).toBe(2)
    expect(payload.messages.map((message) => message.id)).toStrictEqual([id("earlier"), id("later")])
    const json = JSON.stringify(payload)
    for (const unsafe of ["shell", "agent-switched", "model-switched", "call-secret", "cat msg_secret", "prt_secret output", "command", "output", "msg_", "prt_"]) {
      expect(json).not.toContain(unsafe)
    }
    expect(payload).not.toHaveProperty("info")
  })

  test("v2 export readiness gate fails closed and does not read legacy or v2 messages", async () => {
    let readV2 = false
    const exit = await Effect.runPromise(
      TranscriptV2PublicExport.loadPublicTranscriptPayloadV2WithDeps(sessionID, {
        getSessionInfo: () => Effect.succeed(session()),
        ensureBackfilled: () =>
          Effect.succeed({
            status: "upgrade_pending",
            inserted: 0,
            repaired: 0,
            stats: { mapped: [], degraded: [], skipped: [{ type: "backfill", reason: "legacy_source_unavailable", count: 1 }] },
          } satisfies SessionMessageBackfillService.Result),
        readMessages: () => {
          readV2 = true
          return Effect.succeed([user("should_not_read", 1)])
        },
      }).pipe(Effect.exit),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    expect(readV2).toBe(false)
  })

  test("v2 sanitize preserves public envelope and canonical ids while redacting content fields", () => {
    const payload = TranscriptV2PublicPayload.toPublicTranscriptPayloadV2(
      session({ title: "Secret project title" }),
      [
        user("secret_user", 10, {
          text: "please inspect /home/william/secret.txt",
          taskRequests: [
            new SessionMessage.UserTaskRequest({
              type: "task-request",
              id: id("task_secret"),
              prompt: "secret prompt",
              description: "secret description",
              agent: "build",
              model,
              command: "secret command",
            }),
          ],
        }),
        assistant("secret_assistant", 20, [
          new SessionMessage.AssistantText({ type: "text", id: id("text_secret"), text: "assistant secret" }),
          new SessionMessage.AssistantPatch({ type: "patch", id: id("patch_secret"), hash: "secret_hash", files: ["/home/william/secret.ts"] }),
          new SessionMessage.AssistantTool({
            type: "tool",
            id: id("tool_secret"),
            callID: "call-secret",
            name: "bash",
            title: "Read secret file",
            state: new SessionMessage.ToolStateError({
              status: "error",
              input: { command: "cat secret" },
              structured: { path: "/home/william/secret.txt" },
              content: [
                new ToolOutput.TextContent({ type: "text", text: "secret output" }),
                new ToolOutput.FileContent({ type: "file", uri: "file:///home/william/secret.txt", mime: "text/plain", name: "secret.txt" }),
              ],
              error: { type: "unknown", message: "secret error" },
            }),
            time: { created: DateTime.makeUnsafe(21), ran: DateTime.makeUnsafe(22), completed: DateTime.makeUnsafe(23) },
          }),
        ]),
      ],
      { status: "ready" },
    )

    const sanitized = sanitizePublicTranscriptPayloadV2(payload)

    expect(sanitized.kind).toBe("opencode.transcript")
    expect(sanitized.version).toBe(2)
    expect(sanitized).not.toHaveProperty("info")
    expect(sanitized.messages[0]).not.toHaveProperty("parts")
    expect(sanitized.session.id).toBe(payload.session.id)
    expect(sanitized.session.title).toBe(`[redacted:session-title:${payload.session.id}]`)
    const userMessage = sanitized.messages[0]
    if (userMessage?.type !== "user") throw new Error("expected user message")
    expect(userMessage.id).toBe(id("secret_user"))
    expect(userMessage.text).toBe(`[redacted:user-text:${id("secret_user")}]`)
    expect(userMessage.taskRequests?.[0]).toMatchObject({
      id: id("task_secret"),
      prompt: "[redacted]",
      description: "[redacted]",
      command: "[redacted]",
    })
    const assistantMessage = sanitized.messages[1]
    if (assistantMessage?.type !== "assistant") throw new Error("expected assistant message")
    expect(assistantMessage.id).toBe(id("secret_assistant"))
    expect(assistantMessage.content[0]).toMatchObject({ id: id("text_secret"), text: `[redacted:assistant-text:${id("text_secret")}]` })
    expect(assistantMessage.content[1]).toMatchObject({
      id: id("patch_secret"),
      hash: `[redacted:patch-hash:${id("patch_secret")}]`,
      files: [`[redacted:patch-file:${id("patch_secret")}-0]`],
    })
    const tool = assistantMessage.content[2]
    if (tool?.type !== "tool" || tool.state.status !== "error") throw new Error("expected error tool")
    expect(tool.id).toBe(id("tool_secret"))
    expect(tool.callID).toBe("call-secret")
    expect(tool.title).toBe("[redacted]")
    expect(tool.state).toMatchObject({ input: "[redacted]", structured: "[redacted]", error: "[redacted]" })
    expect(tool.state.content).toStrictEqual([
      { type: "text", text: "[redacted]" },
      { type: "file", uri: "redacted://file", mime: "text/plain", name: "[redacted]" },
    ])
    expect(JSON.stringify(sanitized)).not.toContain("Secret project title")
    expect(JSON.stringify(sanitized)).not.toContain("assistant secret")
    expect(JSON.stringify(sanitized)).not.toContain("secret_hash")
    expect(() => TranscriptV2PublicPayload.assertPublicTranscriptPayloadV2(sanitized)).not.toThrow()
  })

  test("v2 export readiness classifier rejects aborted mixed cutoff", async () => {
    const readiness = TranscriptV2PublicExport.readinessFromBackfillResult({
      status: "aborted",
      reason: "mixed_cutoff_ambiguous",
      stats: { mapped: [], degraded: [], skipped: [] },
    } satisfies SessionMessageBackfillService.Result)

    expect(readiness).toStrictEqual({ status: "aborted", reason: "mixed_cutoff_ambiguous" })
    const exit = await Effect.runPromise(
      TranscriptV2PublicExport.loadPublicTranscriptPayloadV2WithDeps(sessionID, {
        getSessionInfo: () => Effect.succeed(session()),
        ensureBackfilled: () => Effect.succeed({ status: "aborted", reason: "mixed_cutoff_ambiguous", stats: { mapped: [], degraded: [], skipped: [] } }),
        readMessages: () => Effect.die("must not read messages after aborted backfill"),
      }).pipe(Effect.exit),
    )

    expect(Exit.isFailure(exit)).toBe(true)
  })
})

function session(input?: Partial<Session.Info>): Session.Info {
  return {
    id: sessionID,
    slug: "export-v2",
    projectID: "proj_export" as Session.Info["projectID"],
    workspaceID: "workspace_export" as Session.Info["workspaceID"],
    directory: "/tmp/project",
    path: "/tmp/project/.opencode/session.json",
    title: "Export v2",
    agent: "build",
    model: sessionModel,
    version: "2.0.0",
    time: { created: 100, updated: 200 },
    ...input,
  }
}

function id(suffix: string) {
  return EventV2.ID.make(`evt_export_${suffix}`)
}

function user(suffix: string, created: number, input?: Partial<SessionMessage.User>): SessionMessage.User {
  return new SessionMessage.User({
    type: "user",
    id: id(suffix),
    text: suffix,
    files: [],
    agents: [],
    references: [],
    time: { created: DateTime.makeUnsafe(created) },
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
    time: { created: DateTime.makeUnsafe(created) },
  })
}
