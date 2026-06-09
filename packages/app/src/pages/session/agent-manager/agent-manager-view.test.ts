import { describe, expect, test } from "bun:test"
import { INDENT_STEP, MAX_INDENT_LEVELS, STATUS_DOT, childSessionPath, indent, showsInterrupt } from "./agent-manager-view"
import type { SubagentStatus } from "./subagent-rows"

describe("indent (depth -> left indent)", () => {
  test("direct children sit at zero indent and each level adds one step", () => {
    expect(indent(1)).toBe(0)
    expect(indent(2)).toBe(INDENT_STEP)
    expect(indent(3)).toBe(2 * INDENT_STEP)
  })

  test("indent increases monotonically with depth", () => {
    for (let depth = 1; depth < MAX_INDENT_LEVELS + 1; depth++) {
      expect(indent(depth + 1)).toBeGreaterThan(indent(depth))
    }
  })

  test("caps deep chains so rows stay on-screen", () => {
    const max = MAX_INDENT_LEVELS * INDENT_STEP
    expect(indent(MAX_INDENT_LEVELS + 1)).toBe(max)
    expect(indent(100)).toBe(max)
  })

  test("clamps non-positive depth to zero", () => {
    expect(indent(0)).toBe(0)
    expect(indent(-5)).toBe(0)
  })
})

describe("status -> pill", () => {
  test("each terminal status maps to a distinct dot color", () => {
    const classes = [STATUS_DOT.idle, STATUS_DOT.completed, STATUS_DOT.error]
    expect(new Set(classes).size).toBe(3)
    for (const cls of classes) expect(cls.length).toBeGreaterThan(0)
  })

  test("running has no dot mapping (it renders a spinner instead)", () => {
    expect((STATUS_DOT as Record<string, string>)["running"]).toBeUndefined()
  })
})

describe("showsInterrupt (busy-only interrupt)", () => {
  test("only busy subagents expose the interrupt control", () => {
    expect(showsInterrupt({ busy: true })).toBe(true)
    expect(showsInterrupt({ busy: false })).toBe(false)
  })
})

describe("childSessionPath (row click navigation target)", () => {
  test("routes to the subagent session within the active directory", () => {
    expect(childSessionPath("d0", "ses_child")).toBe("/d0/session/ses_child")
  })

  test("navigation target is unique per row session id", () => {
    expect(childSessionPath("d0", "ses_a")).not.toBe(childSessionPath("d0", "ses_b"))
  })

  test("mirrors the original template behavior when dir is absent", () => {
    expect(childSessionPath(undefined, "ses_child")).toBe("/undefined/session/ses_child")
  })
})

// Guards that the exhaustive status union still has the two shapes the panel
// renders: "running" (spinner) and the three dot statuses.
test("STATUS_DOT covers every non-running status", () => {
  const statuses: SubagentStatus[] = ["running", "idle", "completed", "error"]
  const nonRunning = statuses.filter((s): s is Exclude<SubagentStatus, "running"> => s !== "running")
  for (const status of nonRunning) expect(STATUS_DOT[status]).toBeDefined()
})
