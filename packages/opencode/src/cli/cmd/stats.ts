import { spawn } from "child_process"
import { Effect } from "effect"
import { writeFile, mkdir } from "fs/promises"
import path from "path"
import { effectCmd, fail } from "../effect-cmd"
import { loadStats } from "./tui/stats/repository"
import type { StatsCache, StatsData, TimeRange } from "./tui/stats/types"

const CACHE_DIR = (() => {
  const xdg = process.env.XDG_STATE_HOME ?? path.join(process.env.HOME ?? "/tmp", ".local", "state")
  return path.join(xdg, "opencode")
})()

export const StatsCommand = effectCmd({
  command: "stats",
  describe: "show token usage and cost statistics",
  instance: false,
  builder: (yargs) =>
    yargs
      .option("range", {
        type: "string",
        choices: ["all", "7d", "30d"],
        default: "all",
        describe: "time range",
      }),
  handler: Effect.fn("Cli.stats")(function* (args) {
    const range = (args.range as TimeRange) ?? "all"

    // Precompute every range so the dashboard can switch instantly (the `r`
    // hotkey) without re-querying the database. Catch DB errors.
    const ranges = yield* Effect.gen(function* () {
      const all = yield* loadStats("all")
      const week = yield* loadStats("7d")
      const month = yield* loadStats("30d")
      return { all, "7d": week, "30d": month } satisfies Record<TimeRange, StatsData>
    }).pipe(Effect.catchCause(() => fail("Failed to load stats data")))

    const cache: StatsCache = { ranges, initialRange: range }

    // Write to cache file for child process to read
    const cacheFile = path.join(CACHE_DIR, `.stats-cache-${process.pid}.json`)
    yield* Effect.promise(async () => {
      await mkdir(CACHE_DIR, { recursive: true })
      await writeFile(cacheFile, JSON.stringify(cache))
    })

    // Launch TUI with stats route
    const exe = isBinaryMode() ? process.execPath : process.argv[0]
    const exeArgs = isBinaryMode()
      ? ["--route", JSON.stringify({ type: "plugin", id: "stats" })]
      : [process.argv[1], "--route", JSON.stringify({ type: "plugin", id: "stats" })]

    yield* Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          const child = spawn(exe, exeArgs, {
            cwd: process.cwd(),
            stdio: "inherit",
            env: {
              ...process.env,
              OPENCODE_STATS_CACHE: cacheFile,
            },
          })
          child.on("exit", () => resolve())
          child.on("error", () => resolve())
        }),
    )

    // Clean up cache file after TUI exits
    yield* Effect.promise(async () => {
      try { await import("fs/promises").then((fs) => fs.unlink(cacheFile)) } catch {}
    })
  }),
})

function isBinaryMode(): boolean {
  return !process.execPath.includes("bun") && !process.execPath.includes("node")
}
