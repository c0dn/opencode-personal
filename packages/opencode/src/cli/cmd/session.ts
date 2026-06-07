import type { Argv } from "yargs"
import { createInterface } from "readline"
import { Effect } from "effect"
import { cmd } from "./cmd"
import { effectCmd, fail, CliError } from "../effect-cmd"
import { Session } from "@/session/session"
import { SessionID } from "../../session/schema"
import { UI } from "../ui"
import { Locale } from "@/util/locale"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Filesystem } from "@/util/filesystem"
import { Process } from "@/util/process"
import { NotFoundError } from "@/storage/storage"
import { pick, pickMulti, PickerCancelledError, type PickOption } from "../picker"
import { EOL } from "os"
import path from "path"
import { which } from "@opencode-ai/core/util/which"

function pagerCmd(): string[] {
  const lessOptions = ["-R", "-S"]
  if (process.platform !== "win32") {
    return ["less", ...lessOptions]
  }

  // user could have less installed via other options
  const lessOnPath = which("less")
  if (lessOnPath) {
    if (Filesystem.stat(lessOnPath)?.size) return [lessOnPath, ...lessOptions]
  }

  if (Flag.OPENCODE_GIT_BASH_PATH) {
    const less = path.join(Flag.OPENCODE_GIT_BASH_PATH, "..", "..", "usr", "bin", "less.exe")
    if (Filesystem.stat(less)?.size) return [less, ...lessOptions]
  }

  const git = which("git")
  if (git) {
    const less = path.join(git, "..", "..", "usr", "bin", "less.exe")
    if (Filesystem.stat(less)?.size) return [less, ...lessOptions]
  }

  // Fall back to Windows built-in more (via cmd.exe)
  return ["cmd", "/c", "more"]
}

export const SessionCommand = cmd({
  command: "session",
  describe: "manage sessions",
  builder: (yargs: Argv) => yargs.command(SessionListCommand).command(SessionDeleteCommand).demandCommand(),
  async handler() {},
})

export const SessionDeleteCommand = effectCmd({
  command: "delete [sessionID]",
  aliases: ["rm", "del", "remove"],
  describe: "delete sessions interactively or by ID/title",
  builder: (yargs) =>
    yargs
      .positional("sessionID", {
        describe: "session ID or title to delete",
        type: "string",
      })
      .option("yes", {
        alias: ["y"],
        type: "boolean",
        describe: "skip confirmation prompt",
      }),
  handler: Effect.fn("Cli.session.delete")(function* (args) {
    const svc = yield* Session.Service

    // Resolve sessions to delete
    const targets = yield* resolveSessionsToDelete(svc, args.sessionID)

    if (targets.length === 0) {
      UI.println("No sessions selected")
      return
    }

    // Confirm (unless --yes)
    if (!args.yes) {
      const ok = yield* confirmDelete(svc, targets)
      if (!ok) return
    }

    // Delete each target
    for (const target of targets) {
      yield* svc
        .remove(target.id)
        .pipe(Effect.catchIf(NotFoundError.isInstance, () => fail(`Session not found: ${target.id}`)))
      UI.println(UI.Style.TEXT_SUCCESS_BOLD + `Deleted: ${target.title}` + UI.Style.TEXT_NORMAL)
    }
  }),
})

export const SessionListCommand = effectCmd({
  command: "list",
  describe: "list sessions",
  builder: (yargs) =>
    yargs
      .option("max-count", {
        alias: "n",
        describe: "limit to N most recent sessions",
        type: "number",
      })
      .option("format", {
        describe: "output format",
        type: "string",
        choices: ["table", "json"],
        default: "table",
      }),
  handler: Effect.fn("Cli.session.list")(function* (args) {
    const sessions = yield* Session.Service.use((svc) => svc.list({ roots: true, limit: args.maxCount }))

    if (sessions.length === 0) return

    const output = args.format === "json" ? formatSessionJSON(sessions) : formatSessionTable(sessions)

    const shouldPaginate = process.stdout.isTTY && !args.maxCount && args.format === "table"

    if (shouldPaginate) {
      yield* Effect.promise(async () => {
        const proc = Process.spawn(pagerCmd(), {
          stdin: "pipe",
          stdout: "inherit",
          stderr: "inherit",
        })

        if (!proc.stdin) {
          console.log(output)
          return
        }

        proc.stdin.write(output)
        proc.stdin.end()
        await proc.exited
      })
    } else {
      console.log(output)
    }
  }),
})

function formatSessionTable(sessions: Session.Info[]): string {
  const lines: string[] = []

  const maxIdWidth = Math.max(20, ...sessions.map((s) => s.id.length))
  const maxTitleWidth = Math.max(25, ...sessions.map((s) => s.title.length))

  const header = `Session ID${" ".repeat(maxIdWidth - 10)}  Title${" ".repeat(maxTitleWidth - 5)}  Updated`
  lines.push(header)
  lines.push("─".repeat(header.length))
  for (const session of sessions) {
    const truncatedTitle = Locale.truncate(session.title, maxTitleWidth)
    const timeStr = Locale.todayTimeOrDateTime(session.time.updated)
    const line = `${session.id.padEnd(maxIdWidth)}  ${truncatedTitle.padEnd(maxTitleWidth)}  ${timeStr}`
    lines.push(line)
  }

  return lines.join(EOL)
}

function formatSessionJSON(sessions: Session.Info[]): string {
  const jsonData = sessions.map((session) => ({
    id: session.id,
    title: session.title,
    updated: session.time.updated,
    created: session.time.created,
    projectId: session.projectID,
    directory: session.directory,
  }))
  return JSON.stringify(jsonData, null, 2)
}

// ── Delete resolution ─────────────────────────────────────────────────

function resolveSessionsToDelete(
  svc: Session.Interface,
  input: string | undefined,
): Effect.Effect<Session.GlobalInfo[], CliError> {
  return Effect.gen(function* () {
    // No input → multi-select picker over all sessions
    if (!input) {
      const sessions = yield* loadGlobalSessions(svc)
      if (sessions.length === 0) return yield* fail("No sessions found")
      const selected = yield* pickOrFailMulti(toPickOptions(sessions))
      return sessions.filter((s) => selected.some((sel) => sel.id === s.id))
    }

    // Exact session ID → direct DB lookup
    const maybeID = tryMakeSessionID(input)
    if (maybeID) {
      const info = yield* svc.get(maybeID).pipe(
        Effect.catchTag("NotFoundError", () => fail(`Session not found: ${input}`)),
      )
      return [info as Session.GlobalInfo]
    }

    // Title / fuzzy resolution → single session
    const sessions = yield* loadGlobalSessions(svc)
    if (sessions.length === 0) return yield* fail("No sessions found")

    const normalized = input.toLowerCase().trim()

    const exactMatches = sessions.filter((s) => s.title.toLowerCase().trim() === normalized)
    if (exactMatches.length === 1) return [exactMatches[0]!]

    if (exactMatches.length > 1) {
      const selected = yield* pickOrFail(toPickOptions(exactMatches), input)
      const found = exactMatches.find((s) => s.id === selected.id) ?? exactMatches[0]!
      return [found]
    }

    const titlePrefixMatches = sessions.filter((s) =>
      s.title.toLowerCase().trim().startsWith(normalized),
    )
    if (titlePrefixMatches.length === 1) return [titlePrefixMatches[0]!]

    const idPrefixMatches = sessions.filter((s) =>
      s.id.toLowerCase().startsWith(normalized),
    )
    if (idPrefixMatches.length === 1) return [idPrefixMatches[0]!]

    const candidates = titlePrefixMatches.length > 0
      ? titlePrefixMatches
      : sessions

    const selected = yield* pickOrFail(toPickOptions(candidates), input)
    const found = candidates.find((s) => s.id === selected.id) ?? candidates[0]!
    return [found]
  })
}

function confirmDelete(
  svc: Session.Interface,
  targets: Session.GlobalInfo[],
): Effect.Effect<boolean, CliError> {
  return Effect.promise(async () => {
    // Count total children
    let childCount = 0
    const childResults = await Promise.allSettled(
      targets.map((t) => Effect.runPromise(svc.children(t.id))),
    )
    for (const result of childResults) {
      if (result.status === "fulfilled") childCount += result.value.length
    }

    const noun = targets.length === 1 ? "session" : "sessions"
    let msg = `\nDelete ${targets.length} ${noun}:`
    for (const t of targets) {
      msg += `\n  \x1b[1m${t.title}\x1b[0m  \x1b[2m(${t.id})\x1b[0m`
    }
    if (childCount > 0) {
      msg += `\n  \x1b[2m(+ ${childCount} child ${childCount === 1 ? "session" : "sessions"})\x1b[0m`
    }
    msg += "\n\nAre you sure? [y/N] "

    const answer = await promptConfirm(msg)
    return answer
  }).pipe(
    Effect.orElseSucceed(() => false),
  )
}

function promptConfirm(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    process.stderr.write(message)
    const rl = createInterface({ input: process.stdin, output: process.stderr })
    rl.question("", (answer) => {
      rl.close()
      resolve(answer.toLowerCase().trim() === "y")
    })
  })
}

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

function pickOrFailMulti(options: PickOption[]): Effect.Effect<PickOption[], CliError> {
  return Effect.tryPromise({
    try: () => pickMulti(options),
    catch: (err) => {
      if (err instanceof PickerCancelledError) return new CliError({ message: "Cancelled", exitCode: 130 })
      return new CliError({ message: `Picker error: ${String(err)}`, exitCode: 1 })
    },
  })
}

function loadGlobalSessions(svc: Session.Interface): Effect.Effect<Session.GlobalInfo[]> {
  return svc.listGlobal({ roots: true, limit: 200 })
}
