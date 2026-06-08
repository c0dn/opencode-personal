/**
 * Payload builders, URL matchers, and fetch-compatible Response synthesis.
 *
 * These helpers produce the WS handler payload from a parsed REST request
 * (path params, query params, JSON body). They are referenced by the mapping
 * table in ws-fetch-mappings.ts and the core shim in ws-fetch.ts.
 */
export interface BuildPayloadInput {
  params: Record<string, string>
  query: URLSearchParams
  body: Record<string, unknown> | undefined
}

export interface WsRouteMapping {
  method: string
  type: string
  match: (pathname: string) => Record<string, string> | null
  buildPayload: (input: BuildPayloadInput) => Record<string, unknown>
}

// ═══════════════════════════════════════════════════════════════════════════
// URL matchers
// ═══════════════════════════════════════════════════════════════════════════

export function matchExact(pathname: string): (candidate: string) => Record<string, string> | null {
  return (candidate) => (candidate === pathname ? {} : null)
}

export function matchPattern(pattern: string, keys: string[]): (candidate: string) => Record<string, string> | null {
  const re = new RegExp(`^${pattern}$`)
  return (candidate) => {
    const result = re.exec(candidate)
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

// ═══════════════════════════════════════════════════════════════════════════
// Payload builders
// ═══════════════════════════════════════════════════════════════════════════

/** Copy directory/workspace from the request query into the payload. */
export function withLocation(payload: Record<string, unknown>, query: URLSearchParams): Record<string, unknown> {
  const directory = query.get("directory")
  const workspace = query.get("workspace")
  if (directory) payload.directory = directory
  if (workspace) payload.workspace = workspace
  return payload
}

/** Build a payload with named path params + location. */
export function params(...keys: string[]): (input: BuildPayloadInput) => Record<string, unknown> {
  return (input) => {
    const payload: Record<string, unknown> = {}
    for (const key of keys) payload[key] = input.params[key]
    return withLocation(payload, input.query)
  }
}

/** Spread the JSON body into named path params + location. */
export function paramsAndBody(
  ...keys: string[]
): (input: BuildPayloadInput) => Record<string, unknown> {
  return (input) => {
    const payload: Record<string, unknown> = input.body ? { ...input.body } : {}
    for (const key of keys) payload[key] = input.params[key]
    return withLocation(payload, input.query)
  }
}

/** Build payload from body + location (no path params). */
export function body(input: BuildPayloadInput): Record<string, unknown> {
  const payload: Record<string, unknown> = input.body ? { ...input.body } : {}
  return withLocation(payload, input.query)
}

/** Copy named query params from the URL into the payload. */
export function queryParams(payload: Record<string, unknown>, query: URLSearchParams, ...keys: string[]): Record<string, unknown> {
  for (const key of keys) {
    const value = query.get(key)
    if (value !== null) payload[key] = value
  }
  return payload
}

/** Read an integer query param with a fallback default. */
export function queryInt(query: URLSearchParams, key: string, fallback: number): number {
  const raw = query.get(key)
  if (raw === null) return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

// ═══════════════════════════════════════════════════════════════════════════
// Fetch utilities
// ═══════════════════════════════════════════════════════════════════════════

export function hasBody(method: string): boolean {
  return method !== "GET" && method !== "HEAD"
}

/** Parse the JSON body from a clone so the original request stays usable for REST fallback. */
export async function readJson(req: Request): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed = await req.clone().json()
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>
    return undefined
  } catch {
    return undefined
  }
}

export function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

export * as WsFetchPayload from "./ws-fetch-payload"
