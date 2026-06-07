import { test, expect, describe } from "bun:test"
import { SessionID } from "@/session/schema"

// ── SessionID parsing (tryMakeSessionID equivalent) ───────────────────

function tryMakeSessionID(input: string): SessionID | null {
  try {
    return SessionID.make(input)
  } catch {
    return null
  }
}

describe("tryMakeSessionID", () => {
  test("valid session ID returns a SessionID", () => {
    const result = tryMakeSessionID("ses_abc123")
    expect(result).not.toBeNull()
    expect(result).toBeDefined()
  })

  test("invalid session ID returns null", () => {
    expect(tryMakeSessionID("not-a-session")).toBeNull()
    expect(tryMakeSessionID("")).toBeNull()
    expect(tryMakeSessionID("abc123")).toBeNull()
  })

  test("valid prefix 'ses_' is sufficient", () => {
    // SessionID.make validates the prefix; exact format depends on schema
    const result = tryMakeSessionID("ses_")
    expect(result).not.toBeNull()
  })
})

// ── toPickOptions for GlobalInfo-like sessions ────────────────────────

interface TestGlobalSession {
  id: string
  title: string
  directory: string
  project?: { name?: string; worktree?: string } | null
  time: { updated: number }
}

function toPickOptions(sessions: TestGlobalSession[]): Array<{
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

describe("toPickOptions (delete)", () => {
  test("converts session with project name", () => {
    const sessions: TestGlobalSession[] = [
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

  test("falls back to worktree when name is missing", () => {
    const sessions: TestGlobalSession[] = [
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
    const sessions: TestGlobalSession[] = [
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

// ── Resolution: title matching ────────────────────────────────────────

interface MinimalSession {
  id: string
  title: string
}

/** Simulates the resolution pipeline for unit testing. */
function resolveSingleByTitle(
  sessions: MinimalSession[],
  input: string,
): MinimalSession | null {
  const normalized = input.toLowerCase().trim()

  // Exact case-insensitive title match
  const exactMatches = sessions.filter((s) => s.title.toLowerCase().trim() === normalized)
  if (exactMatches.length === 1) return exactMatches[0]!
  if (exactMatches.length > 1) return null // triggers picker

  // Unique title prefix match
  const prefixMatches = sessions.filter((s) =>
    s.title.toLowerCase().trim().startsWith(normalized),
  )
  if (prefixMatches.length === 1) return prefixMatches[0]!

  return null
}

describe("resolveSingleByTitle", () => {
  const sessions: MinimalSession[] = [
    { id: "ses_01", title: "Fix login button" },
    { id: "ses_02", title: "Login page redesign" },
    { id: "ses_03", title: "Refactor database" },
    { id: "ses_04", title: "Add dark mode" },
  ]

  test("exact match returns single session", () => {
    const result = resolveSingleByTitle(sessions, "Fix login button")
    expect(result).not.toBeNull()
    expect(result!.id).toBe("ses_01")
  })

  test("case-insensitive exact match", () => {
    const result = resolveSingleByTitle(sessions, "FIX LOGIN BUTTON")
    expect(result).not.toBeNull()
    expect(result!.id).toBe("ses_01")
  })

  test("unique prefix match", () => {
    const result = resolveSingleByTitle(sessions, "Refactor")
    expect(result).not.toBeNull()
    expect(result!.id).toBe("ses_03")
  })

  test("ambiguous prefix returns null (picker fallback)", () => {
    // Add Login — only one sessions starts with "Login", and it's unique.
    // But "Fix" would be ambiguous if we had "Fix login button" and "Fix navigation".
    // Use a query that matches multiple as prefix.
    const multiPrefix: MinimalSession[] = [
      { id: "ses_01", title: "Refactor database" },
      { id: "ses_02", title: "Refactor API layer" },
    ]
    const result = resolveSingleByTitle(multiPrefix, "Refactor")
    expect(result).toBeNull()
  })

  test("no match returns null", () => {
    const result = resolveSingleByTitle(sessions, "zzznotfound")
    expect(result).toBeNull()
  })

  test("duplicate titles return null", () => {
    const dupes: MinimalSession[] = [
      { id: "ses_a", title: "Fix bug" },
      { id: "ses_b", title: "Fix bug" },
    ]
    const result = resolveSingleByTitle(dupes, "Fix bug")
    expect(result).toBeNull()
  })
})

// ── ID prefix matching ────────────────────────────────────────────────

function resolveByIDPrefix(sessions: MinimalSession[], input: string): MinimalSession | null {
  const normalized = input.toLowerCase().trim()
  const matches = sessions.filter((s) => s.id.toLowerCase().startsWith(normalized))
  if (matches.length === 1) return matches[0]!
  return null
}

describe("resolveByIDPrefix", () => {
  const sessions: MinimalSession[] = [
    { id: "ses_abc123", title: "First" },
    { id: "ses_abc456", title: "Second" },
    { id: "ses_def789", title: "Third" },
  ]

  test("unique prefix match returns single session", () => {
    const result = resolveByIDPrefix(sessions, "ses_def")
    expect(result).not.toBeNull()
    expect(result!.id).toBe("ses_def789")
  })

  test("ambiguous prefix returns null", () => {
    const result = resolveByIDPrefix(sessions, "ses_abc")
    expect(result).toBeNull()
  })

  test("short prefix that is still unique", () => {
    const result = resolveByIDPrefix(sessions, "ses_d")
    expect(result).not.toBeNull()
    expect(result!.id).toBe("ses_def789")
  })
})

// ── Bulk filtering for multi-select ───────────────────────────────────

function filterSessionsByIDs<T extends { id: string }>(
  sessions: T[],
  selectedIDs: string[],
): T[] {
  return sessions.filter((s) => selectedIDs.includes(s.id))
}

describe("filterSessionsByIDs (multi-select)", () => {
  const sessions: MinimalSession[] = [
    { id: "ses_a", title: "First" },
    { id: "ses_b", title: "Second" },
    { id: "ses_c", title: "Third" },
  ]

  test("returns matching sessions", () => {
    const result = filterSessionsByIDs(sessions, ["ses_a", "ses_c"])
    expect(result).toHaveLength(2)
    expect(result[0]!.id).toBe("ses_a")
    expect(result[1]!.id).toBe("ses_c")
  })

  test("returns empty for no matches", () => {
    const result = filterSessionsByIDs(sessions, ["ses_x"])
    expect(result).toHaveLength(0)
  })

  test("handles empty selection", () => {
    const result = filterSessionsByIDs(sessions, [])
    expect(result).toHaveLength(0)
  })
})
