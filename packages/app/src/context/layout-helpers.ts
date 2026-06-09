import type { Accessor } from "solid-js"

// Boolean open/close/toggle wrapper for a persisted panel slice. Reads current
// state through `read` and writes through `write` so the backing store stays the
// single source of truth (same pattern the review/terminal panels follow).
export function createPanelToggle(read: Accessor<boolean>, write: (next: boolean) => void) {
  return {
    opened: read,
    open() {
      write(true)
    },
    close() {
      write(false)
    },
    toggle() {
      write(!read())
    },
  }
}

export function ensureSessionKey(key: string, touch: (key: string) => void, seed: (key: string) => void) {
  touch(key)
  seed(key)
  return key
}

export function createSessionKeyReader(sessionKey: string | Accessor<string>, ensure: (key: string) => void) {
  const key = typeof sessionKey === "function" ? sessionKey : () => sessionKey
  return () => {
    const value = key()
    ensure(value)
    return value
  }
}

export function pruneSessionKeys(input: {
  keep?: string
  max: number
  used: Map<string, number>
  view: string[]
  tabs: string[]
}) {
  if (!input.keep) return []

  const keys = new Set<string>([...input.view, ...input.tabs])
  if (keys.size <= input.max) return []

  const score = (key: string) => {
    if (key === input.keep) return Number.MAX_SAFE_INTEGER
    return input.used.get(key) ?? 0
  }

  return Array.from(keys)
    .sort((a, b) => score(b) - score(a))
    .slice(input.max)
}
