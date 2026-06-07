import { test, expect, describe } from "bun:test"

// ── spawnOpencode mode detection ─────────────────────────────────────

/**
 * Determine whether the current process was launched as a script (bun/node + entry)
 * or as a compiled binary. Used by spawnOpencode to construct the correct argv.
 */
function isScriptMode(): boolean {
  return (
    process.execPath.includes("bun") ||
    process.execPath.includes("node")
  )
}

function buildSpawnArgs(args: string[]): { cmd: string; args: string[] } {
  if (isScriptMode()) {
    return { cmd: process.argv[0], args: [process.argv[1], ...args] }
  }
  return { cmd: process.execPath, args }
}

describe("spawnOpencode mode detection", () => {
  test("isScriptMode returns boolean", () => {
    const result = isScriptMode()
    expect(typeof result).toBe("boolean")
  })

  test("buildSpawnArgs returns cmd and args", () => {
    const { cmd, args } = buildSpawnArgs(["-s", "ses_test123"])
    expect(typeof cmd).toBe("string")
    expect(Array.isArray(args)).toBe(true)
  })

  test("buildSpawnArgs includes the -s flag and session ID", () => {
    const { args } = buildSpawnArgs(["-s", "ses_test123"])
    const idx = args.indexOf("-s")
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(args[idx + 1]).toBe("ses_test123")
  })
})

// ── session ID validation ────────────────────────────────────────────

describe("session ID validation", () => {
  test("valid session ID starts with 'ses'", () => {
    expect("ses_abc123".startsWith("ses")).toBe(true)
    expect("ses_".startsWith("ses")).toBe(true)
  })

  test("invalid session IDs do not start with 'ses'", () => {
    expect("abc123".startsWith("ses")).toBe(false)
    expect("sess_123".startsWith("ses")).toBe(true) // "sess" starts with "ses"
    expect("SES_123".startsWith("ses")).toBe(false) // case-sensitive
  })
})

// ── pick option conversion ───────────────────────────────────────────

interface TestSession {
  id: string
  title: string
  directory: string
  project?: { name?: string; worktree?: string } | null
  time: { updated: number }
}

function toPickOptions(sessions: TestSession[]): Array<{
  id: string
  title: string
  subtitle?: string
  detail: string
}> {
  return sessions.map((s) => ({
    id: s.id,
    title: s.title,
    subtitle: s.project?.name ?? s.project?.worktree ?? undefined,
    detail: new Date(s.time.updated).toLocaleString(),
  }))
}

describe("toPickOptions", () => {
  test("converts session to pick option with project name", () => {
    const sessions: TestSession[] = [
      {
        id: "ses_abc",
        title: "Fix login button",
        directory: "/home/user/projects/my-project",
        project: { name: "my-project", worktree: "/home/user/projects/my-project" },
        time: { updated: 1715000000000 },
      },
    ]
    const options = toPickOptions(sessions)
    expect(options).toHaveLength(1)
    expect(options[0]!.id).toBe("ses_abc")
    expect(options[0]!.title).toBe("Fix login button")
    expect(options[0]!.subtitle).toBe("my-project")
  })

  test("falls back to worktree when project name is missing", () => {
    const sessions: TestSession[] = [
      {
        id: "ses_def",
        title: "Refactor DB",
        directory: "/home/user/projects/backend",
        project: { worktree: "/home/user/projects/backend" },
        time: { updated: 1715000000000 },
      },
    ]
    const options = toPickOptions(sessions)
    expect(options[0]!.subtitle).toBe("/home/user/projects/backend")
  })

  test("handles null project", () => {
    const sessions: TestSession[] = [
      {
        id: "ses_ghi",
        title: "Orphan session",
        directory: "/tmp",
        project: null,
        time: { updated: 1715000000000 },
      },
    ]
    const options = toPickOptions(sessions)
    expect(options[0]!.subtitle).toBeUndefined()
  })
})
