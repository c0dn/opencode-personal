import { describe, expect, test } from "bun:test"
import type { AssistantMessage, Message, Part, Session, SessionStatus } from "@opencode-ai/sdk/v2/client"
import { agentManagerResourceKey, deriveAgentManagerRows, fetchDescendants } from "./agent-manager-state"

// Tests the agent-manager state through its extracted, production-used seams.
//
// Why not the live createResource/createMemo graph: under `bun test`, solid-js
// resolves to its server build, where createResource (hydration context) cannot
// run and createMemo does not re-run on store writes. So:
//   - "refetch only on root/membership change" is guarded via agentManagerResourceKey
//   - "degrade to local-only on error" is guarded via fetchDescendants
//   - "status/membership update rows live" is guarded by re-deriving rows from the
//     updated snapshot (deriveAgentManagerRows is the exact code the production
//     memo runs); pairing it with a stable resource key proves status updates rows
//     WITHOUT changing the fetch key (i.e. without a refetch).
type Data = {
  session: Session[]
  message: Record<string, Message[]>
  part: Record<string, Part[]>
  session_status: Record<string, SessionStatus | undefined>
}

const session = (id: string, over: Partial<Session> = {}): Session =>
  ({
    id,
    slug: id,
    projectID: "prj",
    directory: "/project",
    title: `title-${id}`,
    version: "1",
    time: { created: 1000, updated: 1000 },
    ...over,
  }) as Session

const assistantMessage = (id: string, sessionID: string, over: Partial<AssistantMessage> = {}): Message =>
  ({
    id,
    sessionID,
    role: "assistant",
    time: { created: 1 },
    parentID: "p",
    modelID: "x",
    providerID: "anthropic",
    mode: "primary",
    agent: "build",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ...over,
  }) as Message

// Smallest possible fake at the true external boundary: the SDK HTTP client.
function fakeSDK(descendants: (args: { sessionID: string }) => Promise<{ data?: { session: Session; depth: number }[] }>) {
  const calls = { count: 0 }
  const client = {
    session: {
      descendants: (args: { sessionID: string }) => {
        calls.count++
        return descendants(args)
      },
      abort: () => Promise.resolve({}),
    },
  }
  return { sdk: { client } as unknown as Parameters<typeof fetchDescendants>[0], calls }
}

const asData = (data: Data) => data as unknown as Parameters<typeof deriveAgentManagerRows>[1]

describe("agentManagerResourceKey (refetch only on root/membership change)", () => {
  const sessions = [session("root"), session("child", { parentID: "root" }), session("grand", { parentID: "child" })]

  test("is undefined without a root so no descendants fetch is keyed", () => {
    expect(agentManagerResourceKey(undefined, sessions)).toBeUndefined()
  })

  test("is unchanged when only status/title changes (no refetch on a status tick)", () => {
    const before = agentManagerResourceKey("root", sessions)
    const renamed = sessions.map((s) => (s.id === "child" ? session("child", { parentID: "root", title: "renamed" }) : s))
    expect(agentManagerResourceKey("root", renamed)).toBe(before)
  })

  test("changes when a descendant is added or removed (drives a refetch)", () => {
    const before = agentManagerResourceKey("root", sessions)
    const added = agentManagerResourceKey("root", [...sessions, session("new", { parentID: "root" })])
    const removed = agentManagerResourceKey(
      "root",
      sessions.filter((s) => s.id !== "grand"),
    )
    expect(added).not.toBe(before)
    expect(removed).not.toBe(before)
  })
})

describe("fetchDescendants (server boundary)", () => {
  test("returns the server descendant tree on success", async () => {
    const tree = [{ session: session("child", { parentID: "root" }), depth: 1 }]
    const { sdk } = fakeSDK(async () => ({ data: tree }))
    expect(await fetchDescendants(sdk, "root")).toEqual(tree)
  })

  test("degrades to an empty list when the SDK call rejects", async () => {
    const { sdk, calls } = fakeSDK(async () => {
      throw new Error("network down")
    })
    expect(await fetchDescendants(sdk, "root")).toEqual([])
    expect(calls.count).toBe(1)
  })

  test("degrades to an empty list when the response has no data", async () => {
    const { sdk } = fakeSDK(async () => ({}))
    expect(await fetchDescendants(sdk, "root")).toEqual([])
  })
})

describe("deriveAgentManagerRows (live rows derivation)", () => {
  const childSessions = [session("root"), session("child", { parentID: "root", agent: "explore" })]

  test("a status change updates the row but NOT the resource key (live status, no refetch)", () => {
    const busy: Data = {
      session: childSessions,
      message: { child: [assistantMessage("c_a", "child")] },
      part: {},
      session_status: { child: { type: "busy" } as SessionStatus },
    }
    const idle: Data = { ...busy, session_status: {} }

    expect(deriveAgentManagerRows("root", asData(busy), []).find((r) => r.sessionID === "child")?.status).toBe("running")
    expect(deriveAgentManagerRows("root", asData(idle), []).find((r) => r.sessionID === "child")?.status).toBe("idle")
    // Same sessions => identical resource key => the descendant tree is not refetched.
    expect(agentManagerResourceKey("root", idle.session)).toBe(agentManagerResourceKey("root", busy.session))
  })

  test("a membership change updates rows and the resource key (drives a refetch)", () => {
    const one: Data = { session: [session("root"), session("child", { parentID: "root" })], message: {}, part: {}, session_status: {} }
    const two: Data = { ...one, session: [...one.session, session("child2", { parentID: "root" })] }

    expect(deriveAgentManagerRows("root", asData(one), []).map((r) => r.sessionID)).toEqual(["child"])
    expect(
      deriveAgentManagerRows("root", asData(two), [])
        .map((r) => r.sessionID)
        .sort(),
    ).toEqual(["child", "child2"])
    expect(agentManagerResourceKey("root", two.session)).not.toBe(agentManagerResourceKey("root", one.session))
  })

  test("runningCount input reflects busy descendants (the value the shared badge counts)", () => {
    const data: Data = {
      session: [session("root"), session("childBusy", { parentID: "root" }), session("childIdle", { parentID: "root" })],
      message: { childIdle: [assistantMessage("i_a", "childIdle")] },
      part: {},
      session_status: { childBusy: { type: "busy" } as SessionStatus },
    }
    const running = deriveAgentManagerRows("root", asData(data), []).filter((r) => r.status === "running")
    expect(running.map((r) => r.sessionID)).toEqual(["childBusy"])
  })

  test("with no server descendants (e.g. after a fetch error) membership is local-only", () => {
    const data: Data = {
      session: [session("root"), session("childBusy", { parentID: "root" }), session("childIdle", { parentID: "root" })],
      message: { childIdle: [assistantMessage("i_a", "childIdle")] },
      part: {},
      session_status: { childBusy: { type: "busy" } as SessionStatus },
    }
    const rows = deriveAgentManagerRows("root", asData(data), [])
    expect(rows.map((r) => r.sessionID).sort()).toEqual(["childBusy", "childIdle"])
    expect(rows.filter((r) => r.status === "running")).toHaveLength(1)
  })

  test("returns no rows without a root", () => {
    expect(deriveAgentManagerRows(undefined, asData({ session: [], message: {}, part: {}, session_status: {} }), [])).toEqual([])
  })
})
