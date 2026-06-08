import { Effect } from "effect"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { MCP } from "@/mcp"
import { Command } from "@/command"
import { Agent } from "@/agent/agent"
import { Skill } from "@/skill"
import { LSP } from "@/lsp/lsp"
import { Format } from "@/format"
import { Vcs } from "@/project/vcs"
import { Permission } from "@/permission"
import { Question } from "@/question"
import type { Connection } from "./connection"
import { WsMultiplex } from "./multiplex"

export function registerRemaining(): void {
  // Commands, agents, skills, LSP, formatters
  WsMultiplex.register("command.list", handleCommandList)
  WsMultiplex.register("agent.list", handleAgentList)
  WsMultiplex.register("skill.list", handleSkillList)
  WsMultiplex.register("lsp.status", handleLspStatus)
  WsMultiplex.register("formatter.status", handleFormatterStatus)

  // VCS
  WsMultiplex.register("vcs.status", handleVcsStatus)
  WsMultiplex.register("vcs.diff", handleVcsDiff)
  WsMultiplex.register("vcs.apply", handleVcsApply)

  // Permissions
  WsMultiplex.register("permission.list", handlePermissionList)
  WsMultiplex.register("permission.reply", handlePermissionReply)
  WsMultiplex.register("permission.respond", handlePermissionRespond)

  // Questions
  WsMultiplex.register("question.list", handleQuestionList)
  WsMultiplex.register("question.reply", handleQuestionReply)
  WsMultiplex.register("question.reject", handleQuestionReject)

  // MCP mutations
  WsMultiplex.register("mcp.connect", handleMcpConnect)
  WsMultiplex.register("mcp.disconnect", handleMcpDisconnect)

  // Session extras
  WsMultiplex.register("session.children", handleSessionChildren)
  WsMultiplex.register("session.diff", handleSessionDiff)
  WsMultiplex.register("session.context", handleSessionContext)
}

// ---- Commands, agents, skills, LSP, formatters ----

function handleCommandList(_msg: Record<string, unknown>, _conn: Connection) {
  return Effect.gen(function* () {
    const cmd = yield* Command.Service
    return yield* cmd.list()
  })
}

function handleAgentList(_msg: Record<string, unknown>, _conn: Connection) {
  return Effect.gen(function* () {
    const agent = yield* Agent.Service
    return yield* agent.list()
  })
}

function handleSkillList(_msg: Record<string, unknown>, _conn: Connection) {
  return Effect.gen(function* () {
    const skill = yield* Skill.Service
    return yield* skill.all()
  })
}

function handleLspStatus(_msg: Record<string, unknown>, _conn: Connection) {
  return Effect.gen(function* () {
    const lsp = yield* LSP.Service
    return yield* lsp.status()
  })
}

function handleFormatterStatus(_msg: Record<string, unknown>, _conn: Connection) {
  return Effect.gen(function* () {
    const fmt = yield* Format.Service
    return yield* fmt.status()
  })
}

// ---- VCS ----

function handleVcsStatus(_msg: Record<string, unknown>, _conn: Connection) {
  return Effect.gen(function* () {
    const vcs = yield* Vcs.Service
    return yield* vcs.status()
  })
}

function handleVcsDiff(msg: Record<string, unknown>, _conn: Connection) {
  return Effect.gen(function* () {
    const vcs = yield* Vcs.Service
    const raw = msg.raw === true
    if (raw) return yield* vcs.diffRaw()
    return yield* vcs.diff("branch")
  })
}

function handleVcsApply(msg: Record<string, unknown>, _conn: Connection) {
  return Effect.gen(function* () {
    const vcs = yield* Vcs.Service
    const patch = typeof msg.patch === "string" ? msg.patch : ""
    if (!patch) return { error: "Missing patch" }
    return yield* vcs.apply(patch as any)
  })
}

// ---- Permissions ----

function handlePermissionList(_msg: Record<string, unknown>, _conn: Connection) {
  return Effect.gen(function* () {
    const perm = yield* Permission.Service
    return yield* perm.list()
  })
}

function handlePermissionReply(msg: Record<string, unknown>, _conn: Connection) {
  return Effect.gen(function* () {
    const perm = yield* Permission.Service
    const requestID = typeof msg.requestID === "string" ? msg.requestID : undefined
    if (!requestID) return { error: "Missing requestID" }
    const result = yield* perm.reply({ requestID: requestID as any, reply: msg.reply as any ?? "approve" }).pipe(
      Effect.map(() => ({ replied: requestID })),
      Effect.catchTag("Permission.NotFoundError", (e) => Effect.succeed({ error: `Permission request not found: ${e.requestID}` })),
    )
    return result
  })
}

function handlePermissionRespond(msg: Record<string, unknown>, _conn: Connection) {
  return Effect.gen(function* () {
    const perm = yield* Permission.Service
    const sessionID = typeof msg.sessionID === "string" ? msg.sessionID : undefined
    const permissionID = typeof msg.permissionID === "string" ? msg.permissionID : undefined
    if (!sessionID) return { error: "Missing sessionID" }
    if (!permissionID) return { error: "Missing permissionID" }
    const result = yield* perm.reply({ requestID: permissionID as any, reply: (msg.response as any) ?? "approve" }).pipe(
      Effect.map(() => ({ replied: permissionID })),
      Effect.catchTag("Permission.NotFoundError", (e) => Effect.succeed({ error: `Permission request not found: ${e.requestID}` })),
    )
    return result
  })
}

// ---- Questions ----

function handleQuestionList(_msg: Record<string, unknown>, _conn: Connection) {
  return Effect.gen(function* () {
    const q = yield* Question.Service
    return yield* q.list()
  })
}

function handleQuestionReply(msg: Record<string, unknown>, _conn: Connection) {
  return Effect.gen(function* () {
    const q = yield* Question.Service
    const requestID = typeof msg.requestID === "string" ? msg.requestID : undefined
    if (!requestID) return { error: "Missing requestID" }
    yield* q.reply({ requestID: requestID as any, answers: msg.answers as any ?? [] }) as Effect.Effect<any>
    return { replied: requestID }
  })
}

function handleQuestionReject(msg: Record<string, unknown>, _conn: Connection) {
  return Effect.gen(function* () {
    const q = yield* Question.Service
    const requestID = typeof msg.requestID === "string" ? msg.requestID : undefined
    if (!requestID) return { error: "Missing requestID" }
    yield* q.reject(requestID as any) as Effect.Effect<any>
    return { rejected: requestID }
  })
}

// ---- MCP mutations ----

function handleMcpConnect(msg: Record<string, unknown>, _conn: Connection) {
  return Effect.gen(function* () {
    const mcp = yield* MCP.Service
    const name = typeof msg.name === "string" ? msg.name : undefined
    if (!name) return { error: "Missing name" }
    yield* mcp.connect(name) as Effect.Effect<any>
    return { connected: name }
  })
}

function handleMcpDisconnect(msg: Record<string, unknown>, _conn: Connection) {
  return Effect.gen(function* () {
    const mcp = yield* MCP.Service
    const name = typeof msg.name === "string" ? msg.name : undefined
    if (!name) return { error: "Missing name" }
    yield* mcp.disconnect(name) as Effect.Effect<any>
    return { disconnected: name }
  })
}

// ---- Session extras ----

function handleSessionChildren(msg: Record<string, unknown>, _conn: Connection) {
  return Effect.gen(function* () {
    const sessionID = typeof msg.sessionID === "string" ? msg.sessionID : undefined
    if (!sessionID) return { error: "Missing sessionID" }
    const sessions = yield* Session.Service
    return yield* sessions.children(sessionID as SessionID)
  })
}

function handleSessionDiff(msg: Record<string, unknown>, _conn: Connection) {
  return Effect.gen(function* () {
    const sessionID = typeof msg.sessionID === "string" ? msg.sessionID : undefined
    if (!sessionID) return { error: "Missing sessionID" }
    const sessions = yield* Session.Service
    return yield* sessions.diff(sessionID as SessionID)
  })
}

function handleSessionContext(msg: Record<string, unknown>, _conn: Connection) {
  return Effect.gen(function* () {
    const sessionID = typeof msg.sessionID === "string" ? msg.sessionID : undefined
    if (!sessionID) return { error: "Missing sessionID" }
    const sessions = yield* Session.Service
    // Context returns the messages after last compaction
    const result = yield* sessions.messages({ sessionID: sessionID as SessionID, limit: 50 })
    return result
  })
}
