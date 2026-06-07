import { test, expect, describe } from "bun:test"
import { join } from "path"
import { ResumeCommand } from "@/cli/cmd/resume"
import { AttachCommand } from "@/cli/cmd/tui/attach"
import { SessionDeleteCommand } from "@/cli/cmd/session"
import { StatsCommand } from "@/cli/cmd/stats"

/**
 * Revert guard for this branch's new CLI features. If an upstream merge silently
 * drops a command, an alias, or a registration wire, one of these assertions
 * fails in CI. Command shapes are checked against the REAL command objects;
 * registration is checked against source text since `src/index.ts` and the TUI
 * plugin wiring run heavy side effects on import.
 */

function aliasList(aliases: string | readonly string[] | undefined): string[] {
  if (!aliases) return []
  return Array.isArray(aliases) ? [...aliases] : [aliases as string]
}

// ── Command shape (real objects) ─────────────────────────────────────

describe("ResumeCommand", () => {
  test("command name is 'resume' and aliases include 'r'", () => {
    expect(ResumeCommand.command).toBe("resume [session]")
    expect(aliasList(ResumeCommand.aliases)).toContain("r")
  })
})

describe("AttachCommand", () => {
  test("aliases include 'a'", () => {
    expect(AttachCommand.command).toBe("attach [url]")
    expect(aliasList(AttachCommand.aliases)).toContain("a")
  })
})

describe("SessionDeleteCommand", () => {
  test("aliases include 'rm', 'del', and 'remove'", () => {
    expect(SessionDeleteCommand.command).toBe("delete [sessionID]")
    const aliases = aliasList(SessionDeleteCommand.aliases)
    expect(aliases).toContain("rm")
    expect(aliases).toContain("del")
    expect(aliases).toContain("remove")
  })
})

describe("StatsCommand", () => {
  test("command name is 'stats'", () => {
    expect(StatsCommand.command).toBe("stats")
  })
})

// ── Registration guards (source text) ────────────────────────────────

const SRC = join(import.meta.dir, "..", "..", "src")

async function readSrc(...parts: string[]): Promise<string> {
  return Bun.file(join(SRC, ...parts)).text()
}

describe("src/index.ts registration", () => {
  test("imports and registers ResumeCommand, AttachCommand, StatsCommand", async () => {
    const index = await readSrc("index.ts")
    for (const name of ["ResumeCommand", "AttachCommand", "StatsCommand"]) {
      expect(index).toContain(`import { ${name} }`)
      expect(index).toContain(`.command(${name})`)
    }
  })
})

describe("internal TUI plugins", () => {
  test("internal.ts wires StatsPlugin", async () => {
    const internal = await readSrc("cli", "cmd", "tui", "plugin", "internal.ts")
    expect(internal).toContain("StatsPlugin")
  })
})

describe("stats plugin route", () => {
  test("plugin.tsx registers the 'stats' route", async () => {
    const plugin = await readSrc("cli", "cmd", "tui", "stats", "plugin.tsx")
    expect(plugin).toContain(`const route = "stats"`)
  })
})
