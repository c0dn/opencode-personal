import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Config } from "@/config/config"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Session } from "@/session/session"
import { SessionSummary } from "@/session/summary"
import { Snapshot } from "@/snapshot"
import { testEffect } from "../lib/effect"

const sentinelDiff: Snapshot.FileDiff = {
  file: "src/changed.ts",
  additions: 7,
  deletions: 2,
  status: "modified",
}

const it = testEffect(Layer.empty)

describe("SessionSummary.computeDiff", () => {
  it.effect("uses legacy assistant snapshot boundaries and ignores text/patch noise", () => {
    const diffFullCalls: Array<{ from: string; to: string }> = []

    return Effect.gen(function* () {
      const summary = yield* SessionSummary.Service
      const diffs = yield* summary.computeDiff({ messages: legacyMessagesWithSnapshotNoise() })

      expect(diffFullCalls).toEqual([{ from: "snap-start-first", to: "snap-finish-latest" }])
      expect(diffs).toEqual([sentinelDiff])
    }).pipe(Effect.provide(makeEnv(diffFullCalls)))
  })
})

function makeEnv(diffFullCalls: Array<{ from: string; to: string }>) {
  return SessionSummary.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(Session.Service)({}),
        Layer.mock(Config.Service)({}),
        Layer.mock(EventV2Bridge.Service)({}),
        Layer.mock(Snapshot.Service)({
          diffFull: (from, to) =>
            Effect.sync(() => {
              diffFullCalls.push({ from, to })
              return [sentinelDiff]
            }),
        }),
      ),
    ),
  )
}

function legacyMessagesWithSnapshotNoise() {
  return [
    legacyMessage("user", [textPart("user asks for a change")]),
    legacyMessage("assistant", [
      textPart("working"),
      stepStartPart("snap-start-first"),
      patchPart("noise-before-finish"),
      stepFinishPart("snap-finish-middle"),
    ]),
    legacyMessage("assistant", [
      textPart("more output"),
      stepStartPart("snap-start-ignored"),
      patchPart("noise-after-start"),
      stepFinishPart("snap-finish-latest"),
    ]),
  ] satisfies SessionV1.WithParts[]
}

function legacyMessage(role: SessionV1.Info["role"], parts: SessionV1.Part[]) {
  return {
    info: { role },
    parts,
  } as SessionV1.WithParts
}

function textPart(text: string) {
  return {
    type: "text",
    text,
  } as SessionV1.Part
}

function patchPart(hash: string) {
  return {
    type: "patch",
    hash,
    files: ["src/noise.ts"],
  } as SessionV1.Part
}

function stepStartPart(snapshot: string) {
  return {
    type: "step-start",
    snapshot,
  } as SessionV1.Part
}

function stepFinishPart(snapshot: string) {
  return {
    type: "step-finish",
    snapshot,
  } as SessionV1.Part
}
