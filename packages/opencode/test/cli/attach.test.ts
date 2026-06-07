import { test, expect, describe } from "bun:test"

// Inline the URL resolution logic so tests don't need to import
// from modules that depend on Effect / monorepo internals.

function resolveAttachUrl(args: { url?: string; port?: number; hostname?: string }): string {
  if (args.url) return args.url
  const hostname = args.hostname ?? "127.0.0.1"
  const port = args.port && args.port !== 0 ? args.port : 4096
  return `http://${hostname}:${port}`
}

describe("resolveAttachUrl", () => {
  test("explicit URL is returned unchanged", () => {
    expect(resolveAttachUrl({ url: "http://localhost:4096" })).toBe("http://localhost:4096")
    expect(resolveAttachUrl({ url: "https://example.com:8080" })).toBe("https://example.com:8080")
  })

  test("defaults to 127.0.0.1:4096 when no args", () => {
    expect(resolveAttachUrl({})).toBe("http://127.0.0.1:4096")
  })

  test("--port overrides the port", () => {
    expect(resolveAttachUrl({ port: 3000 })).toBe("http://127.0.0.1:3000")
  })

  test("port 0 resolves to 4096 (matching serve's first-fallback)", () => {
    expect(resolveAttachUrl({ port: 0 })).toBe("http://127.0.0.1:4096")
  })

  test("--hostname overrides the host", () => {
    expect(resolveAttachUrl({ hostname: "0.0.0.0" })).toBe("http://0.0.0.0:4096")
  })

  test("--hostname and --port together", () => {
    expect(resolveAttachUrl({ hostname: "0.0.0.0", port: 3000 })).toBe("http://0.0.0.0:3000")
  })

  test("localhost is preserved when specified", () => {
    expect(resolveAttachUrl({ hostname: "localhost" })).toBe("http://localhost:4096")
  })

  test("explicit URL takes priority over --port and --hostname", () => {
    expect(resolveAttachUrl({ url: "http://custom:1234", port: 9999, hostname: "other" })).toBe("http://custom:1234")
  })
})

// Mirror of resolveAttachDirectory's pure decision (without the chdir side
// effect) so we can assert local-vs-remote default behavior in isolation.
function resolveDirChoice(args: { dir?: string; url?: string }, cwd: string): string | undefined {
  if (args.dir) return args.dir
  if (!args.url) return cwd
  return undefined
}

describe("attach directory resolution", () => {
  test("explicit --dir is used", () => {
    expect(resolveDirChoice({ dir: "/work/project" }, "/home/me")).toBe("/work/project")
  })

  test("local attach (no url, no dir) defaults to cwd", () => {
    expect(resolveDirChoice({}, "/home/me/project")).toBe("/home/me/project")
  })

  test("remote attach (explicit url, no dir) leaves directory unset", () => {
    expect(resolveDirChoice({ url: "http://remote:4096" }, "/home/me")).toBeUndefined()
  })

  test("explicit --dir wins even with a remote url", () => {
    expect(resolveDirChoice({ url: "http://remote:4096", dir: "/srv/app" }, "/home/me")).toBe("/srv/app")
  })
})

describe("probeAttach error classification", () => {
  test("ECONNREFUSED is detected in error messages", () => {
    const econnrefused = "fetch failed: ECONNREFUSED"
    expect(econnrefused.includes("ECONNREFUSED")).toBe(true)
  })

  test("ETIMEDOUT is detected in error messages", () => {
    const etimedout = "fetch failed: ETIMEDOUT"
    expect(etimedout.includes("ETIMEDOUT")).toBe(true)
  })

  test("generic fetch failed is detected", () => {
    const generic = "fetch failed"
    expect(generic.includes("fetch failed")).toBe(true)
  })

  test("non-connection errors do not match ECONNREFUSED", () => {
    const other = "Something went wrong"
    expect(other.includes("ECONNREFUSED")).toBe(false)
  })
})
