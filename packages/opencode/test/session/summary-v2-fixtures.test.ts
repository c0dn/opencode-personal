import { describe, expect, test } from "bun:test"
import type { Snapshot } from "@/snapshot"

type CanonicalFixtureID = `canonical:${string}`
type LegacyImportFixtureID = `legacy-import:${string}`

type CanonicalFixtureMessage =
  | {
      type: "user"
      id: CanonicalFixtureID
      text: string
    }
  | {
      type: "assistant"
      id: CanonicalFixtureID
      parentUserMessageID: CanonicalFixtureID
      text: string
    }

interface CanonicalSnapshotBoundary {
  assistantMessageID: CanonicalFixtureID
  userMessageID: CanonicalFixtureID
  startSnapshotID: CanonicalFixtureID
  endSnapshotID: CanonicalFixtureID
}

interface SummaryDiffV2Fixture {
  status: "ready"
  userMessageID: CanonicalFixtureID
  messages: CanonicalFixtureMessage[]
  assistantSnapshotBoundaries: CanonicalSnapshotBoundary[]
  expectedDiffsByUserMessageID: Record<CanonicalFixtureID, Snapshot.FileDiff[]>
}

interface UnsupportedStandaloneSnapshotFixture {
  status: "unsupported"
  reason: "standalone-legacy-snapshot"
  legacyImportParts: Array<{ type: "snapshot"; snapshot: LegacyImportFixtureID }>
  assistantSnapshotBoundaries: []
  expectedDiffsByUserMessageID: Record<string, never>
}

describe("summary/diff v2 fixture shape", () => {
  test("keeps canonical user messages diff-free and keys expected diffs separately", () => {
    const fixture = canonicalSummaryDiffFixture()
    const user = fixture.messages.find((message) => message.id === fixture.userMessageID)

    expect(user).toEqual({
      type: "user",
      id: "canonical:user:turn-1",
      text: "change the implementation",
    })
    expect(fixture.assistantSnapshotBoundaries).toEqual([
      {
        assistantMessageID: "canonical:assistant:turn-1",
        userMessageID: "canonical:user:turn-1",
        startSnapshotID: "canonical:snapshot:before-turn-1",
        endSnapshotID: "canonical:snapshot:after-turn-1",
      },
    ])
    expect(fixture.expectedDiffsByUserMessageID[fixture.userMessageID]).toEqual([
      {
        file: "src/app.ts",
        additions: 3,
        deletions: 1,
        status: "modified",
      },
    ])
    expect(publicStrings(fixture).filter(isLegacyRawID)).toEqual([])
    expect(publicIDs(fixture).every((id) => id.startsWith("canonical:"))).toBe(true)
  })

  test("marks standalone legacy snapshots unsupported instead of inventing v2 boundaries", () => {
    const fixture = unsupportedStandaloneSnapshotFixture()

    expect(fixture.status).toBe("unsupported")
    expect(fixture.reason).toBe("standalone-legacy-snapshot")
    expect(fixture.assistantSnapshotBoundaries).toEqual([])
    expect(fixture.expectedDiffsByUserMessageID).toEqual({})
    expect(publicStrings(fixture).filter(isLegacyRawID)).toEqual([])
  })
})

function canonicalSummaryDiffFixture(): SummaryDiffV2Fixture {
  const userMessageID = "canonical:user:turn-1"
  return {
    status: "ready",
    userMessageID,
    messages: [
      {
        type: "user",
        id: userMessageID,
        text: "change the implementation",
      },
      {
        type: "assistant",
        id: "canonical:assistant:turn-1",
        parentUserMessageID: userMessageID,
        text: "done",
      },
    ],
    assistantSnapshotBoundaries: [
      {
        assistantMessageID: "canonical:assistant:turn-1",
        userMessageID,
        startSnapshotID: "canonical:snapshot:before-turn-1",
        endSnapshotID: "canonical:snapshot:after-turn-1",
      },
    ],
    expectedDiffsByUserMessageID: {
      [userMessageID]: [
        {
          file: "src/app.ts",
          additions: 3,
          deletions: 1,
          status: "modified",
        },
      ],
    },
  }
}

function unsupportedStandaloneSnapshotFixture(): UnsupportedStandaloneSnapshotFixture {
  return {
    status: "unsupported",
    reason: "standalone-legacy-snapshot",
    legacyImportParts: [{ type: "snapshot", snapshot: "legacy-import:snapshot:standalone" }],
    assistantSnapshotBoundaries: [],
    expectedDiffsByUserMessageID: {},
  }
}

function publicIDs(fixture: SummaryDiffV2Fixture) {
  return [
    fixture.userMessageID,
    ...Object.keys(fixture.expectedDiffsByUserMessageID),
    ...fixture.messages.map((message) => message.id),
    ...fixture.assistantSnapshotBoundaries.flatMap((boundary) => [
      boundary.assistantMessageID,
      boundary.userMessageID,
      boundary.startSnapshotID,
      boundary.endSnapshotID,
    ]),
  ]
}

function publicStrings(value: unknown): string[] {
  if (typeof value === "string") return [value]
  if (!value || typeof value !== "object") return []
  if (Array.isArray(value)) return value.flatMap(publicStrings)
  return Object.values(value).flatMap(publicStrings)
}

function isLegacyRawID(value: string) {
  return /\b(?:msg|prt)_/.test(value)
}
