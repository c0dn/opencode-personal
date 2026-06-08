import { describe, expect, test } from "bun:test"
import { createWsFetch } from "../../src/v2/ws/ws-fetch.ts"
import { WS_FETCH_MAPPINGS } from "../../src/v2/ws/ws-fetch-mappings.ts"
import type { WsClient } from "../../src/v2/ws/index.ts"

interface FakeWsOptions {
  state?: string
  request?: (type: string, payload: Record<string, unknown>) => Promise<unknown>
}

function fakeClient(opts: FakeWsOptions = {}) {
  const calls: { type: string; payload: Record<string, unknown> }[] = []
  const client = {
    get connectionState() {
      return opts.state ?? "connected"
    },
    request(type: string, payload: Record<string, unknown> = {}) {
      calls.push({ type, payload })
      if (opts.request) return opts.request(type, payload)
      return Promise.resolve({ ok: true })
    },
  }
  return { client: client as unknown as WsClient, calls }
}

function fakeFallback() {
  const calls: Request[] = []
  const response = new Response("REST", { status: 299 })
  const fallback = (req: Request) => {
    calls.push(req)
    return Promise.resolve(response.clone())
  }
  return { fallback, calls, sentinelStatus: 299 }
}

const req = (method: string, url: string, init?: RequestInit) =>
  new Request(`http://localhost${url}`, { method, ...init })

const makeFetch = (ws: ReturnType<typeof fakeClient>, fb: ReturnType<typeof fakeFallback>) =>
  createWsFetch({ getClient: () => ws.client, fallback: fb.fallback })

// ---- Mapping resolution tests ----

describe("createWsFetch — mapping resolution", () => {
  test("maps GET /session/{id} with path param + query location", async () => {
    const ws = fakeClient({ request: async () => ({ id: "ses_123", title: "hi" }) })
    const fb = fakeFallback()
    const f = makeFetch(ws, fb)

    const res = await f(req("GET", "/session/ses_123?directory=/foo&workspace=ws1"))

    expect(fb.calls).toHaveLength(0)
    expect(ws.calls).toEqual([
      { type: "session.get", payload: { sessionID: "ses_123", directory: "/foo", workspace: "ws1" } },
    ])
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("application/json")
    expect(await res.json()).toEqual({ id: "ses_123", title: "hi" })
  })

  test("maps GET /project with query location only", async () => {
    const ws = fakeClient({ request: async () => [{ id: "p1" }] })
    const fb = fakeFallback()
    const f = makeFetch(ws, fb)

    const res = await f(req("GET", "/project?directory=/foo"))

    expect(fb.calls).toHaveLength(0)
    expect(ws.calls).toEqual([{ type: "project.list", payload: { directory: "/foo" } }])
    expect(await res.json()).toEqual([{ id: "p1" }])
  })

  test("maps GET /session to session.list with directory and limit", async () => {
    const ws = fakeClient()
    const fb = fakeFallback()
    const f = makeFetch(ws, fb)

    await f(req("GET", "/session?directory=/foo&limit=25"))

    expect(fb.calls).toHaveLength(0)
    expect(ws.calls).toEqual([
      { type: "session.list", payload: { directory: "/foo", limit: 25 } },
    ])
  })

  test("maps GET /session with default limit when absent", async () => {
    const ws = fakeClient()
    const fb = fakeFallback()
    const f = makeFetch(ws, fb)

    await f(req("GET", "/session?directory=/foo"))

    expect(ws.calls).toEqual([
      { type: "session.list", payload: { directory: "/foo", limit: 50 } },
    ])
  })

  test("maps GET /session/{id}/status", async () => {
    const ws = fakeClient()
    const fb = fakeFallback()
    const f = makeFetch(ws, fb)

    await f(req("GET", "/session/ses_456/status"))

    expect(fb.calls).toHaveLength(0)
    expect(ws.calls).toEqual([
      { type: "session.status", payload: { sessionID: "ses_456" } },
    ])
  })

  test("maps GET /session/{id}/todo", async () => {
    const ws = fakeClient()
    const fb = fakeFallback()
    const f = makeFetch(ws, fb)

    await f(req("GET", "/session/ses_456/todo"))

    expect(ws.calls).toEqual([
      { type: "session.todo", payload: { sessionID: "ses_456" } },
    ])
  })

  test("maps GET /session/{id}/children", async () => {
    const ws = fakeClient()
    const fb = fakeFallback()
    const f = makeFetch(ws, fb)

    await f(req("GET", "/session/ses_456/children"))

    expect(ws.calls).toEqual([
      { type: "session.children", payload: { sessionID: "ses_456" } },
    ])
  })

  test("maps GET /session/{id}/diff", async () => {
    const ws = fakeClient()
    const fb = fakeFallback()
    const f = makeFetch(ws, fb)

    await f(req("GET", "/session/ses_456/diff"))

    expect(ws.calls).toEqual([
      { type: "session.diff", payload: { sessionID: "ses_456" } },
    ])
  })

  test("maps GET /config to config.get with location", async () => {
    const ws = fakeClient({ request: async () => ({ foo: "bar" }) })
    const fb = fakeFallback()
    const f = makeFetch(ws, fb)

    const res = await f(req("GET", "/config?directory=/proj"))

    expect(fb.calls).toHaveLength(0)
    expect(ws.calls).toEqual([
      { type: "config.get", payload: { directory: "/proj" } },
    ])
    expect(await res.json()).toEqual({ foo: "bar" })
  })

  test("maps GET /mcp to mcp.status", async () => {
    const ws = fakeClient()
    const fb = fakeFallback()
    const f = makeFetch(ws, fb)

    await f(req("GET", "/mcp?directory=/proj"))

    expect(ws.calls).toEqual([
      { type: "mcp.status", payload: { directory: "/proj" } },
    ])
  })

  test("maps GET /permission to permission.list", async () => {
    const ws = fakeClient()
    const fb = fakeFallback()
    const f = makeFetch(ws, fb)

    await f(req("GET", "/permission?directory=/proj"))

    expect(ws.calls).toEqual([
      { type: "permission.list", payload: { directory: "/proj" } },
    ])
  })

  test("maps GET /question to question.list", async () => {
    const ws = fakeClient()
    const fb = fakeFallback()
    const f = makeFetch(ws, fb)

    await f(req("GET", "/question?directory=/proj"))

    expect(ws.calls).toEqual([
      { type: "question.list", payload: { directory: "/proj" } },
    ])
  })

  test("decodes encoded path params", async () => {
    const ws = fakeClient({ request: async () => ({}) })
    const fb = fakeFallback()
    const f = makeFetch(ws, fb)

    await f(req("GET", "/session/ses%20123"))

    expect(ws.calls[0]?.payload).toEqual({ sessionID: "ses 123" })
  })

  test("omits absent location params from payload", async () => {
    const ws = fakeClient({ request: async () => ({}) })
    const fb = fakeFallback()
    const f = makeFetch(ws, fb)

    await f(req("GET", "/session/ses_123"))

    expect(ws.calls[0]?.payload).toEqual({ sessionID: "ses_123" })
  })
})

// ---- Fallback path tests ----

describe("createWsFetch — fallback paths", () => {
  test("falls back when client is disconnected", async () => {
    const ws = fakeClient({ state: "disconnected" })
    const fb = fakeFallback()
    const f = makeFetch(ws, fb)

    const res = await f(req("GET", "/project"))

    expect(fb.calls).toHaveLength(1)
    expect(ws.calls).toHaveLength(0)
    expect(res.status).toBe(fb.sentinelStatus)
  })

  test("falls back when client is null", async () => {
    const fb = fakeFallback()
    const f = createWsFetch({ getClient: () => null, fallback: fb.fallback })

    const res = await f(req("GET", "/project"))

    expect(fb.calls).toHaveLength(1)
    expect(res.status).toBe(fb.sentinelStatus)
  })

  test("falls back when client is not connected", async () => {
    const ws = fakeClient({ state: "connecting" })
    const fb = fakeFallback()
    const f = makeFetch(ws, fb)

    const res = await f(req("GET", "/project"))

    expect(fb.calls).toHaveLength(1)
    expect(ws.calls).toHaveLength(0)
    expect(res.status).toBe(fb.sentinelStatus)
  })

  test("falls back for an unmapped route", async () => {
    const ws = fakeClient()
    const fb = fakeFallback()
    const f = makeFetch(ws, fb)

    const res = await f(req("GET", "/some-unmapped-route"))

    expect(fb.calls).toHaveLength(1)
    expect(ws.calls).toHaveLength(0)
    expect(res.status).toBe(fb.sentinelStatus)
  })

  test("falls back for config.providers (shape mismatch)", async () => {
    const ws = fakeClient()
    const fb = fakeFallback()
    const f = makeFetch(ws, fb)

    const res = await f(req("GET", "/config/providers"))

    expect(fb.calls).toHaveLength(1)
    expect(ws.calls).toHaveLength(0)
    expect(res.status).toBe(fb.sentinelStatus)
  })

  test("falls back for session.messages (pagination header mismatch)", async () => {
    const ws = fakeClient()
    const fb = fakeFallback()
    const f = makeFetch(ws, fb)

    const res = await f(req("GET", "/session/ses_123/messages"))

    expect(fb.calls).toHaveLength(1)
    expect(ws.calls).toHaveLength(0)
    expect(res.status).toBe(fb.sentinelStatus)
  })

  test("falls back when method does not match a mapping", async () => {
    const ws = fakeClient()
    const fb = fakeFallback()
    const f = makeFetch(ws, fb)

    const res = await f(req("POST", "/session/ses_123", { body: "{}" }))

    expect(fb.calls).toHaveLength(1)
    expect(ws.calls).toHaveLength(0)
    expect(res.status).toBe(fb.sentinelStatus)
  })

  test("falls back (and preserves request body) when ws.request rejects", async () => {
    const ws = fakeClient({ request: async () => Promise.reject(new Error("ws timeout")) })
    const fb = fakeFallback()
    const f = makeFetch(ws, fb)

    const res = await f(req("GET", "/session/ses_123"))

    expect(ws.calls).toHaveLength(1)
    expect(fb.calls).toHaveLength(1)
    expect(res.status).toBe(fb.sentinelStatus)
  })

  test("falls back when the handler returns undefined data", async () => {
    const ws = fakeClient({ request: async () => undefined })
    const fb = fakeFallback()
    const f = makeFetch(ws, fb)

    const res = await f(req("GET", "/project"))

    expect(ws.calls).toHaveLength(1)
    expect(fb.calls).toHaveLength(1)
    expect(res.status).toBe(fb.sentinelStatus)
  })

  test("does not consume the original request body (clone used for parsing)", async () => {
    const ws = fakeClient()
    const fb = fakeFallback()
    const f = makeFetch(ws, fb)

    const original = req("POST", "/session/ses_123", { body: JSON.stringify({ a: 1 }) })
    await f(original)

    expect(fb.calls).toHaveLength(1)
    expect(fb.calls[0]?.bodyUsed).toBe(false)
    expect(await fb.calls[0]?.json()).toEqual({ a: 1 })
  })
})
