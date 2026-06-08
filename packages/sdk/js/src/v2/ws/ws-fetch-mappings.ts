/**
 * REST → WS handler mapping table.
 *
 * Each entry calls the same underlying service method as the REST handler and
 * returns an identical JSON shape. The WS runtime resolves per-request
 * directories via InstanceRef (transport.ts), matching REST's instance-context
 * middleware exactly.
 *
 * ## Mapped (30 endpoints)
 *
 * ### Session reads
 * GET /session, /session/{id}, /status, /todo, /children, /diff
 *
 * ### Session mutations
 * POST /session, DELETE /session/{id}, PATCH /session/{id},
 * POST /session/{id}/{fork,abort,init,prompt,command,shell,revert,unrevert,summarize}
 *
 * ### Message mutations
 * DELETE /session/{id}/message/{mid}
 * DELETE /session/{id}/message/{mid}/part/{pid}
 *
 * ### Static/read
 * GET /project, /config, /mcp, /permission, /question
 *
 * ### MCP, Permission, Question mutations
 * POST /mcp/{name}/{connect,disconnect}
 * POST /permission/{id}/respond
 * POST /question/{id}/{reply,reject}
 *
 * ## Intentionally on REST
 *
 * session.promptAsync  — REST 204; WS returns full result (mismatch)
 * session.share/unshare — REST full session; WS { shared: id } (mismatch)
 * session.messages/context — REST adds X-Total/X-Limit headers
 * config.providers     — REST wraps Provider.toPublicInfo(); WS raw
 * vcs.*, lsp.*, formatter.*, command.*, agent.*, skill.* — WS-only, no REST route
 */
import { WsFetchPayload } from "./ws-fetch-payload.js"
import type { WsRouteMapping, BuildPayloadInput } from "./ws-fetch-payload.js"

export type { WsRouteMapping, BuildPayloadInput }

const matchExact = WsFetchPayload.matchExact
const matchPattern = WsFetchPayload.matchPattern
const params = WsFetchPayload.params
const paramsAndBody = WsFetchPayload.paramsAndBody
const body = WsFetchPayload.body
const queryParams = WsFetchPayload.queryParams
const queryInt = WsFetchPayload.queryInt
const withLocation = WsFetchPayload.withLocation

function S(id: string) {
  return matchPattern(`/session/([^/]+)/${id}`, ["sessionID"])
}

export const WS_FETCH_MAPPINGS: readonly WsRouteMapping[] = [
  // Project
  { method: "GET", type: "project.list", match: matchExact("/project"), buildPayload: (i) => withLocation({}, i.query) },

  // Session reads
  { method: "GET", type: "session.list", match: matchExact("/session"), buildPayload: (i) => withLocation(queryParams({ limit: queryInt(i.query, "limit", 50) }, i.query, "directory"), i.query) },
  { method: "GET", type: "session.get", match: matchPattern("/session/([^/]+)", ["sessionID"]), buildPayload: params("sessionID") },
  { method: "GET", type: "session.status", match: S("status"), buildPayload: params("sessionID") },
  { method: "GET", type: "session.todo", match: S("todo"), buildPayload: params("sessionID") },
  { method: "GET", type: "session.children", match: S("children"), buildPayload: params("sessionID") },
  { method: "GET", type: "session.diff", match: S("diff"), buildPayload: params("sessionID") },

  // Session mutations
  { method: "POST",   type: "session.create",    match: matchExact("/session"),                           buildPayload: body },
  { method: "DELETE", type: "session.delete",    match: matchPattern("/session/([^/]+)", ["sessionID"]),    buildPayload: params("sessionID") },
  // session.update deliberately not mapped: WS reads msg.patch (legacy convention);
  // REST sends UpdatePayload inline (title, metadata, permission, time). Fix requires
  // WS handler to accept the REST payload shape + return the full session object.
  { method: "POST",   type: "session.fork",      match: S("fork"),                               buildPayload: paramsAndBody("sessionID") },
  { method: "POST", type: "session.abort", match: S("abort"), buildPayload: params("sessionID") },
  { method: "POST", type: "session.init", match: S("init"), buildPayload: params("sessionID") },
  { method: "POST", type: "session.prompt", match: S("prompt"), buildPayload: paramsAndBody("sessionID") },
  { method: "POST", type: "session.command", match: S("command"), buildPayload: paramsAndBody("sessionID") },
  { method: "POST", type: "session.shell", match: S("shell"), buildPayload: paramsAndBody("sessionID") },
  { method: "POST", type: "session.revert", match: S("revert"), buildPayload: paramsAndBody("sessionID") },
  { method: "POST", type: "session.unrevert", match: S("unrevert"), buildPayload: params("sessionID") },
  { method: "POST", type: "session.summarize", match: S("summarize"), buildPayload: paramsAndBody("sessionID") },

  // Messages
  { method: "DELETE", type: "message.delete", match: matchPattern("/session/([^/]+)/message/([^/]+)", ["sessionID", "messageID"]), buildPayload: (i) => withLocation({ sessionID: i.params.sessionID, messageID: i.params.messageID }, i.query) },
  { method: "DELETE", type: "message.part.delete", match: matchPattern("/session/([^/]+)/message/([^/]+)/part/([^/]+)", ["sessionID", "messageID", "partID"]), buildPayload: (i) => withLocation({ sessionID: i.params.sessionID, messageID: i.params.messageID, partID: i.params.partID }, i.query) },

  // Config
  { method: "GET", type: "config.get", match: matchExact("/config"), buildPayload: (i) => withLocation({}, i.query) },

  // MCP
  { method: "GET", type: "mcp.status", match: matchExact("/mcp"), buildPayload: (i) => withLocation({}, i.query) },
  { method: "POST", type: "mcp.connect", match: matchPattern("/mcp/([^/]+)/connect", ["name"]), buildPayload: params("name") },
  { method: "POST", type: "mcp.disconnect", match: matchPattern("/mcp/([^/]+)/disconnect", ["name"]), buildPayload: params("name") },

  // Permission
  { method: "GET", type: "permission.list", match: matchExact("/permission"), buildPayload: (i) => withLocation({}, i.query) },
  { method: "POST", type: "permission.reply", match: matchPattern("/permission/([^/]+)/respond", ["requestID"]), buildPayload: paramsAndBody("requestID") },

  // Question
  { method: "GET", type: "question.list", match: matchExact("/question"), buildPayload: (i) => withLocation({}, i.query) },
  { method: "POST", type: "question.reply", match: matchPattern("/question/([^/]+)/reply", ["requestID"]), buildPayload: paramsAndBody("requestID") },
  { method: "POST", type: "question.reject", match: matchPattern("/question/([^/]+)/reject", ["requestID"]), buildPayload: params("requestID") },
]

interface ResolvedRoute {
  type: string
  params: Record<string, string>
  buildPayload: (input: BuildPayloadInput) => Record<string, unknown>
}

export function resolve(method: string, pathname: string): ResolvedRoute | null {
  for (const mapping of WS_FETCH_MAPPINGS) {
    if (mapping.method !== method) continue
    const p = mapping.match(pathname)
    if (p) return { type: mapping.type, params: p, buildPayload: mapping.buildPayload }
  }
  return null
}

export * as WsFetchMappings from "./ws-fetch-mappings"
