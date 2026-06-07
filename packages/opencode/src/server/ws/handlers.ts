import { Effect } from "effect"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { Todo } from "@/session/todo"
import { MCP } from "@/mcp"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { Project } from "@/project/project"
import { SessionPrompt } from "@/session/prompt"
import { SessionRevert } from "@/session/revert"
import { SessionSummary } from "@/session/summary"
import { SessionShare } from "@/share/session"
import type { Connection } from "./connection"
import { WsMultiplex } from "./multiplex"

/**
 * Register all WS message handlers.
 */
export function registerAll(): void {
  WsMultiplex.register("ping", handlePing)

  // Session read
  WsMultiplex.register("session.list", handleSessionList)
  WsMultiplex.register("session.get", handleSessionGet)
  WsMultiplex.register("session.messages", handleSessionMessages)
  WsMultiplex.register("session.status", handleSessionStatus)
  WsMultiplex.register("session.todo", handleSessionTodo)

  // Session mutations (all require idempotencyID)
  WsMultiplex.register("session.create", handleSessionCreate)
  WsMultiplex.register("session.delete", handleSessionDelete)
  WsMultiplex.register("session.update", handleSessionUpdate)
  WsMultiplex.register("session.fork", handleSessionFork)
  WsMultiplex.register("session.share", handleSessionShare)
  WsMultiplex.register("session.unshare", handleSessionUnshare)
  WsMultiplex.register("session.summarize", handleSessionSummarize)
  WsMultiplex.register("session.revert", handleSessionRevert)
  WsMultiplex.register("session.unrevert", handleSessionUnrevert)
  WsMultiplex.register("session.abort", handleSessionAbort)
  WsMultiplex.register("session.init", handleSessionInit)
  WsMultiplex.register("session.prompt", handleSessionPrompt)
  WsMultiplex.register("session.command", handleSessionCommand)
  WsMultiplex.register("session.shell", handleSessionShell)

  // Message mutations
  WsMultiplex.register("message.delete", handleMessageDelete)
  WsMultiplex.register("message.part.delete", handleMessagePartDelete)

  // Pre-fetch subscribe/unsubscribe
  WsMultiplex.register("session.subscribe", handleSessionSubscribe)
  WsMultiplex.register("session.unsubscribe", handleSessionUnsubscribe)

  // MCP
  WsMultiplex.register("mcp.status", handleMcpStatus)

  // Config
  WsMultiplex.register("config.get", handleConfigGet)
  WsMultiplex.register("config.providers", handleConfigProviders)

  // Project
  WsMultiplex.register("project.list", handleProjectList)
}

function handlePing(_msg: Record<string, unknown>, conn: Connection): Effect.Effect<void> {
  return conn.push({ type: "pong" })
}

function handleSessionList(msg: Record<string, unknown>, _conn: Connection) {
  return Effect.gen(function* () {
    const sessions = yield* Session.Service
    const directory = typeof msg.directory === "string" ? msg.directory : undefined
    const limit = typeof msg.limit === "number" ? msg.limit : 50
    const result = yield* sessions.list({ directory, limit })
    return result
  })
}

function handleSessionGet(msg: Record<string, unknown>, _conn: Connection) {
  return Effect.gen(function* () {
    const sessionID = typeof msg.sessionID === "string" ? msg.sessionID : undefined
    if (!sessionID) return { error: "Missing sessionID" }
    const sessions = yield* Session.Service
    const result = yield* sessions.get(sessionID as SessionID)
    return result
  })
}

function handleSessionMessages(msg: Record<string, unknown>, _conn: Connection) {
  return Effect.gen(function* () {
    const sessionID = typeof msg.sessionID === "string" ? msg.sessionID : undefined
    if (!sessionID) return { error: "Missing sessionID" }
    const limit = typeof msg.limit === "number" ? msg.limit : 100
    const sessions = yield* Session.Service
    const result = yield* sessions.messages({ sessionID: sessionID as SessionID, limit })
    return result
  })
}

function handleSessionStatus(msg: Record<string, unknown>, _conn: Connection) {
  return Effect.gen(function* () {
    const sessionID = typeof msg.sessionID === "string" ? msg.sessionID : undefined
    if (!sessionID) return { error: "Missing sessionID" }
    const status = yield* SessionStatus.Service
    const result = yield* status.get(sessionID as SessionID)
    return result
  })
}

function handleSessionTodo(msg: Record<string, unknown>, _conn: Connection) {
  return Effect.gen(function* () {
    const sessionID = typeof msg.sessionID === "string" ? msg.sessionID : undefined
    if (!sessionID) return { error: "Missing sessionID" }
    const todo = yield* Todo.Service
    const result = yield* todo.get(sessionID as SessionID)
    return result
  })
}

// ---- Pre-fetch subscribe/unsubscribe ----

function handleSessionSubscribe(msg: Record<string, unknown>, conn: Connection) {
  return Effect.gen(function* () {
    const sessionIDs = Array.isArray(msg.sessionIDs) ? msg.sessionIDs.filter((id): id is string => typeof id === "string") : []
    for (const id of sessionIDs) {
      conn.subscribed.add(id)
    }
    return { subscribed: sessionIDs.length }
  })
}

function handleSessionUnsubscribe(msg: Record<string, unknown>, conn: Connection) {
  return Effect.gen(function* () {
    const sessionIDs = Array.isArray(msg.sessionIDs) ? msg.sessionIDs.filter((id): id is string => typeof id === "string") : []
    for (const id of sessionIDs) {
      conn.subscribed.delete(id)
    }
    return { unsubscribed: sessionIDs.length }
  })
}

// ---- MCP ----

function handleMcpStatus(_msg: Record<string, unknown>, _conn: Connection) {
  return Effect.gen(function* () {
    const mcp = yield* MCP.Service
    return yield* mcp.status()
  })
}

// ---- Config ----

function handleConfigGet(_msg: Record<string, unknown>, _conn: Connection) {
  return Effect.gen(function* () {
    const config = yield* Config.Service
    return yield* config.get()
  })
}

function handleConfigProviders(_msg: Record<string, unknown>, _conn: Connection) {
  return Effect.gen(function* () {
    const provider = yield* Provider.Service
    return yield* provider.list()
  })
}

// ---- Project ----

function handleProjectList(_msg: Record<string, unknown>, _conn: Connection) {
  return Effect.gen(function* () {
    const project = yield* Project.Service
    return yield* project.list()
  })
}

// ---- Session mutations ----

function handleSessionCreate(msg: Record<string, unknown>, _conn: Connection) {
  return Effect.gen(function* () {
    const sessions = yield* Session.Service
    const input: Record<string, unknown> = {}
    if (typeof msg.parentID === "string") input.parentID = msg.parentID as SessionID
    if (typeof msg.title === "string") input.title = msg.title
    if (typeof msg.agent === "string") input.agent = msg.agent
    const result = yield* sessions.create(input as Parameters<typeof sessions.create>[0])
    return result
  })
}

function handleSessionDelete(msg: Record<string, unknown>, _conn: Connection) {
  return Effect.gen(function* () {
    const sessionID = typeof msg.sessionID === "string" ? msg.sessionID : undefined
    if (!sessionID) return { error: "Missing sessionID" }
    const sessions = yield* Session.Service
    yield* sessions.remove(sessionID as SessionID)
    return { deleted: sessionID }
  })
}

function handleSessionUpdate(msg: Record<string, unknown>, _conn: Connection) {
  return Effect.gen(function* () {
    const sessionID = typeof msg.sessionID === "string" ? msg.sessionID : undefined
    if (!sessionID) return { error: "Missing sessionID" }
    const sessions = yield* Session.Service
    const patch = (msg.patch ?? {}) as Record<string, unknown>
    if (typeof patch.title === "string") {
      yield* sessions.setTitle({ sessionID: sessionID as SessionID, title: patch.title })
    }
    const time = patch.time as Record<string, unknown> | undefined
    if (time !== undefined && "archived" in time) {
      yield* sessions.setArchived({ sessionID: sessionID as SessionID, time: typeof time.archived === "number" ? time.archived : undefined })
    }
    return { updated: sessionID }
  })
}

function handleSessionFork(msg: Record<string, unknown>, _conn: Connection) {
  return Effect.gen(function* () {
    const sessionID = typeof msg.sessionID === "string" ? msg.sessionID : undefined
    if (!sessionID) return { error: "Missing sessionID" }
    const sessions = yield* Session.Service
    const messageID = typeof msg.messageID === "string" ? msg.messageID : undefined
    const result = yield* sessions.fork({ sessionID: sessionID as SessionID, messageID: messageID as any })
    return result
  })
}

function handleSessionShare(msg: Record<string, unknown>, _conn: Connection) {
  return Effect.gen(function* () {
    const sessionID = typeof msg.sessionID === "string" ? msg.sessionID : undefined
    if (!sessionID) return { error: "Missing sessionID" }
    const share = yield* SessionShare.Service
    yield* share.share(sessionID as SessionID) as Effect.Effect<any>
    return { shared: sessionID }
  })
}

function handleSessionUnshare(msg: Record<string, unknown>, _conn: Connection) {
  return Effect.gen(function* () {
    const sessionID = typeof msg.sessionID === "string" ? msg.sessionID : undefined
    if (!sessionID) return { error: "Missing sessionID" }
    const share = yield* SessionShare.Service
    yield* share.unshare(sessionID as SessionID) as Effect.Effect<any>
    return { unshared: sessionID }
  })
}

function handleSessionSummarize(msg: Record<string, unknown>, _conn: Connection) {
  return Effect.gen(function* () {
    const sessionID = typeof msg.sessionID === "string" ? msg.sessionID : undefined
    const messageID = typeof msg.messageID === "string" ? msg.messageID : undefined
    if (!sessionID || !messageID) return { error: "Missing sessionID or messageID" }
    const summarySvc = yield* SessionSummary.Service
    yield* summarySvc.summarize({ sessionID: sessionID as SessionID, messageID: messageID as any }) as Effect.Effect<any>
    return { summarized: sessionID }
  })
}

function handleSessionRevert(msg: Record<string, unknown>, _conn: Connection) {
  return Effect.gen(function* () {
    const sessionID = typeof msg.sessionID === "string" ? msg.sessionID : undefined
    const messageID = typeof msg.messageID === "string" ? msg.messageID : undefined
    if (!sessionID || !messageID) return { error: "Missing sessionID or messageID" }
    const revert = yield* SessionRevert.Service
    yield* revert.revert({ sessionID: sessionID as SessionID, messageID: messageID as any }) as Effect.Effect<any>
    return { reverted: sessionID }
  })
}

function handleSessionUnrevert(msg: Record<string, unknown>, _conn: Connection) {
  return Effect.gen(function* () {
    const sessionID = typeof msg.sessionID === "string" ? msg.sessionID : undefined
    if (!sessionID) return { error: "Missing sessionID" }
    const revert = yield* SessionRevert.Service
    yield* revert.unrevert({ sessionID: sessionID as SessionID }) as Effect.Effect<any>
    return { unreverted: sessionID }
  })
}

function handleSessionAbort(msg: Record<string, unknown>, _conn: Connection) {
  return Effect.gen(function* () {
    const sessionID = typeof msg.sessionID === "string" ? msg.sessionID : undefined
    if (!sessionID) return { error: "Missing sessionID" }
    const prompt = yield* SessionPrompt.Service
    yield* prompt.cancel(sessionID as SessionID)
    return { aborted: sessionID }
  })
}

function handleSessionInit(msg: Record<string, unknown>, _conn: Connection) {
  return Effect.gen(function* () {
    const sessionID = typeof msg.sessionID === "string" ? msg.sessionID : undefined
    if (!sessionID) return { error: "Missing sessionID" }
    // Touching the session initializes it
    const sessions = yield* Session.Service
    yield* sessions.touch(sessionID as SessionID)
    return { initialized: sessionID }
  })
}

function handleSessionPrompt(msg: Record<string, unknown>, _conn: Connection) {
  return Effect.gen(function* () {
    const sessionID = typeof msg.sessionID === "string" ? msg.sessionID : undefined
    if (!sessionID) return { error: "Missing sessionID" }
    const prompt = yield* SessionPrompt.Service
    const parts = Array.isArray(msg.parts) ? msg.parts : [{ type: "text", text: typeof msg.text === "string" ? msg.text : "" }]
    const result = yield* prompt.prompt({
      sessionID: sessionID as SessionID,
      parts,
      model: typeof msg.model === "string" ? msg.model : undefined,
      agent: typeof msg.agent === "string" ? msg.agent : undefined,
      noReply: msg.noReply === true,
      messageID: typeof msg.messageID === "string" ? msg.messageID : undefined,
    } as any)
    return result
  })
}

function handleSessionCommand(msg: Record<string, unknown>, _conn: Connection) {
  return Effect.gen(function* () {
    const sessionID = typeof msg.sessionID === "string" ? msg.sessionID : undefined
    if (!sessionID) return { error: "Missing sessionID" }
    const command = typeof msg.command === "string" ? msg.command : ""
    if (!command) return { error: "Missing command" }
    const prompt = yield* SessionPrompt.Service
    const result = yield* prompt.command({
      sessionID: sessionID as SessionID,
      command,
      arguments: typeof msg.arguments === "string" ? msg.arguments : "",
      agent: typeof msg.agent === "string" ? msg.agent : undefined,
      messageID: typeof msg.messageID === "string" ? msg.messageID : undefined,
    } as any)
    return result
  })
}

function handleSessionShell(msg: Record<string, unknown>, _conn: Connection) {
  return Effect.gen(function* () {
    const sessionID = typeof msg.sessionID === "string" ? msg.sessionID : undefined
    if (!sessionID) return { error: "Missing sessionID" }
    const command = typeof msg.command === "string" ? msg.command : ""
    if (!command) return { error: "Missing command" }
    const prompt = yield* SessionPrompt.Service
    const result = yield* prompt.shell({
      sessionID: sessionID as SessionID,
      command,
      agent: typeof msg.agent === "string" ? msg.agent : "opencode",
      messageID: typeof msg.messageID === "string" ? msg.messageID : undefined,
    } as any)
    return result
  })
}

// ---- Message mutations ----

function handleMessageDelete(msg: Record<string, unknown>, _conn: Connection) {
  return Effect.gen(function* () {
    const sessionID = typeof msg.sessionID === "string" ? msg.sessionID : undefined
    const messageID = typeof msg.messageID === "string" ? msg.messageID : undefined
    if (!sessionID || !messageID) return { error: "Missing sessionID or messageID" }
    const sessions = yield* Session.Service
    yield* sessions.removeMessage({ sessionID: sessionID as SessionID, messageID: messageID as any })
    return { deleted: messageID }
  })
}

function handleMessagePartDelete(msg: Record<string, unknown>, _conn: Connection) {
  return Effect.gen(function* () {
    const sessionID = typeof msg.sessionID === "string" ? msg.sessionID : undefined
    const messageID = typeof msg.messageID === "string" ? msg.messageID : undefined
    const partID = typeof msg.partID === "string" ? msg.partID : undefined
    if (!sessionID || !messageID || !partID) return { error: "Missing sessionID, messageID, or partID" }
    const sessions = yield* Session.Service
    yield* sessions.removePart({ sessionID: sessionID as SessionID, messageID: messageID as any, partID: partID as any })
    return { deleted: partID }
  })
}
