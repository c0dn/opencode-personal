import { describe, expect, test } from "bun:test"
import { EventV2 } from "@opencode-ai/core/event"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
import type { SessionMessageBackfillService } from "@opencode-ai/core/session/message-backfill-service"
import { DateTime, Effect, Exit } from "effect"
import { SANITIZE_V2_ERROR, validateExportOptions } from "../../src/cli/cmd/export"
import type { Session } from "../../src/session/session"
import { TranscriptV2PublicExport } from "../../src/session/transcript-v2-public-export"

const sessionID = SessionV2.ID.make("ses_export_v2")
const sessionModel = {
  providerID: ProviderV2.ID.make("provider"),
  id: ProviderV2.ModelID.make("model"),
  variant: "default",
}

describe("cli export", () => {
  test("validates --sanitize is legacy-only with exact text", () => {
    expect(validateExportOptions({ format: "legacy", sanitize: true })).toBeUndefined()
    expect(validateExportOptions({ format: "v2", sanitize: true })).toBe(SANITIZE_V2_ERROR)
  })

  test("v2 export helper emits public v2 envelope from canonical rows only", async () => {
    let readInput: { sessionID: SessionV2.ID; order: "asc" } | undefined
    const payload = await Effect.runPromise(
      TranscriptV2PublicExport.loadPublicTranscriptPayloadV2WithDeps(sessionID, {
        getSessionInfo: () => Effect.succeed(session()),
        ensureBackfilled: () => Effect.succeed({ status: "already_completed" }),
        readMessages: (input) => {
          readInput = input
          return Effect.succeed([user("later", 20), user("earlier", 10)])
        },
      }),
    )

    expect(readInput).toStrictEqual({ sessionID, order: "asc" })
    expect(payload.kind).toBe("opencode.transcript")
    expect(payload.version).toBe(2)
    expect(payload.messages.map((message) => message.id)).toStrictEqual([id("earlier"), id("later")])
    expect(JSON.stringify(payload)).not.toContain("msg_")
    expect(JSON.stringify(payload)).not.toContain("prt_")
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

function user(suffix: string, created: number): SessionMessage.User {
  return new SessionMessage.User({
    type: "user",
    id: id(suffix),
    text: suffix,
    files: [],
    agents: [],
    references: [],
    time: { created: DateTime.makeUnsafe(created) },
  })
}
