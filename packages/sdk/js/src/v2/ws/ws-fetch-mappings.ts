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
 * GET /session, /session/{id}, /status, /todo, /children, /diff, /message
 *
 * ### Session mutations
 * POST /session, DELETE /session/{id},
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
 * ## Intentionally on REST (6)
 *
 * session.update        — WS reads msg.patch (legacy payload convention)
 * session.share/unshare — REST returns full session; WS returns { shared: id }
 * session.promptAsync   — REST returns 204 No Content; WS is synchronous
 * session.context       — pagination header issue
 * config.providers      — REST wraps Provider.toPublicInfo(); WS is raw
 * WS-only handlers      — vcs.*, lsp.*, formatter.*, command.*, agent.*, skill.*
 */
import { WsFetchPayload } from "./ws-fetch-payload.js"
import type { WsRouteMapping, BuildPayloadInput } from "./ws-fetch-payload.js"

export type { WsRouteMapping, BuildPayloadInput }

// Short aliases for the table entries — the full function name verbatim at every
// call site would push each row to 3+ lines and make the table unscanable.
const exact = WsFetchPayload.matchExact
const route = WsFetchPayload.matchPattern
const path = WsFetchPayload.params
const pathAndBody = WsFetchPayload.paramsAndBody
const bodyOnly = WsFetchPayload.body
const location = WsFetchPayload.withLocation

/** Match `GET /session/{id}/{action}` — the most common REST pattern. */
function sessionRoute(action: string) {
  return route(`/session/([^/]+)/${action}`, ["sessionID"])
}

export const WS_FETCH_MAPPINGS: readonly WsRouteMapping[] = [
  // ═══════ Project ═══════
  { method: "GET", type: "project.list", match: exact("/project"), buildPayload: (i) => location({}, i.query) },

  // ═══════ Session reads ═══════
  { method: "GET", type: "session.list", match: exact("/session"), buildPayload: (i) => location({ limit: WsFetchPayload.queryInt(i.query, "limit", 50), directory: i.query.get("directory") ?? undefined }, i.query) },
  { method: "GET", type: "session.get",      match: route("/session/([^/]+)", ["sessionID"]), buildPayload: path("sessionID") },
  { method: "GET", type: "session.status",   match: sessionRoute("status"),                   buildPayload: path("sessionID") },
  { method: "GET", type: "session.todo",     match: sessionRoute("todo"),                     buildPayload: path("sessionID") },
  { method: "GET", type: "session.children", match: sessionRoute("children"),                 buildPayload: path("sessionID") },
  { method: "GET", type: "session.diff",     match: sessionRoute("diff"),                     buildPayload: path("sessionID") },
  { method: "GET", type: "session.messages", match: sessionRoute("message"),                  buildPayload: (i) => location({ sessionID: i.params.sessionID, limit: WsFetchPayload.queryInt(i.query, "limit", 45), before: i.query.get("before") ?? undefined, knownIDs: i.query.get("knownIDs") ?? undefined }, i.query) },

  // ═══════ Session mutations ═══════
  { method: "POST",   type: "session.create",  match: exact("/session"),                          buildPayload: bodyOnly },
  { method: "DELETE", type: "session.delete",  match: route("/session/([^/]+)", ["sessionID"]), buildPayload: path("sessionID") },
  { method: "POST",   type: "session.fork",    match: sessionRoute("fork"),                       buildPayload: pathAndBody("sessionID") },
  { method: "POST",   type: "session.abort",   match: sessionRoute("abort"),                      buildPayload: path("sessionID") },
  { method: "POST",   type: "session.init",    match: sessionRoute("init"),                       buildPayload: path("sessionID") },
  { method: "POST",   type: "session.prompt",  match: sessionRoute("prompt"),                     buildPayload: pathAndBody("sessionID") },
  { method: "POST",   type: "session.command", match: sessionRoute("command"),                    buildPayload: pathAndBody("sessionID") },
  { method: "POST",   type: "session.shell",   match: sessionRoute("shell"),                      buildPayload: pathAndBody("sessionID") },
  { method: "POST",   type: "session.revert",  match: sessionRoute("revert"),                     buildPayload: pathAndBody("sessionID") },
  { method: "POST",   type: "session.unrevert", match: sessionRoute("unrevert"),                  buildPayload: path("sessionID") },
  { method: "POST",   type: "session.summarize", match: sessionRoute("summarize"),                buildPayload: pathAndBody("sessionID") },

  // ═══════ Message mutations ═══════
  { method: "DELETE", type: "message.delete", match: route("/session/([^/]+)/message/([^/]+)", ["sessionID", "messageID"]), buildPayload: (i) => location({ sessionID: i.params.sessionID, messageID: i.params.messageID }, i.query) },
  { method: "DELETE", type: "message.part.delete", match: route("/session/([^/]+)/message/([^/]+)/part/([^/]+)", ["sessionID", "messageID", "partID"]), buildPayload: (i) => location({ sessionID: i.params.sessionID, messageID: i.params.messageID, partID: i.params.partID }, i.query) },

  // ═══════ Config ═══════
  { method: "GET", type: "config.get", match: exact("/config"), buildPayload: (i) => location({}, i.query) },

  // ═══════ MCP ═══════
  { method: "GET",  type: "mcp.status",     match: exact("/mcp"),                               buildPayload: (i) => location({}, i.query) },
  { method: "POST", type: "mcp.connect",    match: route("/mcp/([^/]+)/connect", ["name"]),    buildPayload: path("name") },
  { method: "POST", type: "mcp.disconnect", match: route("/mcp/([^/]+)/disconnect", ["name"]), buildPayload: path("name") },

  // ═══════ Permission ═══════
  { method: "GET",  type: "permission.list",  match: exact("/permission"),                               buildPayload: (i) => location({}, i.query) },
  { method: "POST", type: "permission.reply", match: route("/permission/([^/]+)/respond", ["requestID"]), buildPayload: pathAndBody("requestID") },
  { method: "POST", type: "permission.reply", match: route("/permission/([^/]+)/reply", ["requestID"]),  buildPayload: pathAndBody("requestID") },
  { method: "POST", type: "permission.respond", match: route("/session/([^/]+)/permissions/([^/]+)", ["sessionID", "permissionID"]), buildPayload: pathAndBody("sessionID", "permissionID") },

  // ═══════ Question ═══════
  { method: "GET",  type: "question.list",   match: exact("/question"),                               buildPayload: (i) => location({}, i.query) },
  { method: "POST", type: "question.reply",  match: route("/question/([^/]+)/reply", ["requestID"]), buildPayload: pathAndBody("requestID") },
  { method: "POST", type: "question.reject", match: route("/question/([^/]+)/reject", ["requestID"]), buildPayload: path("requestID") },
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

export * as WsFetchMappings from "./ws-fetch-mappings.js"
