import { test, expect, describe } from "bun:test"
import {
  estimateCost,
  resolveCost,
  buildPriceLookup,
  type ModelPrice,
  type CostTokens,
} from "@/cli/cmd/tui/stats/pricing"

// ── estimateCost ─────────────────────────────────────────────────────

function tokens(overrides: Partial<CostTokens> = {}): CostTokens {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, ...overrides }
}

function price(overrides: Partial<ModelPrice> = {}): ModelPrice {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...overrides }
}

describe("estimateCost", () => {
  test("charges each token category at its per-million rate", () => {
    // 1M of each category, distinct rates → the dollar cost equals the rate sum.
    const cost = estimateCost(
      tokens({ input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 }),
      price({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }),
    )
    expect(cost).toBeCloseTo(3 + 15 + 0.3 + 3.75, 10)
  })

  test("charges reasoning tokens at the output rate (matches session.ts)", () => {
    const cost = estimateCost(tokens({ reasoning: 1_000_000 }), price({ output: 10 }))
    expect(cost).toBeCloseTo(10, 10)
  })

  test("zero tokens cost nothing", () => {
    expect(estimateCost(tokens(), price({ input: 99, output: 99 }))).toBe(0)
  })
})

// ── resolveCost ──────────────────────────────────────────────────────

describe("resolveCost", () => {
  test("keeps a positive stored cost and ignores tokens/price", () => {
    const cost = resolveCost(1.25, tokens({ input: 9_999_999 }), price({ input: 999 }))
    expect(cost).toBe(1.25)
  })

  test("estimates from tokens × price when stored cost is 0", () => {
    const cost = resolveCost(0, tokens({ input: 2_000_000 }), price({ input: 5 }))
    expect(cost).toBeCloseTo(10, 10)
  })

  test("returns 0 when stored cost is 0 and the model price is unknown", () => {
    expect(resolveCost(0, tokens({ input: 2_000_000, output: 1_000_000 }), undefined)).toBe(0)
  })

  test("never double-counts: a stored cost is never added to an estimate", () => {
    // storedCost > 0 short-circuits, so the (large) token estimate is not added.
    const cost = resolveCost(2, tokens({ output: 1_000_000 }), price({ output: 50 }))
    expect(cost).toBe(2)
  })
})

// ── buildPriceLookup ─────────────────────────────────────────────────

describe("buildPriceLookup", () => {
  const lookup = buildPriceLookup({
    anthropic: { models: { "claude-sonnet-4": { cost: { input: 3, output: 15 } } } },
    openai: { models: { "gpt-5": { cost: { input: 1.25, output: 10, cache_read: 0.125 } } } },
    local: { models: { ollama: {} } },
  })

  test("normalizes a known model and defaults missing cache rates to 0", () => {
    expect(lookup("anthropic", "claude-sonnet-4")).toEqual({
      input: 3,
      output: 15,
      cacheRead: 0,
      cacheWrite: 0,
    })
  })

  test("maps snake_case cache_read to cacheRead", () => {
    expect(lookup("openai", "gpt-5")).toEqual({
      input: 1.25,
      output: 10,
      cacheRead: 0.125,
      cacheWrite: 0,
    })
  })

  test("returns undefined for unknown provider, unknown model, or missing cost", () => {
    expect(lookup("unknown", "x")).toBeUndefined()
    expect(lookup("anthropic", "nope")).toBeUndefined()
    expect(lookup("local", "ollama")).toBeUndefined()
  })
})
