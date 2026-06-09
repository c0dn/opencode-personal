import type { WsClient } from "./index.js"
import { WsFetchMappings } from "./ws-fetch-mappings.js"
import { WsFetchPayload } from "./ws-fetch-payload.js"

/**
 * Options for {@link createWsFetch}.
 *
 * The returned function is a drop-in replacement for `fetch` that the generated
 * SDK client accepts via `config.fetch`. It routes verified REST calls over an
 * existing WS connection and transparently falls back to REST for everything
 * else (not connected, unmapped route, or any WS failure).
 */
export interface WsFetchOptions {
  /** Returns the live WS client, or null while it is connecting / unavailable. */
  getClient: () => WsClient | null
  /** REST transport used for fallback. Must be the unwrapped request fetch. */
  fallback: (req: Request) => Promise<Response>
}

/**
 * Build a fetch-compatible shim that prefers the WS request transport for mapped
 * routes and falls back to REST in every non-happy path.
 */
export function createWsFetch(opts: WsFetchOptions): (req: Request) => Promise<Response> {
  return async (req) => {
    const client = opts.getClient()
    if (!client || client.connectionState !== "connected") return opts.fallback(req)

    const url = new URL(req.url)
    const route = WsFetchMappings.resolve(req.method, url.pathname)
    if (!route) return opts.fallback(req)

    try {
      const body = WsFetchPayload.hasBody(req.method) ? await WsFetchPayload.readJson(req) : undefined
      const payload = route.buildPayload({ params: route.params, query: url.searchParams, body })
      const data = await client.request(route.type, payload)
      if (data === undefined) return opts.fallback(req)
      // Handle paginated WS responses that return { data, cursor }
      if (data && typeof data === "object" && !Array.isArray(data) && "data" in data && "cursor" in data) {
        return WsFetchPayload.jsonResponseWithPagination(data.data as unknown, data.cursor as string | null)
      }
      return WsFetchPayload.jsonResponse(data)
    } catch {
      return opts.fallback(req)
    }
  }
}
