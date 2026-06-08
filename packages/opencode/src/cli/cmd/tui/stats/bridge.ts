/**
 * Bridge between the Effect query layer and the SolidJS TUI.
 *
 * The parent process writes a StatsCache (all ranges precomputed) to a JSON
 * file and sets OPENCODE_STATS_CACHE. The TUI component reads it on mount and
 * switches between the cached ranges locally.
 */

import { readFile } from "fs/promises"
import type { StatsCache } from "./types"

let cached: StatsCache | null = null
let loaded = false

/** Returns the loaded cache, or null if not yet loaded. */
export function getStatsCache(): StatsCache | null {
  return cached
}

/** Called from the TUI plugin on mount to load the cached ranges from file. */
export function loadStatsCache(): Promise<StatsCache | null> {
  if (loaded) return Promise.resolve(cached)

  const path = process.env.OPENCODE_STATS_CACHE
  if (!path) {
    loaded = true
    return Promise.resolve(null)
  }

  return readFile(path, "utf-8")
    .then((json) => {
      cached = JSON.parse(json) as StatsCache
      loaded = true
      return cached
    })
    .catch(() => {
      loaded = true
      return null
    })
}

/** Clear cached data. */
export function clearStatsData() {
  cached = null
  loaded = false
}
