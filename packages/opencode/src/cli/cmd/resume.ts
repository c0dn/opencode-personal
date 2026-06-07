import type { Argv } from "yargs"
import { spawn } from "child_process"
import { Effect } from "effect"
import { effectCmd, fail, CliError } from "../effect-cmd"
import { Session } from "@/session/session"
import { SessionID } from "../../session/schema"
import { UI } from "../ui"
import { pick, PickerCancelledError, type PickOption } from "../picker"
import { EOL } from "os"
import { Locale } from "@/util/locale"

// ── Command definition ───────────────────────────────────────────────

export const ResumeCommand = effectCmd({
  command: "resume [session]",
  describe: "interactively search and resume a session",
  instance: false,
  builder: (yargs: Argv) =>
    yargs
      .positional("session", {
        type: "string",
        describe: "session ID or title to resume",
      })
      .option("max-count", {
        alias: ["n"],
        type: "number",
        describe: "limit sessions loaded for fuzzy/picker",
        default: 200,
      })
      .option("list", {
        alias: ["l"],
        type: "boolean",
        describe: "list matching sessions without launching",
      })
      .option("format", {
        type: "string",
        choices: ["table", "json"],
        default: "table",
        describe: "output format for --list",
      }),
  handler: Effect.fn("Cli.resume")(function* (args) {
    const svc = yield* Session.Service
    const maxCount: number = (args as any)["max-count"] ?? 200

    // --list mode: load candidates, print, exit
    if (args.list) {
      const sessions = yield* svc.listGlobal({ roots: true, limit: maxCount })
      if (sessions.length === 0) {
        UI.println("No sessions found")
        return
      }
      const output = args.format === "json" ? formatSessionJSON(sessions) : formatSessionTable(sessions)
      console.log(output)
      return
    }

    // Resolve to a single session, then launch
    const target = yield* resolveSession(svc, args.session, maxCount)

    yield* Effect.promise(() =>
      new Promise<void>((resolve) => {
        const child = spawnOpencode(["-s", target.id], target.directory)
        child.on("exit", () => resolve())
      }),
    )
  }),
})

// ── Spawn helper ─────────────────────────────────────────────────────

function spawnOpencode(args: string[], cwd: string) {
  const isRuntime =
    process.execPath.includes("bun") ||
    process.execPath.includes("node")

  const [cmd, ...cmdArgs] = isRuntime
    ? [process.argv[0], process.argv[1], ...args]
    : [process.execPath, ...args]

  const child = spawn(cmd, cmdArgs, {
    cwd,
    stdio: "inherit",
  })

  child.on("error", (err) => {
    UI.error(`Failed to launch opencode: ${err.message}`)
    process.exit(1)
  })

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal)
      return
    }
    process.exit(code ?? 0)
  })

  return child
}

// ── Session resolution ───────────────────────────────────────────────

function resolveSession(
  svc: Session.Interface,
  input: string | undefined,
  maxCount: number,
): Effect.Effect<Session.GlobalInfo | Session.Info, CliError> {
  return Effect.gen(function* () {
    // No input → interactive picker over all root sessions
    if (!input) {
      const sessions = yield* svc.listGlobal({ roots: true, limit: maxCount })
      if (sessions.length === 0) return yield* fail("No sessions found")
      const selected = yield* pickOrFail(toPickOptions(sessions))
      return sessions.find((s) => s.id === selected.id) ?? sessions[0]!
    }

    // Exact session ID → direct DB lookup
    const maybeID = tryMakeSessionID(input)
    if (maybeID) {
      const info = yield* svc.get(maybeID).pipe(
        Effect.catchTag("NotFoundError", () => fail(`Session not found: ${input}`)),
      )
      return info
    }

    // Title / fuzzy resolution
    const sessions = yield* svc.listGlobal({ roots: true, limit: maxCount })
    if (sessions.length === 0) return yield* fail("No sessions found")

    const normalized = input.toLowerCase().trim()

    // Exact title match (case-insensitive)
    const exactMatches = sessions.filter((s) => s.title.toLowerCase().trim() === normalized)
    if (exactMatches.length === 1) return exactMatches[0]!

    // Duplicate exact titles → picker
    if (exactMatches.length > 1) {
      const selected = yield* pickOrFail(toPickOptions(exactMatches), input)
      return exactMatches.find((s) => s.id === selected.id) ?? exactMatches[0]!
    }

    // Unique title prefix match
    const titlePrefixMatches = sessions.filter((s) =>
      s.title.toLowerCase().trim().startsWith(normalized),
    )
    if (titlePrefixMatches.length === 1) return titlePrefixMatches[0]!

    // Unique session ID prefix match
    const idPrefixMatches = sessions.filter((s) =>
      s.id.toLowerCase().startsWith(normalized),
    )
    if (idPrefixMatches.length === 1) return idPrefixMatches[0]!

    // Multiple / ambiguous / no matches → picker
    const candidates = titlePrefixMatches.length > 0
      ? titlePrefixMatches
      : sessions

    const selected = yield* pickOrFail(toPickOptions(candidates), input)
    return candidates.find((s) => s.id === selected.id) ?? candidates[0]!
  })
}

// ── Helpers ──────────────────────────────────────────────────────────

function tryMakeSessionID(input: string): SessionID | null {
  try {
    return SessionID.make(input)
  } catch {
    return null
  }
}

function toPickOptions(sessions: Session.GlobalInfo[]): PickOption[] {
  return sessions.map((s) => ({
    id: s.id,
    title: s.title,
    subtitle: s.project?.name ?? s.project?.worktree ?? undefined,
    detail: Locale.todayTimeOrDateTime(s.time.updated),
  }))
}

function pickOrFail(options: PickOption[], query?: string): Effect.Effect<PickOption, CliError> {
  return Effect.tryPromise({
    try: () => pick(options, query),
    catch: (err) => {
      if (err instanceof PickerCancelledError) return new CliError({ message: "Cancelled", exitCode: 130 })
      return new CliError({ message: `Picker error: ${String(err)}`, exitCode: 1 })
    },
  })
}

// ── Table formatting ─────────────────────────────────────────────────

function formatSessionTable(sessions: Session.GlobalInfo[]): string {
  const lines: string[] = []

  const maxIdWidth = Math.max(20, ...sessions.map((s) => s.id.length))
  const maxTitleWidth = Math.max(25, ...sessions.map((s) => s.title.length))
  const maxProjectWidth = Math.max(12, ...sessions.map((s) => (s.project?.name ?? "").length))

  const header =
    `Session ID${" ".repeat(maxIdWidth - 10)}  ` +
    `Title${" ".repeat(maxTitleWidth - 5)}  ` +
    `Project${" ".repeat(maxProjectWidth - 7)}  ` +
    `Updated`
  lines.push(header)
  lines.push("\u2500".repeat(header.length))

  for (const session of sessions) {
    const title = Locale.truncate(session.title, maxTitleWidth)
    const project = Locale.truncate(session.project?.name ?? "", maxProjectWidth)
    const timeStr = Locale.todayTimeOrDateTime(session.time.updated)
    lines.push(
      `${session.id.padEnd(maxIdWidth)}  ` +
      `${title.padEnd(maxTitleWidth)}  ` +
      `${project.padEnd(maxProjectWidth)}  ` +
      `${timeStr}`,
    )
  }

  return lines.join(EOL)
}

function formatSessionJSON(sessions: Session.GlobalInfo[]): string {
  const data = sessions.map((s) => ({
    id: s.id,
    title: s.title,
    directory: s.directory,
    project: s.project?.name ?? null,
    updated: s.time.updated,
    created: s.time.created,
  }))
  return JSON.stringify(data, null, 2)
}
