/**
 * Bridge between the Effect query layer and the SolidJS TUI.
 *
 * The parent process writes StatsData to a JSON file and sets
 * OPENCODE_STATS_CACHE env var. The TUI component reads it on mount.
 */

import { readFile } from "fs/promises"
import type { StatsData } from "./types"

let cached: StatsData | null = null
let loaded = false

/** Called from the TUI component on mount. Returns null if not yet loaded. */
export function getStatsData(): StatsData | null {
  return cached
}

/** Called from the TUI plugin on mount to load cached data from file. */
export function loadStatsCache(): Promise<StatsData | null> {
  if (loaded) return Promise.resolve(cached)

  const path = process.env.OPENCODE_STATS_CACHE
  if (!path) {
    loaded = true
    return Promise.resolve(null)
  }

  return readFile(path, "utf-8")
    .then((json) => {
      cached = JSON.parse(json) as StatsData
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
