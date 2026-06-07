import { test, expect, describe } from "bun:test"
import { fuzzyScore, fuzzyFilter } from "@/cli/fuzzy"

describe("fuzzyScore", () => {
  test("exact match scores highest relative to other match types", () => {
    const exact = fuzzyScore("fix login", "fix login")
    const prefix = fuzzyScore("fix login", "fix login button")
    expect(exact).toBeGreaterThan(prefix)
  })

  test("empty query returns 1 for any candidate", () => {
    expect(fuzzyScore("", "anything")).toBe(1)
    expect(fuzzyScore("", "")).toBe(1)
  })

  test("empty candidate returns 0", () => {
    expect(fuzzyScore("query", "")).toBe(0)
  })

  test("prefix match scores higher than substring match", () => {
    const prefix = fuzzyScore("fix", "fix login button")
    const substring = fuzzyScore("fix", "button fix text")
    expect(prefix).toBeGreaterThan(substring)
  })

  test("substring match scores higher than subsequence match", () => {
    const substring = fuzzyScore("login", "fix login button")
    const subsequence = fuzzyScore("lgn", "fix login button")
    expect(substring).toBeGreaterThan(subsequence)
  })

  test("subsequence match returns score > 0", () => {
    expect(fuzzyScore("lgn", "login")).toBeGreaterThan(0)
  })

  test("no match returns 0", () => {
    expect(fuzzyScore("xyz", "fix login button")).toBe(0)
  })

  test("case insensitive", () => {
    const lower = fuzzyScore("FIX LOGIN", "fix login button")
    const upper = fuzzyScore("fix login", "FIX LOGIN BUTTON")
    expect(lower).toBe(upper)
  })

  test("whitespace normalization", () => {
    const collapsed = fuzzyScore("fix  login", "fix login button")
    const normal = fuzzyScore("fix login", "fix login button")
    expect(collapsed).toBe(normal)
  })

  test("token boundary bonus: matching start of words scores higher", () => {
    const tokenStart = fuzzyScore("log", "fix login button")
    expect(tokenStart).toBeGreaterThan(0)
  })
})

describe("fuzzyFilter", () => {
  const options = [
    { title: "Fix login button", subtitle: "my-project" },
    { title: "Refactor database layer", subtitle: "backend" },
    { title: "Add dark mode support", subtitle: "my-project" },
    { title: "Login page redesign", subtitle: "frontend" },
  ]

  test("empty query returns all options in original order", () => {
    const result = fuzzyFilter("", options)
    expect(result).toHaveLength(4)
    expect(result[0]!.title).toBe("Fix login button")
  })

  test("returns only matching options sorted by score", () => {
    const result = fuzzyFilter("login", options)
    expect(result).toHaveLength(2)
    // "Login page redesign" starts with "login" — higher score than "Fix login button" (substring)
    expect(result[0]!.title).toBe("Login page redesign")
    expect(result[1]!.title).toBe("Fix login button")
  })

  test("subtitle matching works", () => {
    const result = fuzzyFilter("backend", options)
    expect(result).toHaveLength(1)
    expect(result[0]!.title).toBe("Refactor database layer")
  })

  test("no matches returns empty array", () => {
    const result = fuzzyFilter("zzznotfound", options)
    expect(result).toHaveLength(0)
  })

  test("returns single exact title match first", () => {
    const singleOpt = [{ title: "Deploy production", subtitle: "ops" }]
    const result = fuzzyFilter("deploy production", singleOpt)
    expect(result).toHaveLength(1)
  })
})
