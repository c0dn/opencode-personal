import type { WsClient } from "./index.js"

/**
 * Options for {@link createWsFetch}.
 *
 * The returned function is a drop-in replacement for `fetch` that the generated
 * SDK client accepts via `config.fetch`. It routes a small, verified set of REST
 * calls over an existing WS connection and transparently falls back to REST for
 * everything else (disabled, not connected, unmapped route, or any WS failure).
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
 * Conservative, verified mapping table. Each entry was confirmed to produce a WS
 * `data` shape identical to the REST JSON body AND to be directory-independent,
 * because the WS handler runtime runs against a single process-global instance.
 *
 * - GET /project        -> project.list (global ProjectTable; no params)
 * - GET /session/{id}   -> session.get  (lookup by global session id)
 *
 * Everything else intentionally stays on REST (see module docs / report).
 */
export const WS_FETCH_MAPPINGS: readonly WsRouteMapping[] = [
  {
    method: "GET",
    type: "project.list",
    match: matchExact("/project"),
    buildPayload: (input) => withLocation({}, input.query),
  },
  {
    method: "GET",
    type: "session.get",
    match: matchPattern(/^\/session\/([^/]+)$/, ["sessionID"]),
    buildPayload: (input) => withLocation({ sessionID: input.params.sessionID }, input.query),
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
