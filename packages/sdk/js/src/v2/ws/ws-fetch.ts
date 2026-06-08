import type { WsClient } from "./index.js"

/**
 * Options for {@link createWsFetch}.
 *
 * The returned function is a drop-in replacement for `fetch` that the generated
 * SDK client accepts via `config.fetch`. It routes verified REST calls over an
 * existing WS connection and transparently falls back to REST for everything
 * else (disabled, not connected, unmapped route, or any WS failure).
 */
export interface WsFetchOptions {
  /** Returns the live WS client, or null while it is connecting / unavailable. */
  getClient: () => WsClient | null
  /** REST transport used for fallback. Must be the unwrapped request fetch. */
  fallback: (req: Request) => Promise<Response>
  /** Master switch. When false, every call goes straight to {@link fallback}. */
  enabled: () => boolean
}

/**
 * Build a fetch-compatible shim that prefers the WS request transport for mapped
 * routes and falls back to REST in every non-happy path.
 */
export function createWsFetch(opts: WsFetchOptions): (req: Request) => Promise<Response> {
  return async (req) => {
    if (!opts.enabled()) return opts.fallback(req)

    const client = opts.getClient()
    if (!client || client.connectionState !== "connected") return opts.fallback(req)

    const url = new URL(req.url)
    const route = resolveRoute(req.method, url.pathname)
    if (!route) return opts.fallback(req)

    try {
      const body = hasBody(req.method) ? await readJsonBody(req) : undefined
      const payload = route.mapping.buildPayload({ params: route.params, query: url.searchParams, body })
      const data = await client.request(route.mapping.type, payload)
      // A handler that returns nothing is fire-and-forget; let REST own it.
      if (data === undefined) return opts.fallback(req)
      return jsonResponse(data)
    } catch {
      // Any WS error (reject, timeout, send failure) → REST retry. We never
      // surface WS-specific errors; the REST path produces the canonical result.
      return opts.fallback(req)
    }
  }
}

interface BuildPayloadInput {
  params: Record<string, string>
  query: URLSearchParams
  body: Record<string, unknown> | undefined
}

interface WsRouteMapping {
  method: string
  type: string
  match: (pathname: string) => Record<string, string> | null
  buildPayload: (input: BuildPayloadInput) => Record<string, unknown>
}

/**
 * Verified mapping table: REST route → WS handler.
 *
 * Each entry was confirmed to call the same service method as the REST handler
 * and return an identical JSON shape. The WS runtime is now directory-aware
 * (transport.ts resolves per-request InstanceRef), so directory-scoped endpoints
 * like config.get and mcp.status produce correct per-project results.
 *
 * Excluded from mapping (intentional REST fallback):
 * - config.providers  — WS returns raw provider.list(); REST wraps with Provider.toPublicInfo()
 * - session.messages  — REST adds pagination headers; body shape identical but headers differ
 * - All mutations (POST/PATCH/DELETE) — not verified for shape parity yet
 * - TUI/internal-only WS handlers (vcs.*, lsp.*, formatter.*, command.*, agent.*, skill.*)
 */
export const WS_FETCH_MAPPINGS: readonly WsRouteMapping[] = [
  // ---- Project ----
  {
    method: "GET",
    type: "project.list",
    match: matchExact("/project"),
    buildPayload: (input) => withLocation({}, input.query),
  },

  // ---- Session ----
  {
    method: "GET",
    type: "session.list",
    match: matchExact("/session"),
    buildPayload: (input) => withLocation(withQuery({ limit: readInt(input.query, "limit", 50) }, input.query, "directory"), input.query),
  },
  {
    method: "GET",
    type: "session.get",
    match: matchPattern(/^\/session\/([^/]+)$/, ["sessionID"]),
    buildPayload: (input) => withLocation({ sessionID: input.params.sessionID }, input.query),
  },
  {
    method: "GET",
    type: "session.status",
    match: matchPattern(/^\/session\/([^/]+)\/status$/, ["sessionID"]),
    buildPayload: (input) => withLocation({ sessionID: input.params.sessionID }, input.query),
  },
  {
    method: "GET",
    type: "session.todo",
    match: matchPattern(/^\/session\/([^/]+)\/todo$/, ["sessionID"]),
    buildPayload: (input) => withLocation({ sessionID: input.params.sessionID }, input.query),
  },
  {
    method: "GET",
    type: "session.children",
    match: matchPattern(/^\/session\/([^/]+)\/children$/, ["sessionID"]),
    buildPayload: (input) => withLocation({ sessionID: input.params.sessionID }, input.query),
  },
  {
    method: "GET",
    type: "session.diff",
    match: matchPattern(/^\/session\/([^/]+)\/diff$/, ["sessionID"]),
    buildPayload: (input) => withLocation({ sessionID: input.params.sessionID }, input.query),
  },

  // ---- Config ----
  {
    method: "GET",
    type: "config.get",
    match: matchExact("/config"),
    buildPayload: (input) => withLocation({}, input.query),
  },

  // ---- MCP ----
  {
    method: "GET",
    type: "mcp.status",
    match: matchExact("/mcp"),
    buildPayload: (input) => withLocation({}, input.query),
  },

  // ---- Permission ----
  {
    method: "GET",
    type: "permission.list",
    match: matchExact("/permission"),
    buildPayload: (input) => withLocation({}, input.query),
  },

  // ---- Question ----
  {
    method: "GET",
    type: "question.list",
    match: matchExact("/question"),
    buildPayload: (input) => withLocation({}, input.query),
  },
]

function resolveRoute(
  method: string,
  pathname: string,
): { mapping: WsRouteMapping; params: Record<string, string> } | null {
  for (const mapping of WS_FETCH_MAPPINGS) {
    if (mapping.method !== method) continue
    const params = mapping.match(pathname)
    if (params) return { mapping, params }
  }
  return null
}

function matchExact(pathname: string): (candidate: string) => Record<string, string> | null {
  return (candidate) => (candidate === pathname ? {} : null)
}

function matchPattern(pattern: RegExp, keys: string[]): (candidate: string) => Record<string, string> | null {
  return (candidate) => {
    const result = pattern.exec(candidate)
    if (!result) return null
    const params: Record<string, string> = {}
    for (let i = 0; i < keys.length; i++) {
      const value = result[i + 1]
      if (value === undefined) return null
      params[keys[i]] = decodeURIComponent(value)
    }
    return params
  }
}

/** Copy directory/workspace from the request query into the WS payload. */
function withLocation(payload: Record<string, unknown>, query: URLSearchParams): Record<string, unknown> {
  const directory = query.get("directory")
  const workspace = query.get("workspace")
  if (directory) payload.directory = directory
  if (workspace) payload.workspace = workspace
  return payload
}

/** Copy named query params from the URL into the payload. */
function withQuery(payload: Record<string, unknown>, query: URLSearchParams, ...keys: string[]): Record<string, unknown> {
  for (const key of keys) {
    const value = query.get(key)
    if (value !== null) payload[key] = value
  }
  return payload
}

/** Read an integer query param with a fallback default. */
function readInt(query: URLSearchParams, key: string, fallback: number): number {
  const raw = query.get(key)
  if (raw === null) return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function hasBody(method: string): boolean {
  return method !== "GET" && method !== "HEAD"
}

/** Parse the JSON body from a clone so the original request stays usable for REST fallback. */
async function readJsonBody(req: Request): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed = await req.clone().json()
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>
    return undefined
  } catch {
    return undefined
  }
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}
