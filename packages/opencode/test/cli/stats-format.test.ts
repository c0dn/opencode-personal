import { test, expect, describe } from "bun:test"
import {
  fmt,
  money,
  cell,
  num,
  clamp,
  relativeTime,
  glyph,
  levelOf,
  weekdayLabel,
  parseDay,
  fmtDay,
  addDays,
  rleRow,
  buildCalendar,
  modelRows,
  providerRows,
  MONTHS,
  type CalRun,
} from "@/cli/cmd/tui/stats/format"
import { cutoffFor } from "@/cli/cmd/tui/stats/types"
import type { DailyActivity, ModelUsageRow } from "@/cli/cmd/tui/stats/types"

// ── fmt ──────────────────────────────────────────────────────────────

describe("fmt", () => {
  test("raw integers below 1000", () => {
    expect(fmt(0)).toBe("0")
    expect(fmt(999)).toBe("999")
  })

  test("thousands with one decimal", () => {
    expect(fmt(1000)).toBe("1.0K")
    expect(fmt(1500)).toBe("1.5K")
  })

  test("millions with one decimal", () => {
    expect(fmt(1_000_000)).toBe("1.0M")
    expect(fmt(2_500_000)).toBe("2.5M")
  })

  test("negative stays raw (below 1000 threshold)", () => {
    expect(fmt(-5)).toBe("-5")
  })
})

// ── money ────────────────────────────────────────────────────────────

describe("money", () => {
  test("two decimal places with leading $", () => {
    expect(money(0)).toBe("$0.00")
    expect(money(3.1)).toBe("$3.10")
    expect(money(182.4)).toBe("$182.40")
  })
})

// ── cell ─────────────────────────────────────────────────────────────

describe("cell", () => {
  test("pads short value to width", () => {
    const out = cell("ab", 5)
    expect(out).toBe("ab   ")
    expect(out.length).toBe(5)
  })

  test("truncates long value with ellipsis and pads to width", () => {
    const out = cell("abcdefghij", 6)
    // inner=5, value>5 → slice(0,4)+"…" = "abcd…", padEnd(6) → "abcd… "
    expect(out).toBe("abcd… ")
    expect(out).toContain("…")
    expect(out.length).toBe(6)
  })

  test("tiny-width quirk: width 1 returns first char + ellipsis (2 chars)", () => {
    // inner=0 → slice(0, max(1,-1))=slice(0,1)="a"+"…"="a…", padEnd(1) leaves it as-is.
    const out = cell("abc", 1)
    expect(out).toBe("a…")
    expect(out.length).toBe(2)
  })
})

// ── num ──────────────────────────────────────────────────────────────

describe("num", () => {
  test("right-pads when shorter than width", () => {
    expect(num("12", 5)).toBe("   12")
  })

  test("slices to first `width` chars when longer", () => {
    expect(num("123456", 4)).toBe("1234")
  })

  test("exact-width passes through", () => {
    expect(num("1234", 4)).toBe("1234")
  })
})

// ── clamp ────────────────────────────────────────────────────────────

describe("clamp", () => {
  test("below low", () => {
    expect(clamp(-1, 0, 10)).toBe(0)
  })
  test("within range", () => {
    expect(clamp(5, 0, 10)).toBe(5)
  })
  test("above high", () => {
    expect(clamp(20, 0, 10)).toBe(10)
  })
})

// ── relativeTime ─────────────────────────────────────────────────────

describe("relativeTime", () => {
  test("just now for ~0 diff", () => {
    expect(relativeTime(Date.now())).toBe("just now")
  })
  test("minutes", () => {
    expect(relativeTime(Date.now() - 5 * 60_000)).toBe("5m ago")
  })
  test("hours", () => {
    expect(relativeTime(Date.now() - 3 * 3_600_000)).toBe("3h ago")
  })
  test("days", () => {
    expect(relativeTime(Date.now() - 2 * 86_400_000)).toBe("2d ago")
  })
  test("months", () => {
    expect(relativeTime(Date.now() - 45 * 86_400_000)).toBe("1mo ago")
  })
  test("years", () => {
    expect(relativeTime(Date.now() - 400 * 86_400_000)).toBe("1y ago")
  })
  test("future timestamp falls into just now (negative diff)", () => {
    expect(relativeTime(Date.now() + 1_000_000)).toBe("just now")
  })
})

// ── glyph ────────────────────────────────────────────────────────────

describe("glyph", () => {
  test("negative level is blank", () => {
    expect(glyph(-1)).toBe(" ")
  })
  test("level 0 is the lowest glyph", () => {
    expect(glyph(0)).toBe("·")
  })
  test("level 4 is the full block", () => {
    expect(glyph(4)).toBe("█")
  })
  test("out-of-range level falls back to lowest glyph", () => {
    expect(glyph(9)).toBe("·")
  })
})

// ── levelOf ──────────────────────────────────────────────────────────

describe("levelOf", () => {
  test("zero and negative are level 0", () => {
    expect(levelOf(0, 100)).toBe(0)
    expect(levelOf(-5, 100)).toBe(0)
  })
  test("full fraction is level 4", () => {
    expect(levelOf(100, 100)).toBe(4)
  })
  test("half is level 3", () => {
    expect(levelOf(50, 100)).toBe(3)
  })
  test("fifth is level 2", () => {
    expect(levelOf(20, 100)).toBe(2)
  })
  test("twentieth is level 1", () => {
    expect(levelOf(5, 100)).toBe(1)
  })
  test("strict > boundaries: exactly 0.66 → 3, 0.33 → 2, 0.1 → 1", () => {
    expect(levelOf(66, 100)).toBe(3)
    expect(levelOf(33, 100)).toBe(2)
    expect(levelOf(10, 100)).toBe(1)
  })
})

// ── weekdayLabel ─────────────────────────────────────────────────────

describe("weekdayLabel", () => {
  test("Mon/Wed/Fri on rows 1/3/5, blank otherwise, always padded to 4", () => {
    expect(weekdayLabel(1)).toBe("Mon ")
    expect(weekdayLabel(3)).toBe("Wed ")
    expect(weekdayLabel(5)).toBe("Fri ")
    expect(weekdayLabel(0)).toBe("    ")
    expect(weekdayLabel(2)).toBe("    ")
    for (let row = 0; row < 7; row++) expect(weekdayLabel(row).length).toBe(4)
  })
})

// ── parseDay / fmtDay / addDays ──────────────────────────────────────

describe("parseDay / fmtDay round-trip", () => {
  test("round-trips a YYYY-MM-DD string", () => {
    expect(fmtDay(parseDay("2026-03-07"))).toBe("2026-03-07")
  })

  test("parseDay builds a LOCAL date", () => {
    const d = parseDay("2026-03-07")
    expect(d.getFullYear()).toBe(2026)
    expect(d.getMonth()).toBe(2) // March, zero-based
    expect(d.getDate()).toBe(7)
  })

  test("addDays handles month rollover", () => {
    expect(fmtDay(addDays(parseDay("2026-01-31"), 1))).toBe("2026-02-01")
  })
})

// ── rleRow ───────────────────────────────────────────────────────────

describe("rleRow", () => {
  test("merges adjacent equal levels and run counts sum to weeks", () => {
    const levels = [1, 1, 2, 2, 2]
    const runs = rleRow(5, (column) => levels[column]!)
    expect(runs).toEqual([
      { level: 1, count: 2 },
      { level: 2, count: 3 },
    ])
    const total = runs.reduce((sum, r) => sum + r.count, 0)
    expect(total).toBe(5)
  })
})

// ── buildCalendar ────────────────────────────────────────────────────

function flattenRuns(runs: CalRun[]): number[] {
  const out: number[] = []
  for (const run of runs) for (let i = 0; i < run.count; i++) out.push(run.level)
  return out
}

/** Generate `count` consecutive days ending on `endDay`, tokens from `tokenFn`. */
function genDays(endDay: string, count: number, tokenFn: (index: number, count: number) => number): DailyActivity[] {
  const end = parseDay(endDay)
  return Array.from({ length: count }, (_, i) => ({
    day: fmtDay(addDays(end, -(count - 1 - i))),
    tokens: tokenFn(i, count),
  }))
}

describe("buildCalendar", () => {
  test("empty heatmap returns null", () => {
    expect(buildCalendar([], 30)).toBeNull()
  })

  test("weeks is clamped to [8,53]", () => {
    const heatmap = genDays("2026-03-07", 120, (i) => i)
    // mid: availWidth - gutter(4) lands inside the range
    expect(buildCalendar(heatmap, 30)!.weeks).toBe(26)
    // tiny → clamped up to 8
    expect(buildCalendar(heatmap, 5)!.weeks).toBe(8)
    // huge → clamped down to 53
    expect(buildCalendar(heatmap, 200)!.weeks).toBe(53)
  })

  test("seven weekday rows, each summing to weeks; month row gutter + abbrev", () => {
    const heatmap = genDays("2026-03-07", 120, (i) => i)
    const cal = buildCalendar(heatmap, 30)!
    expect(cal.weeks).toBe(26)
    expect(cal.weekdays).toHaveLength(7)
    for (const row of cal.weekdays) {
      const total = row.runs.reduce((sum, r) => sum + r.count, 0)
      expect(total).toBe(cal.weeks)
    }
    // monthRow starts with the 4-space gutter and contains at least one month abbrev
    expect(cal.monthRow.startsWith("    ")).toBe(true)
    expect(MONTHS.some((m) => cal.monthRow.includes(m))).toBe(true)
  })

  test("most-recent day is included (off-by-one guard): final cell reaches level 4", () => {
    const endDay = "2026-03-07"
    // Only the final day has tokens; max anchors to it so its level is 4.
    const heatmap = genDays(endDay, 56, (i, count) => (i === count - 1 ? 1000 : 0))
    const cal = buildCalendar(heatmap, 12)! // availWidth-4=8 → weeks=8
    expect(cal.weeks).toBe(8)

    // The end day sits in the LAST column at weekday row = its getDay().
    const endRow = parseDay(endDay).getDay()
    const levels = flattenRuns(cal.weekdays[endRow]!.runs)
    expect(levels).toHaveLength(cal.weeks)
    expect(levels[cal.weeks - 1]).toBe(4)
  })
})

// ── modelRows ────────────────────────────────────────────────────────

function model(overrides: Partial<ModelUsageRow> = {}): ModelUsageRow {
  return {
    modelId: "gpt-4",
    providerId: "openai",
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    messageCount: 0,
    ...overrides,
  }
}

describe("modelRows", () => {
  test("tokens = input + output (not reasoning/cache); maps id→name, provider→sub", () => {
    const rows = modelRows([
      model({
        modelId: "claude-3",
        providerId: "anthropic",
        inputTokens: 100,
        outputTokens: 50,
        reasoningTokens: 999,
        cacheRead: 999,
        cacheWrite: 999,
        cost: 1.25,
        messageCount: 7,
      }),
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]!.name).toBe("claude-3")
    expect(rows[0]!.sub).toBe("anthropic")
    expect(rows[0]!.tokens).toBe(150)
    expect(rows[0]!.cost).toBe(1.25)
    expect(rows[0]!.messages).toBe(7)
  })

  test("slices to max 20 rows, preserving input order", () => {
    const input = Array.from({ length: 25 }, (_, i) => model({ modelId: `m${i}` }))
    const rows = modelRows(input)
    expect(rows).toHaveLength(20)
    expect(rows[0]!.name).toBe("m0")
    expect(rows[19]!.name).toBe("m19")
  })
})

// ── providerRows ─────────────────────────────────────────────────────

describe("providerRows", () => {
  test("groups by provider, sums fields, sorts DESC by tokens, pluralizes sub", () => {
    const rows = providerRows([
      model({ providerId: "openai", inputTokens: 100, outputTokens: 100, cost: 1.0, messageCount: 2 }),
      model({ providerId: "openai", inputTokens: 50, outputTokens: 50, cost: 0.5, messageCount: 1 }),
      model({ providerId: "anthropic", inputTokens: 300, outputTokens: 300, cost: 3.0, messageCount: 5 }),
    ])
    expect(rows).toHaveLength(2)

    // anthropic has more tokens (600) → first
    expect(rows[0]!.name).toBe("anthropic")
    expect(rows[0]!.tokens).toBe(600)
    expect(rows[0]!.cost).toBeCloseTo(3.0, 10)
    expect(rows[0]!.messages).toBe(5)
    expect(rows[0]!.sub).toBe("1 model")

    // openai (300 tokens across 2 models) → second
    expect(rows[1]!.name).toBe("openai")
    expect(rows[1]!.tokens).toBe(300)
    expect(rows[1]!.cost).toBeCloseTo(1.5, 10)
    expect(rows[1]!.messages).toBe(3)
    expect(rows[1]!.sub).toBe("2 models")
  })
})

// ── cutoffFor ────────────────────────────────────────────────────────

describe("cutoffFor", () => {
  test("'all' is 0", () => {
    expect(cutoffFor("all")).toBe(0)
  })
  test("'7d' is ~now-7d", () => {
    const expected = Date.now() - 7 * 86_400_000
    expect(Math.abs(cutoffFor("7d") - expected)).toBeLessThan(5_000)
  })
  test("'30d' is ~now-30d", () => {
    const expected = Date.now() - 30 * 86_400_000
    expect(Math.abs(cutoffFor("30d") - expected)).toBeLessThan(5_000)
  })
})
