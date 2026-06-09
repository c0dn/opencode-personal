import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { Agent } from "@/agent/agent"
import { Truncate } from "@/tool/truncate"
import { NotFoundError } from "@/storage/storage"
import { SubagentListTool } from "@/tool/subagent-list"
import { testEffect } from "../lib/effect"

// --- helpers ---

function makeInfo(overrides: { id: SessionID; parentID?: SessionID; title?: string; agent?: string }): Session.Info {
  return {
    id: overrides.id,
    slug: "slug-" + overrides.id.slice(0, 8),
    projectID: "prj_test" as Session.Info["projectID"],
    directory: "/tmp/test",
    parentID: overrides.parentID,
    title: overrides.title ?? "Session " + overrides.id,
    agent: overrides.agent ?? "opencode",
    model: {
      id: "gpt-4" as Session.Info["model"]["id"],
      providerID: "openai" as Session.Info["model"]["providerID"],
    },
    version: "1.0.0",
    time: { created: 1, updated: 1 },
  }
}

function makeCtx(sessionID: SessionID) {
  return {
    sessionID,
    messageID: "msg_01" as Session.Info["id"],
    agent: "opencode",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
}

function fakeSession(handlers: {
  get: Session.Interface["get"]
  children?: Session.Interface["children"]
}): Session.Interface {
  // Compute descendants from children (BFS) for tests
  const descendants: Session.Interface["descendants"] = (rootID) =>
    Effect.gen(function* () {
      const result: { session: Session.Info; depth: number }[] = []
      const queue: { parentID: SessionID; depth: number }[] = [{ parentID: rootID, depth: 0 }]
      while (queue.length > 0) {
        const curr = queue.shift()!
        const kids = yield* children(curr.parentID)
        for (const kid of kids) {
          result.push({ session: kid, depth: curr.depth + 1 })
          queue.push({ parentID: kid.id, depth: curr.depth + 1 })
        }
      }
      return result
    })

  const depthFromRoot: Session.Interface["depthFromRoot"] = (sessionID) =>
    Effect.gen(function* () {
      let depth = 0
      let currentID: string | undefined = sessionID
      while (currentID) {
        const info = yield* handlers.get(SessionID.make(currentID))
        currentID = info.parentID
        if (currentID) depth++
      }
      return depth
    })

  const children = handlers.children ?? (() => Effect.succeed([]))

  return {
    // always-ack stubs for the rest of the interface
    list: () => Effect.succeed([]),
    listGlobal: () => Effect.succeed([]),
    create: () => Effect.succeed(makeInfo({ id: SessionID.make("ses_new") })),
    fork: () => Effect.succeed(makeInfo({ id: SessionID.make("ses_new") })),
    touch: () => Effect.void,
    get: handlers.get,
    setTitle: () => Effect.void,
    setArchived: () => Effect.void,
    setMetadata: () => Effect.void,
    setPermission: () => Effect.void,
    setRevert: () => Effect.void,
    clearRevert: () => Effect.void,
    setSummary: () => Effect.void,
    setShare: () => Effect.void,
    setWorkspace: () => Effect.void,
    diff: () => Effect.succeed([]),
    messages: () => Effect.succeed([]),
    children,
    descendants,
    depthFromRoot,
    remove: () => Effect.void,
    updateMessage: <T>(msg: T) => Effect.succeed(msg),
    removeMessage: () => Effect.succeed("msg_01" as Session.Info["id"]),
    removePart: () => Effect.succeed("prt_01" as Session.Info["id"]),
    getPart: () => Effect.succeed(undefined),
    updatePart: <T>(part: T) => Effect.succeed(part),
    updatePartDelta: () => Effect.void,
    findMessage: () => Effect.fail(new NotFoundError({ message: "not found" })),
  }
}

function statusLayer() {
  return Layer.succeed(SessionStatus.Service, SessionStatus.Service.of({
    get: () => Effect.succeed({ type: "idle" as const }),
    list: () => Effect.succeed(new Map<SessionID, SessionStatus.Info>()),
    set: () => Effect.void,
  }))
}

function truncateLayer() {
  return Layer.succeed(Truncate.Service, Truncate.Service.of({
    cleanup: () => Effect.void,
    write: (input: any) => Effect.succeed(input),
    output: (_text: string, _opts: any, _agent: any) =>
      Effect.succeed({ content: _text, truncated: false }),
    limits: () => Effect.succeed({}),
  }))
}

function agentLayer() {
  return Layer.succeed(Agent.Service, Agent.Service.of({
    defaultInfo: () =>
      Effect.succeed({
        name: "opencode",
        description: "",
        model: { providerID: "openai", modelID: "gpt-4" },
        permission: null,
        mode: "primary" as const,
        hidden: false,
        topP: null,
        temperature: null,
        color: null,
        instructions: null,
        tools: null,
        mcp: null,
      } satisfies Agent.Info),
    defaultAgent: () => Effect.succeed("opencode"),
    get: () =>
      Effect.succeed({
        name: "opencode",
        description: "",
        model: { providerID: "openai", modelID: "gpt-4" },
        permission: null,
        mode: "primary" as const,
        hidden: false,
        topP: null,
        temperature: null,
        color: null,
        instructions: null,
        tools: null,
        mcp: null,
      } satisfies Agent.Info),
    list: () => Effect.succeed([]),
  }))
}

function baseLayer() {
  return Layer.mergeAll(truncateLayer(), agentLayer(), statusLayer())
}

// --- scene layers ---

function rootOnlyLayer() {
  const rootID = SessionID.make("ses_root")
  const root = makeInfo({ id: rootID, title: "Root Session" })
  return Layer.mergeAll(
    Layer.succeed(Session.Service, Session.Service.of(fakeSession({
      get: (id: SessionID) =>
        id === rootID ? Effect.succeed(root) : Effect.fail(new NotFoundError({ message: "not found" })),
    }))),
    baseLayer(),
  )
}

function rootWithChildLayer() {
  const rootID = SessionID.make("ses_root")
  const childID = SessionID.make("ses_child")
  const root = makeInfo({ id: rootID, title: "Root" })
  const child = makeInfo({ id: childID, parentID: rootID, title: "Child", agent: "build" })
  return Layer.mergeAll(
    Layer.succeed(Session.Service, Session.Service.of(fakeSession({
      get: (id: SessionID) => {
        if (id === rootID) return Effect.succeed(root)
        if (id === childID) return Effect.succeed(child)
        return Effect.fail(new Session.NotFoundError({ message: "not found" }))
      },
      children: (parentID: SessionID) => parentID === rootID ? Effect.succeed([child]) : Effect.succeed([]),
    }))),
    baseLayer(),
  )
}

function siblingLayer() {
  const rootID = SessionID.make("ses_root")
  const callerID = SessionID.make("ses_child_a")
  const siblingID = SessionID.make("ses_child_b")
  const root = makeInfo({ id: rootID, title: "Root" })
  const caller = makeInfo({ id: callerID, parentID: rootID, title: "Child A", agent: "build" })
  const sibling = makeInfo({ id: siblingID, parentID: rootID, title: "Child B", agent: "build" })
  return Layer.mergeAll(
    Layer.succeed(Session.Service, Session.Service.of(fakeSession({
      get: (id: SessionID) => {
        if (id === rootID) return Effect.succeed(root)
        if (id === callerID) return Effect.succeed(caller)
        if (id === siblingID) return Effect.succeed(sibling)
        return Effect.fail(new Session.NotFoundError({ message: "not found" }))
      },
      children: (parentID: SessionID) => parentID === rootID ? Effect.succeed([caller, sibling]) : Effect.succeed([]),
    }))),
    baseLayer(),
  )
}

function grandchildLayer() {
  const rootID = SessionID.make("ses_root")
  const childID = SessionID.make("ses_child")
  const grandchildID = SessionID.make("ses_grandchild")
  const root = makeInfo({ id: rootID, title: "Root" })
  const child = makeInfo({ id: childID, parentID: rootID, title: "Child", agent: "build" })
  const grandchild = makeInfo({ id: grandchildID, parentID: childID, title: "Grandchild", agent: "build" })
  return Layer.mergeAll(
    Layer.succeed(Session.Service, Session.Service.of(fakeSession({
      get: (id: SessionID) => {
        if (id === rootID) return Effect.succeed(root)
        if (id === childID) return Effect.succeed(child)
        if (id === grandchildID) return Effect.succeed(grandchild)
        return Effect.fail(new Session.NotFoundError({ message: "not found" }))
      },
      children: (parentID: SessionID) => {
        if (parentID === rootID) return Effect.succeed([child])
        if (parentID === childID) return Effect.succeed([grandchild])
        return Effect.succeed([])
      },
    }))),
    baseLayer(),
  )
}

describe("subagent_list", () => {
  const rootTest = testEffect(rootOnlyLayer())
  const rootWithChildTest = testEffect(rootWithChildLayer())
  const siblingTest = testEffect(siblingLayer())
  const grandchildTest = testEffect(grandchildLayer())

  rootTest.effect("root-only: labels root as self, counts 1 session", () =>
    Effect.gen(function* () {
      const toolInfo = yield* SubagentListTool
      const tool = yield* toolInfo.init()
      const rootID = SessionID.make("ses_root")
      const result = yield* tool.execute({}, makeCtx(rootID))
      const parsed = JSON.parse(result.output)
      expect(parsed.sessions).toBeArrayOfSize(1)
      expect(parsed.sessions[0].id).toBe(rootID)
      expect(parsed.sessions[0].relationship).toBe("self")
      expect(result.metadata.count).toBe(1)
      expect(result.metadata.root_id).toBe(rootID)
    }),
  )

  rootWithChildTest.effect("root-with-child: labels root as self, child as child", () =>
    Effect.gen(function* () {
      const toolInfo = yield* SubagentListTool
      const tool = yield* toolInfo.init()
      const rootID = SessionID.make("ses_root")
      const childID = SessionID.make("ses_child")
      const result = yield* tool.execute({}, makeCtx(rootID))
      const parsed = JSON.parse(result.output)
      expect(parsed.sessions).toBeArrayOfSize(2)
      const root = parsed.sessions.find((s: any) => s.id === rootID)
      const child = parsed.sessions.find((s: any) => s.id === childID)
      expect(root.relationship).toBe("self")
      expect(child.relationship).toBe("child")
    }),
  )

  siblingTest.effect("child session: labels parent, self, and sibling correctly", () =>
    Effect.gen(function* () {
      const toolInfo = yield* SubagentListTool
      const tool = yield* toolInfo.init()
      const rootID = SessionID.make("ses_root")
      const callerID = SessionID.make("ses_child_a")
      const siblingID = SessionID.make("ses_child_b")
      const result = yield* tool.execute({}, makeCtx(callerID))
      const parsed = JSON.parse(result.output)
      expect(parsed.sessions).toBeArrayOfSize(3)
      const self = parsed.sessions.find((s: any) => s.id === callerID)
      const parent = parsed.sessions.find((s: any) => s.id === rootID)
      const sibling = parsed.sessions.find((s: any) => s.id === siblingID)
      expect(self.relationship).toBe("self")
      expect(parent.relationship).toBe("parent")
      expect(sibling.relationship).toBe("sibling")
      expect(result.metadata.count).toBe(3)
      expect(result.metadata.root_id).toBe(rootID)
      expect(result.metadata.caller_id).toBe(callerID)
    }),
  )

  grandchildTest.effect("grandchild: walks to root and sees full tree", () =>
    Effect.gen(function* () {
      const toolInfo = yield* SubagentListTool
      const tool = yield* toolInfo.init()
      const rootID = SessionID.make("ses_root")
      const childID = SessionID.make("ses_child")
      const grandchildID = SessionID.make("ses_grandchild")
      const result = yield* tool.execute({}, makeCtx(grandchildID))
      const parsed = JSON.parse(result.output)

      // Full tree: root (ancestor), parent, self
      expect(parsed.sessions).toBeArrayOfSize(3)
      const root = parsed.sessions.find((s: any) => s.id === rootID)
      const parent = parsed.sessions.find((s: any) => s.id === childID)
      const self = parsed.sessions.find((s: any) => s.id === grandchildID)

      expect(root.relationship).toBe("ancestor")
      expect(root.depth).toBe(0)
      expect(parent.relationship).toBe("parent")
      expect(parent.depth).toBe(1)
      expect(self.relationship).toBe("self")
      expect(self.depth).toBe(2)
      expect(result.metadata.root_id).toBe(rootID)
    }),
  )

  siblingTest.effect("includes agent and status in output", () =>
    Effect.gen(function* () {
      const toolInfo = yield* SubagentListTool
      const tool = yield* toolInfo.init()
      const result = yield* tool.execute({}, makeCtx(SessionID.make("ses_child_a")))
      const parsed = JSON.parse(result.output)
      for (const s of parsed.sessions) {
        expect(s.agent).toBeDefined()
        expect(s.status).toBeDefined()
        expect(s.title).toBeDefined()
      }
    }),
  )
})
