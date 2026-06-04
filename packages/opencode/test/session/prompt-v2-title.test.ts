import { describe, expect, test } from "bun:test"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
import type { SessionMessageBackfillService } from "@opencode-ai/core/session/message-backfill-service"
import { FileAttachment } from "@opencode-ai/core/session/prompt"
import { DateTime } from "effect"
import { PromptV2Title } from "../../src/session/prompt-v2-title"

const defaultSession = {
  isDefaultTitle: true,
}

describe("session.prompt-v2-title", () => {
  test("skips parent sessions", () => {
    expect(
      PromptV2Title.decide({
        readiness: { status: "ready" },
        session: { ...defaultSession, parentID: SessionV2.ID.make("ses_parent") },
        messages: [user("first", { text: "visible" })],
      }),
    ).toStrictEqual({ type: "skip", reason: "parent-session" })
  })

  test("skips non-default titles", () => {
    expect(
      PromptV2Title.decide({
        readiness: { status: "ready" },
        session: { isDefaultTitle: false },
        messages: [user("first", { text: "visible" })],
      }),
    ).toStrictEqual({ type: "skip", reason: "non-default-title" })
  })

  test("skips empty visible user title sources", () => {
    expect(
      PromptV2Title.decide({
        readiness: { status: "ready" },
        session: defaultSession,
        messages: [user("blank", { text: "  \n\t  ", files: [], taskRequests: [] })],
      }),
    ).toStrictEqual({ type: "skip", reason: "empty-title-source" })
  })

  test("generates from files-only visible user sources", () => {
    const attachment = file("file:///work/notes.txt", "notes.txt")

    expect(
      PromptV2Title.decide({
        readiness: { status: "ready" },
        session: defaultSession,
        messages: [user("file_only", { text: "", files: [attachment] })],
      }),
    ).toStrictEqual({
      type: "generate",
      source: { mode: "visible-user", text: "", files: [attachment] },
    })
  })

  test("skips taskRequests-only users with empty prompts", () => {
    expect(
      PromptV2Title.decide({
        readiness: { status: "ready" },
        session: defaultSession,
        messages: [
          user("blank_tasks", {
            text: "",
            taskRequests: [taskRequest("  "), taskRequest("\n\t")],
          }),
        ],
      }),
    ).toStrictEqual({ type: "skip", reason: "empty-title-source" })
  })

  test("skips synthetic-only rows because synthetic rows are not real users", () => {
    expect(
      PromptV2Title.decide({
        readiness: { status: "ready" },
        session: defaultSession,
        messages: [synthetic("first", "background completion"), synthetic("second", "follow-up")],
      }),
    ).toStrictEqual({ type: "skip", reason: "no-real-user" })
  })

  test("generates from a real user after leading synthetic rows", () => {
    expect(
      PromptV2Title.decide({
        readiness: { status: "ready" },
        session: defaultSession,
        messages: [synthetic("first", "ignore me"), user("real", { text: "title this real request" })],
      }),
    ).toStrictEqual({
      type: "generate",
      source: { mode: "visible-user", text: "title this real request", files: [] },
    })
  })

  test("generates from joined task request prompts for taskRequests-only users", () => {
    expect(
      PromptV2Title.decide({
        readiness: { status: "ready" },
        session: defaultSession,
        messages: [
          user("task", {
            text: "",
            taskRequests: [taskRequest("audit the parser"), taskRequest("summarize findings")],
          }),
        ],
      }),
    ).toStrictEqual({
      type: "generate",
      source: { mode: "task-requests", text: "audit the parser\nsummarize findings", files: [] },
    })
  })

  test("mixed visible text and taskRequests generates from visible user content only", () => {
    expect(
      PromptV2Title.decide({
        readiness: { status: "ready" },
        session: defaultSession,
        messages: [
          user("mixed", {
            text: "visible request",
            files: [file("file:///work/README.md", "README.md")],
            taskRequests: [taskRequest("hidden subagent prompt")],
          }),
        ],
      }),
    ).toStrictEqual({
      type: "generate",
      source: {
        mode: "visible-user",
        text: "visible request",
        files: [file("file:///work/README.md", "README.md")],
      },
    })
  })

  test("multiple real users use the first real user", () => {
    expect(
      PromptV2Title.decide({
        readiness: { status: "ready" },
        session: defaultSession,
        messages: [user("first", { text: "first request" }), user("second", { text: "second request" })],
      }),
    ).toStrictEqual({ type: "generate", source: { mode: "visible-user", text: "first request", files: [] } })
  })

  test("skips not-ready and ambiguous backfill input without implying title mutation", () => {
    expect(
      PromptV2Title.decide({
        readiness: { status: "not-ready", reason: "legacy_source_unavailable" },
        session: defaultSession,
        messages: [user("first", { text: "visible" })],
      }),
    ).toStrictEqual({ type: "skip", reason: "backfill-not-ready", detail: "legacy_source_unavailable" })

    expect(
      PromptV2Title.decide({
        readiness: { status: "ambiguous", reason: "mixed_cutoff_ambiguous" },
        session: defaultSession,
        messages: [user("first", { text: "visible" })],
      }),
    ).toStrictEqual({ type: "skip", reason: "backfill-ambiguous", detail: "mixed_cutoff_ambiguous" })
  })

  test("classifies title-specific backfill readiness conservatively", () => {
    expect(
      PromptV2Title.classifyBackfillTitleReadiness({
        status: "upgrade_pending",
        stats: stats({ skipped: [stat("tool", "tool_title_schema_missing"), stat("assistant", "patch_schema_missing")] }),
        inserted: 0,
        repaired: 0,
      }),
    ).toStrictEqual({ status: "ready" })

    expect(
      PromptV2Title.classifyBackfillTitleReadiness({
        status: "upgrade_pending",
        stats: stats({ skipped: [stat("future", "future_schema_missing")] }),
        inserted: 0,
        repaired: 0,
      }),
    ).toStrictEqual({ status: "not-ready", reason: "upgrade_pending" })

    expect(
      PromptV2Title.classifyBackfillTitleReadiness({
        status: "upgrade_unavailable",
        stats: stats(),
        inserted: 0,
        repaired: 0,
      }),
    ).toStrictEqual({ status: "not-ready", reason: "upgrade_unavailable" })

    expect(
      PromptV2Title.classifyBackfillTitleReadiness({
        status: "aborted",
        reason: "mixed_cutoff_ambiguous",
        stats: stats(),
      }),
    ).toStrictEqual({ status: "ambiguous", reason: "mixed_cutoff_ambiguous" })

    expect(
      PromptV2Title.classifyBackfillTitleReadiness({
        status: "aborted",
        reason: "deterministic_id_collision",
        stats: stats(),
      }),
    ).toStrictEqual({ status: "not-ready", reason: "deterministic_id_collision" })

    expect(PromptV2Title.classifyBackfillTitleFailure()).toStrictEqual({
      status: "not-ready",
      reason: "backfill_failed",
    })
  })

  test("source boundary stays pure and unwired", async () => {
    const source = await Bun.file(new URL("../../src/session/prompt-v2-title.ts", import.meta.url)).text()

    for (const blocked of [
      "SessionLegacy",
      "MessageV2",
      "SessionMessageTable",
      "Database",
      "PromptV2Context",
      "llm",
      "setTitle",
      "prompt.ts",
    ]) {
      expect(source).not.toContain(blocked)
    }
  })
})

function user(suffix: string, input: Partial<SessionMessage.User>): SessionMessage.User {
  return new SessionMessage.User({
    id: id(suffix),
    type: "user",
    text: "",
    files: [],
    agents: [],
    references: [],
    time: { created: DateTime.makeUnsafe(1) },
    ...input,
  })
}

function synthetic(suffix: string, text: string): SessionMessage.Synthetic {
  return new SessionMessage.Synthetic({
    id: id(suffix),
    type: "synthetic",
    sessionID: SessionV2.ID.make("ses_child"),
    text,
    time: { created: DateTime.makeUnsafe(1) },
  })
}

function taskRequest(prompt: string): SessionMessage.UserTaskRequest {
  return new SessionMessage.UserTaskRequest({
    type: "task-request",
    id: id(prompt.replace(/[^a-z0-9]+/gi, "_")),
    prompt,
    description: "task",
    agent: "build",
  })
}

function file(uri: string, name: string): FileAttachment {
  return new FileAttachment({ uri, mime: "text/plain", name })
}

function stats(input?: Partial<Extract<SessionMessageBackfillService.Result, { status: "upgrade_pending" }>["stats"]>) {
  return {
    mapped: [],
    degraded: [],
    skipped: [],
    ...input,
  }
}

function stat(type: string, reason: string) {
  return { type, reason, count: 1 }
}

function id(suffix: string) {
  return EventV2.ID.make(`evt_title_${suffix}`)
}
