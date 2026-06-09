import { describe, expect, test } from "bun:test"
import type { AssistantMessage, Message, Part, Session, SessionStatus } from "@opencode-ai/sdk/v2/client"
import { deriveSubagentRows, localDescendantSignature, resolveRootID, type SubagentSource } from "./subagent-rows"

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

const userMessage = (id: string, sessionID: string): Message =>
  ({
    id,
    sessionID,
    role: "user",
    time: { created: 1 },
    agent: "build",
    model: { providerID: "anthropic", modelID: "x" },
  }) as Message

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

const taskPart = (id: string, messageID: string, sessionID: string, childID: string, description?: string): Part =>
  ({
    id,
    sessionID,
    messageID,
    type: "tool",
    callID: id,
    tool: "task",
    state: {
      status: "completed",
      input: description ? { description } : {},
      output: "",
      title: "task",
      metadata: { sessionId: childID },
      time: { start: 1, end: 2 },
    },
  }) as Part

describe("deriveSubagentRows", () => {
  test("derives a row per task-spawned child with status from the status map and last assistant message", () => {
    const source: SubagentSource = {
      rootID: "root",
      messages: {
        root: [userMessage("msg_user", "root"), assistantMessage("msg_assist", "root")],
        // running child: present in status map as busy
        childBusy: [assistantMessage("c1_a", "childBusy")],
        // completed child: absent from status map, last assistant completed
        childDone: [assistantMessage("c2_a", "childDone", { time: { created: 1, completed: 99 } })],
        // errored child: absent from status map, last assistant has error
        childErr: [
          assistantMessage("c3_a", "childErr", {
            error: { name: "UnknownError", data: { message: "boom" } } as AssistantMessage["error"],
          }),
        ],
        // idle child: absent from status map, no completed assistant message
        childIdle: [assistantMessage("c4_a", "childIdle")],
      },
      parts: {
        msg_assist: [
          taskPart("prt_1", "msg_assist", "root", "childBusy", "spin"),
          taskPart("prt_2", "msg_assist", "root", "childDone"),
          taskPart("prt_3", "msg_assist", "root", "childErr"),
          taskPart("prt_4", "msg_assist", "root", "childIdle"),
        ],
      },
      sessions: [
        session("root"),
        session("childBusy", { parentID: "root", agent: "explore", time: { created: 1001, updated: 1001 } }),
        session("childDone", { parentID: "root", agent: "build", time: { created: 1002, updated: 1002 } }),
        session("childErr", { parentID: "root", agent: "build", time: { created: 1003, updated: 1003 } }),
        session("childIdle", { parentID: "root", agent: "build", time: { created: 1004, updated: 1004 } }),
      ],
      status: {
        childBusy: { type: "busy" } satisfies SessionStatus,
      },
      serverDescendants: [],
    }

    const rows = deriveSubagentRows(source)
    expect(rows.map((row) => row.sessionID)).toEqual(["childBusy", "childDone", "childErr", "childIdle"])

    const byId = new Map(rows.map((row) => [row.sessionID, row]))
    expect(byId.get("childBusy")).toMatchObject({ status: "running", busy: true, agent: "explore", depth: 1 })
    expect(byId.get("childDone")).toMatchObject({ status: "completed", busy: false, depth: 1 })
    expect(byId.get("childErr")).toMatchObject({ status: "error", busy: false, depth: 1 })
    expect(byId.get("childIdle")).toMatchObject({ status: "idle", busy: false, depth: 1 })
    expect(byId.get("childBusy")?.spawnMessageID).toBe("msg_assist")
  })

  test("treats retry status as running", () => {
    const source: SubagentSource = {
      rootID: "root",
      messages: { root: [assistantMessage("m", "root")], child: [assistantMessage("ca", "child")] },
      parts: { m: [taskPart("p", "m", "root", "child")] },
      sessions: [session("root"), session("child", { parentID: "root" })],
      status: { child: { type: "retry", attempt: 1, message: "retry", next: 1 } satisfies SessionStatus },
      serverDescendants: [],
    }
    expect(deriveSubagentRows(source)[0]).toMatchObject({ status: "running", busy: true })
  })

  test("includes children that exist as sessions but lack a visible task part", () => {
    const source: SubagentSource = {
      rootID: "root",
      messages: { root: [assistantMessage("m", "root")] },
      parts: {},
      sessions: [session("root"), session("orphan", { parentID: "root" })],
      status: {},
      serverDescendants: [],
    }
    const rows = deriveSubagentRows(source)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ sessionID: "orphan", status: "idle", spawnMessageID: undefined, depth: 1 })
  })

  test("falls back to task description then sessionID when title is empty", () => {
    const source: SubagentSource = {
      rootID: "root",
      messages: { root: [assistantMessage("m", "root")], child: [] },
      parts: { m: [taskPart("p", "m", "root", "child", "investigate logs")] },
      sessions: [session("root"), session("child", { parentID: "root", title: "  " })],
      status: {},
      serverDescendants: [],
    }
    expect(deriveSubagentRows(source)[0].title).toBe("investigate logs")
  })

  test("does not duplicate a child referenced by both a task part and a session record", () => {
    const source: SubagentSource = {
      rootID: "root",
      messages: { root: [assistantMessage("m", "root")], child: [assistantMessage("ca", "child")] },
      parts: { m: [taskPart("p", "m", "root", "child")] },
      sessions: [session("root"), session("child", { parentID: "root" })],
      status: {},
      serverDescendants: [],
    }
    expect(deriveSubagentRows(source)).toHaveLength(1)
  })

  test("derives multi-level depth from the local parentID walk (grandchildren and deeper)", () => {
    const source: SubagentSource = {
      rootID: "root",
      messages: {
        root: [assistantMessage("m", "root")],
        child: [assistantMessage("ca", "child")],
        grandchild: [assistantMessage("ga", "grandchild")],
        greatgrandchild: [assistantMessage("gga", "greatgrandchild")],
      },
      parts: { m: [taskPart("p", "m", "root", "child")] },
      sessions: [
        session("root"),
        session("child", { parentID: "root", time: { created: 1001, updated: 1001 } }),
        session("grandchild", { parentID: "child", time: { created: 1002, updated: 1002 } }),
        session("greatgrandchild", { parentID: "grandchild", time: { created: 1003, updated: 1003 } }),
      ],
      status: {},
      serverDescendants: [],
    }
    const rows = deriveSubagentRows(source)
    const byId = new Map(rows.map((row) => [row.sessionID, row]))
    expect(byId.get("child")?.depth).toBe(1)
    expect(byId.get("grandchild")?.depth).toBe(2)
    expect(byId.get("greatgrandchild")?.depth).toBe(3)
    // ordered by depth ascending
    expect(rows.map((row) => row.depth)).toEqual([1, 2, 3])
    // only direct child carries a spawn anchor
    expect(byId.get("child")?.spawnMessageID).toBe("m")
    expect(byId.get("grandchild")?.spawnMessageID).toBeUndefined()
  })

  test("merges server descendants (deep sessions not loaded locally) and dedupes by id with server depth winning", () => {
    const source: SubagentSource = {
      rootID: "root",
      messages: { root: [assistantMessage("m", "root")] },
      parts: {},
      sessions: [session("root"), session("child", { parentID: "root", time: { created: 1001, updated: 1001 } })],
      status: {},
      serverDescendants: [
        // also reported by the server; must not duplicate
        { sessionID: "child", depth: 1 },
        // deep session only known to the server (its session record is not in the store)
        { sessionID: "deep", depth: 3 },
      ],
    }
    const rows = deriveSubagentRows(source)
    expect(rows.map((row) => row.sessionID).sort()).toEqual(["child", "deep"])
    const byId = new Map(rows.map((row) => [row.sessionID, row]))
    expect(byId.get("child")?.depth).toBe(1)
    expect(byId.get("deep")).toMatchObject({ depth: 3, title: "deep", parentID: "root" })
  })

  test("server depth overrides a locally computed chain depth", () => {
    const source: SubagentSource = {
      rootID: "root",
      messages: { root: [assistantMessage("m", "root")] },
      parts: {},
      sessions: [
        session("root"),
        session("child", { parentID: "root" }),
        session("grandchild", { parentID: "child" }),
      ],
      // server says grandchild is at depth 2 (matches), but assert override path explicitly
      serverDescendants: [{ sessionID: "grandchild", depth: 5 }],
      status: {},
    }
    const byId = new Map(deriveSubagentRows(source).map((row) => [row.sessionID, row]))
    expect(byId.get("grandchild")?.depth).toBe(5)
  })
})

describe("localDescendantSignature", () => {
  const sessions = [
    session("root"),
    session("child", { parentID: "root" }),
    session("grandchild", { parentID: "child" }),
    session("unrelated", { parentID: "other-root" }),
  ]

  test("returns a sorted id list of the transitive descendants of the root", () => {
    expect(localDescendantSignature(sessions, "root")).toBe("child,grandchild")
  })

  test("is stable regardless of session array order", () => {
    const a = localDescendantSignature(sessions, "root")
    const b = localDescendantSignature([...sessions].reverse(), "root")
    expect(a).toBe(b)
  })

  test("changes when a new descendant is added", () => {
    const before = localDescendantSignature(sessions, "root")
    const after = localDescendantSignature([...sessions, session("newchild", { parentID: "root" })], "root")
    expect(after).not.toBe(before)
  })

  test("changes when a descendant is removed", () => {
    const before = localDescendantSignature(sessions, "root")
    const after = localDescendantSignature(
      sessions.filter((s) => s.id !== "grandchild"),
      "root",
    )
    expect(after).not.toBe(before)
  })

  test("is unchanged when only title/agent/status changes on an existing descendant", () => {
    // The key reads only id/parentID, so status/title/agent ticks must not change
    // the signature (and therefore never trigger a descendants refetch).
    const before = localDescendantSignature(sessions, "root")
    const mutated = sessions.map((s) =>
      s.id === "child" ? session("child", { parentID: "root", title: "renamed", agent: "explore" }) : s,
    )
    expect(localDescendantSignature(mutated, "root")).toBe(before)
  })
})

describe("resolveRootID", () => {
  const sessions = new Map<string, { parentID?: string }>([
    ["root", {}],
    ["child", { parentID: "root" }],
    ["grandchild", { parentID: "child" }],
  ])
  const getSession = (id: string) => sessions.get(id)

  test("returns the id itself when it has no parent", () => {
    expect(resolveRootID(getSession, "root")).toBe("root")
  })

  test("walks the parent chain to the root", () => {
    expect(resolveRootID(getSession, "grandchild")).toBe("root")
  })

  test("returns undefined for a missing id", () => {
    expect(resolveRootID(getSession, undefined)).toBeUndefined()
  })

  test("stops on a parent cycle without infinite looping", () => {
    const cyclic = new Map<string, { parentID?: string }>([
      ["a", { parentID: "b" }],
      ["b", { parentID: "a" }],
    ])
    expect(resolveRootID((id) => cyclic.get(id), "a")).toBeDefined()
  })
})
