/**
 * Lightweight fuzzy string matching — no external dependencies.
 *
 * Scoring: exact > prefix > substring > subsequence, with a bonus
 * for matching at word/token boundaries.
 */

const TOKEN_SEPARATOR = /[\s\-_.:/\\]+/

/** Collapse whitespace and lowercase. */
function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim()
}

/**
 * Score a query against a candidate string.
 * Higher = better match. Returns 0 for no match at all.
 */
export function fuzzyScore(query: string, candidate: string): number {
  const q = normalize(query)
  const c = normalize(candidate)

  if (q.length === 0) return 1
  if (c.length === 0) return 0

  // exact whole-candidate match
  if (c === q) return c.length * 10

  // prefix match
  if (c.startsWith(q)) return q.length * 5

  // substring match
  const idx = c.indexOf(q)
  if (idx >= 0) return q.length * 3

  // subsequence match — walk candidate looking for each query character in order
  let qi = 0
  let run = 0
  let bestRun = 0
  let score = 0
  for (let ci = 0; ci < c.length && qi < q.length; ci++) {
    if (c[ci] === q[qi]) {
      qi++
      run++
      if (run > bestRun) bestRun = run
    } else {
      run = 0
    }
  }

  if (qi !== q.length) return 0

  // base score: one point per matched character
  score = q.length
  // bonus for consecutive runs
  score += bestRun * 2

  // token-boundary bonus: query char matches start of a token in candidate
  const tokens = c.split(TOKEN_SEPARATOR)
  for (const token of tokens) {
    if (token.length === 0) continue
    // check if query starts matching at the beginning of this token
    let matchCount = 0
    for (let i = 0; i < Math.min(q.length, token.length); i++) {
      if (q[i] === token[i]) matchCount++
      else break
    }
    if (matchCount > 0) score += 2
  }

  return score
}

/**
 * Filter and sort options by fuzzy score against query.
 * Preserves original order for equal scores.
 * Returns all options when query is empty.
 */
export function fuzzyFilter<T extends { title: string; subtitle?: string }>(
  query: string,
  options: T[],
): T[] {
  const q = normalize(query)
  if (q.length === 0) return options.slice()

  const scored = options
    .map((opt) => {
      const titleScore = fuzzyScore(q, opt.title)
      const subtitleScore = opt.subtitle ? fuzzyScore(q, opt.subtitle) : 0
      // title match is weighted higher than subtitle match
      const score = Math.max(titleScore * 2, subtitleScore)
      return { opt, score }
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)

  return scored.map((item) => item.opt)
}
