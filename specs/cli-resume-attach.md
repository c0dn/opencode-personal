# CLI — `opencode resume` and `opencode attach` auto-discovery

## Purpose

Add two CLI features:

1. **`opencode resume [session]`** — Interactive session browser that lets the user search
   all sessions by title and resume one by session ID. Non-interactive direct resume via
   session ID or exact title also supported.

2. **`opencode attach [url]`** — Make the server URL optional. When omitted,
   auto-discover the server at `http://localhost:4096` (the default `opencode serve` port).

## Goals

- `opencode resume` (no args) opens an interactive fuzzy TUI picker over all root sessions
  cross-project, sorted by most-recently-updated.
- `opencode resume <session>` resolves the session via exact ID → exact title → unique
  prefix (ID or title) → fuzzy results.
- Selected session launches `opencode -s <id>` in the session's original directory.
- `opencode attach` (no URL) auto-connects using the same port/hostname
  resolution as `opencode serve` (config-aware, defaulting to `127.0.0.1:4096`).
- Both commands work without a running server. `resume` reads the DB directly; `attach`
  only needs network.

## Non-goals

- No daemon-mode auto-discovery via PID files, mDNS, or port files (the server doesn't
  write those today, and adding server-side state is out of scope).
- No `resume`-with-attach hybrid that probes a running server. First version always
  spawns a new process. Users with a running server use `opencode attach` separately.
- No change to `opencode run` or the default `$0 [project]` entrypoint.
- No database schema migrations (existing tables are sufficient).

## Current state

### `opencode session list` (existing)

- `packages/opencode/src/cli/cmd/session.ts` — `SessionListCommand`
- Project-scoped (`instance: true`), uses `Session.Service.use(svc => svc.list(...))`
- Outputs table or JSON to stdout, paginates via `less`.

### `opencode attach <url>` (existing)

- `packages/opencode/src/cli/cmd/tui/attach.ts` — `AttachCommand`
- Requires positional `<url>` argument.
- Validates the session via HTTP `session.get`, then boots the full TUI (`app.ts`).
- Supports `--continue`, `--session`, `--fork`, `--dir`, `--password`, `--username`.

### `opencode serve` (existing)

- `packages/opencode/src/cli/cmd/serve.ts` — `ServeCommand`
- Default network options (`network.ts`): `host: "127.0.0.1"`, `port: 0` → resolves to
  4096 first, then ephemeral fallback.
- Prints `opencode server listening on http://<host>:<port>` to stdout.
- No PID file, port file, or lock file is written.

### Session database

- `packages/core/src/session/sql.ts` — Drizzle schema:
  - `session.id` (text PK, like `ses_xxx`)
  - `session.title` (text, human-readable)
  - `session.directory` (absolute path, via `DatabasePath.directoryColumn()`)
  - `session.project_id` (FK → `project.id`)
  - `session.parent_id` (nullable, NULL = root session)
  - `session.time_updated` (epoch ms)
  - `session.time_created`, `session.time_archived`, etc.
- `packages/core/src/project/sql.ts` — `project.id`, `project.name`, `project.worktree`

### Session service — cross-project listing

`packages/opencode/src/session/session.ts`:

- `Session.Interface.listGlobal(input?)` — Effect-based, runs under any `Database.Service`.
  Supports `roots`, `search` (LIKE on title), `start`, `cursor`, `limit` (default 100).
  Returns `GlobalInfo[]` (session info + `project: { id, name, worktree }`).
- Standalone `export function* listGlobal(input?)` — Generator version using its own
  `runtime` (bypasses Effect context). Collectable via `[...listGlobal(...)]`.

### AppRuntime services

`packages/opencode/src/effect/app-runtime.ts` — `AppLayer` includes `Session.defaultLayer`,
`Database.defaultLayer`, etc. So any `effectCmd({ instance: false })` handler can
`yield* Session.Service`.

### CLI command framework

- `cmd(opts)` — thin yargs `CommandModule` wrapper (`packages/opencode/src/cli/cmd/cmd.ts`)
- `effectCmd(opts)` — Effect-based wrapper with `instance: true|false` and auto-bootstrap
  (`packages/opencode/src/cli/effect-cmd.ts`)
- Commands registered in `packages/opencode/src/index.ts` via `.command(...)`.

### oc-sessions reference patterns

From `Dylan-Liew/oc-sessions`:

- **Session resolution chain**: exact ID → exact title → unique prefix → fuzzy list →
  interactive picker.
- **Interactive picker**: raw TTY mode (`process.stdin.setRawMode(true)`, keypress
  handling, live redraw). Non-TTY fallback: numbered prompt on stderr.
- **Fuzzy scoring**: custom scorer (exact > prefix > substring > subsequence).
- **Session resume**: `chdir` + spawn `opencode -s <id>` with `stdio: "inherit"`.
- **No external fuzzy-search or TUI dependencies** — all Node built-ins.

## Target architecture

### Feature 1: `opencode resume [session]`

#### New files

| File | Purpose |
|------|---------|
| `packages/opencode/src/cli/cmd/resume.ts` | `ResumeCommand` yargs definition |
| `packages/opencode/src/cli/picker.ts` | Interactive fuzzy session picker |
| `packages/opencode/src/cli/fuzzy.ts` | Fuzzy string matching utilities |

#### Modified files

| File | Change |
|------|--------|
| `packages/opencode/src/index.ts` | Register `ResumeCommand` |

#### Command signature

```
opencode resume [session]

Positionals:
  session  Session ID or title to resume (optional; interactive picker if omitted)

Options:
  --max-count, -n  Limit sessions loaded for fuzzy/picker (default: 200)
  --list, -l       List matching sessions (no interactive picker, no launch)
  --format         Output format for --list: table | json (default: table)
```

Note: `--format` is only meaningful with `--list`. Without `--list`, a single
session is selected and launched; format output is not applicable.

#### Resolution algorithm

```
resolveSession(sessionInput: string | undefined): Session | Session[]
```

The resolution has two distinct query paths:

1. **Exact session ID** (input passes `SessionID` validation, i.e. starts with `"ses"`):
   - `Session.Service.get(sessionID)` — direct DB lookup by primary key
   - Found → return it
   - Not found → error "Session not found: <id>"
   - This path ignores `--max-count` entirely (finds sessions of any age)

 2. **Title/prefix/fuzzy** (input is a plain string or undefined):
   - Query candidates via `Session.Service.listGlobal({ roots: true, limit: maxCount })`
   - If input is undefined → all candidates straight to interactive picker
   - Resolution on the candidate set:
     a. Exact title match (case-insensitive) → if unique, return it.
        If duplicates → launch interactive picker pre-filtered to only the
        matching sessions (title acts as the initial query). In non-TTY mode,
        print a numbered list and prompt the user to pick.
     b. Unique prefix match on title → return it (candidate title starts with input)
     c. Unique prefix match on session ID → return it
     d. Multiple ambiguous matches (prefix returns >1, no single clear winner) →
        launch interactive picker pre-filtered by the query. Non-TTY: print
        numbered candidates and prompt.
     e. No match → launch interactive picker pre-filtered by the query
        (fuzzy-filtered results pre-populate the search). Non-TTY: print
        "No sessions match '<input>'" and top fuzzy suggestions, then prompt
        for a different query.

   In all cases the picker shows: title, project name, relative time.
   The resolution never silently picks a "best guess" — the user always
   confirms when there's any ambiguity.

#### Interactive picker UX

- **TTY mode**:
  - Header: `Select a session to resume (type to filter)`
  - Each row: `[title]  [project name]  [last updated]`
  - Live filtering as user types (fuzzy match on title + project name)
  - ↑/↓ to move cursor, Enter to select, Ctrl+C / Esc to cancel
  - Wrap-around scrolling when results exceed terminal height
- **Non-TTY mode**:
  - Print numbered list to stderr
  - Prompt: `Enter session number or search text: `
  - Read from stdin

#### Session display

Each session shown in the picker:
```
Fix login button styling          my-project    2 hours ago
Refactor database layer           backend-api    3 days ago
Add dark mode support             my-project    1 week ago
```

Truncated to terminal width with priority: title > project > time.

#### Resume behavior

After selection, launch `opencode -s <sessionID>` in the session's directory via
`spawnOpencode()`. This helper handles both dev-script mode and compiled-binary
mode:

```typescript
// packages/opencode/src/cli/cmd/resume.ts

import { spawn, type ChildProcess } from "child_process"

function spawnOpencode(args: string[], cwd: string): ChildProcess {
  const isRuntime =
    process.execPath.includes("bun") ||
    process.execPath.includes("node")  // `node` may appear in binary paths on some platforms

  // Dev/script mode: bun|node <entry-script> -s <id>
  // Compiled binary mode: <opencode-binary> -s <id>
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
      // Re-raise the signal so the parent exits the same way
      process.kill(process.pid, signal)
      return
    }
    process.exit(code ?? 0)
  })

  return child
}
```

Key properties:
- Uses `process.execPath` to distinguish compiled binary vs. script mode.
  In compiled mode, `process.execPath` is the platform-specific binary; in dev mode
  it's `bun` (or `node`).
- Dev mode passes `process.argv[1]` (the entry script) as the first positional arg
  to the runtime.
- Error/signal handling ensures clean parent-process lifecycle.
- `cwd` is set explicitly; no `process.chdir()` in the parent.

#### Effect handler design

```typescript
export const ResumeCommand = effectCmd({
  command: "resume [session]",
  describe: "interactively search and resume a session",
  instance: false,  // global, no project instance needed
  builder: (yargs) =>
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

    // --list mode: load candidates, print, exit (no resolution, no launch)
    if (args.list) {
      const sessions = yield* svc.listGlobal({ roots: true, limit: args.maxCount })
      if (args.format === "json") console.log(formatSessionJSON(sessions))
      else console.log(formatSessionTable(sessions))
      return
    }

    // Resolve to a single session
    const target = yield* resolveSession(svc, args.session, args.maxCount)

    // Launch
    yield* Effect.promise(() =>
      new Promise<void>((resolve) => {
        const child = spawnOpencode(["-s", target.id], target.directory)
        child.on("exit", () => resolve())
      })
    )
  }),
})
```

#### `resolveSession` function

```typescript
function resolveSession(
  svc: Session.Interface,
  input: string | undefined,
  maxCount: number,
): Effect.Effect<Session.GlobalInfo, CliError>
```

Implementation plan:
1. If `input` is undefined → load candidates, launch interactive picker, return selection.
2. Try `SessionID.make(input)` → if valid, use `svc.get(sessionID)` for direct DB lookup.
   - Found → return it.
   - Not found → error.
3. Input is a title string → load candidates up to `maxCount`, then:
   a. Exact title match (case-insensitive) → if exactly one, return it.
      If multiple, launch the picker with those sessions pre-selected (query = input).
   b. Unique prefix match on title → return it.
   c. Unique prefix match on session ID → return it.
   d. Multiple prefix matches → launch picker pre-filtered by query.
   e. No matches at all → launch picker pre-filtered by query (fuzzy results).
   In non-TTY mode, fall back to numbered-list prompt for any ambiguous case.
4. Any unexpected failure uses `fail("message", exitCode)` from `effect-cmd.ts`.

### Feature 2: `opencode attach [url]`

#### Modified files

| File | Change |
|------|--------|
| `packages/opencode/src/cli/cmd/tui/attach.ts` | Make `url` optional, add `--port`/`--host` |

#### Command signature changes

Before:
```
opencode attach <url> [--dir ...] [--continue] [--session ...] [--fork] [--password ...] [--username ...]
```

After:
```
opencode attach [url] [--hostname <host>] [--port <n>] [--dir ...] [--continue] [--session ...] [--fork] [--password ...] [--username ...]
```

#### URL resolution

The attach command reuses the existing `network.ts` infrastructure to align with
how `serve` resolves its port and hostname:

```typescript
import { resolveNetworkOptionsNoConfig } from "@/network"

function resolveAttachUrl(args: {
  url?: string
  port?: number
  hostname?: string
}): string {
  // Explicit URL always wins
  if (args.url) return args.url

  // Resolve using the same logic as `serve`:
  // - explicit --port / --hostname flags take priority
  // - global config `server.port` / `server.hostname` read if available
  // - defaults: hostname=127.0.0.1, port=4096 (via resolveNetworkOptionsNoConfig)
  const network = resolveNetworkOptionsNoConfig({
    port: args.port ?? 0,
    hostname: args.hostname ?? "127.0.0.1",
    mdns: false,
    "mdns-domain": "opencode.local",
    cors: [],
  })

  // If port resolved to 0 (no explicit --port, no config), use 4096
  // (matching serve's first-fallback behavior).
  const port = network.port === 0 ? 4096 : network.port
  return `http://${network.hostname}:${port}`
}
```

#### Connection validation

When the URL is auto-resolved (no explicit URL provided), attempt a lightweight
probe to verify connectivity before launching the full TUI. Use the existing
`ServerAuth.headers(...)` to include credentials:

```typescript
async function probeAttach(
  url: string,
  headers: Record<string, string>,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const res = await fetch(`${url}/session`, {
      signal: AbortSignal.timeout(2000),
      headers,
    })
    if (res.ok || res.status === 401) return { ok: true }
    if (res.status === 403) return { ok: false, reason: `Server rejected authentication.` }
    return { ok: true } // non-2xx is still a valid opencode server
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes("ECONNREFUSED") || msg.includes("fetch failed"))
      return { ok: false, reason: `No opencode server listening at ${url}` }
    if (msg.includes("ETIMEDOUT") || msg.includes("timeout"))
      return { ok: false, reason: `Connection to ${url} timed out` }
    return { ok: false, reason: `Could not connect to ${url}: ${msg}` }
  }
}
```

If the probe fails, print:
```
Could not connect to opencode server at http://127.0.0.1:4096.
Is `opencode serve` running? Use --port to specify a different port.
```
And exit with code 1.

If the probe succeeds (any response from an opencode server — even 401/403),
proceed with the normal attach flow. The TUI and `validateSession` will handle
auth errors with their own user-visible messages.

Note: The probe is only done when the URL is auto-resolved. When the user
provides an explicit URL, skip the probe and let `validateSession` handle
connection errors (preserving existing behavior).

#### Implementation approach

The attach command currently uses `cmd()` (not `effectCmd`). Keep it plain — add
`--hostname` and `--port` options, make `<url>` optional, and add URL
construction and optional pre-flight probe before the existing handler logic.

```typescript
export const AttachCommand = cmd({
  command: "attach [url]",
  describe: "attach to a running opencode server",
  builder: (yargs) =>
    yargs
      .positional("url", {
        type: "string",
        describe: "server URL (default: auto-resolved via config / 127.0.0.1:4096)",
      })
      .option("hostname", {
        type: "string",
        describe: "server hostname (default: 127.0.0.1, respects global config)",
      })
      .option("port", {
        type: "number",
        describe: "server port (default: 4096, respects global config)",
      })
      // ... existing options (--dir, --continue, --session, etc.) unchanged ...
  handler: async (args) => {
    const url = resolveAttachUrl(args)
    // If auto-resolved, probe before continuing
    if (!args.url) {
      const headers = ServerAuth.headers({ password: args.password, username: args.username })
      const probe = await probeAttach(url, headers)
      if (!probe.ok) {
        UI.error(probe.reason)
        process.exit(1)
      }
    }
    // ... rest of handler uses `url` instead of `args.url` ...
  },
})
```

### Interactive picker module

#### `packages/opencode/src/cli/picker.ts`

```typescript
export interface PickOption {
  id: string
  title: string
  subtitle?: string    // e.g. project name
  detail?: string      // e.g. relative time (formatted)
}

export class PickerCancelledError extends Error {
  constructor() {
    super("cancelled")
  }
}

/**
 * Present an interactive fuzzy picker for selecting one option.
 *
 * TTY mode: raw-mode terminal, live-filtering, arrow-key navigation.
 * Non-TTY mode: numbered list on stderr + stdin input.
 *
 * @param options  - Full list of selectable options.
 * @param query    - Initial filter text (e.g. pre-populated from a title search).
 *                   The picker starts with this query applied to the options.
 *
 * Returns the selected option, or throws PickerCancelledError (SIGINT / Escape).
 * Guarantees terminal state restoration on every exit path.
 */
export async function pick(
  options: PickOption[],
  query?: string,
): Promise<PickOption>
```

#### Lifecycle guarantees

The picker must acquire and release terminal raw mode in a try/finally block:

```typescript
export async function pick(options: PickOption[]): Promise<PickOption> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return pickNonTty(options)
  }

  const wasRaw = process.stdin.isRaw
  let listeners: Array<[string, (...args: any[]) => void]> = []

  try {
    process.stdin.setRawMode(true)
    process.stdin.resume()

    const cleanup = () => {
      process.stdin.setRawMode(wasRaw ?? false)
      process.stdin.pause()
      for (const [event, handler] of listeners) {
        process.stdin.removeListener(event, handler)
        process.removeListener(event, handler)
      }
    }

    // ... TUI rendering loop ...

    return selected
  } finally {
    cleanup()
  }
}
```

Critical cleanup paths:
- Normal selection (Enter) → restore, return.
- Cancellation (Ctrl+C / Escape) → restore, throw `PickerCancelledError`.
- Error thrown during rendering → restore in `finally`, re-throw.
- `process.on("SIGINT", ...)` handler during raw mode → restore, exit 130.
- EOF on stdin (pipe closes) → restore, fall back to non-TTY or throw.

#### TTY mode rendering

- **State**: `query`, `filtered`, `cursorIndex`, `scrollOffset`
- **Input handling**:
  - Printable characters → append to `query`, recalculate `filtered`
  - Backspace / Ctrl+H → pop last char from `query`
  - ↑ / Ctrl+P → `cursorIndex = max(0, cursorIndex - 1)`
  - ↓ / Ctrl+N → `cursorIndex = min(filtered.length - 1, cursorIndex + 1)`
  - Enter → return `filtered[cursorIndex]`
  - Escape / Ctrl+C → throw `PickerCancelledError`
- **Redraw** on every keystroke using ANSI escape codes:
  - Clear previous output area (track line count)
  - Print header line
  - Print filtered options (cursor row highlighted with reverse video)
  - Print status/footer line
  - Scroll handling: `scrollOffset` adjusted so cursor stays visible
- **Resize handling**: On `SIGWINCH` or stdout resize, re-render with new dimensions.
- **Terminal width**:
  - Wide (>80 cols): `[title] [project] [time]`
  - Medium (60-80): `[title] [time]`
  - Narrow (<60): `[truncated title]`

#### Non-TTY mode

- If `query` is non-empty, pre-filter options via `fuzzyFilter(query, options)`.
- Print filtered options as a numbered list to stderr:
  ```
  1. Fix login button styling          my-project    2 hours ago
  2. Login page refactor               my-project    5 days ago
  ```
- If zero filtered results → print `No sessions match "<query>"` and show
  a shorter list of top fuzzy suggestions, then prompt for a new query.
- Prompt `Enter number, refine search, or Ctrl+C to cancel: ` on stderr.
- Read one line from stdin via `readline`.
- Parse as integer → if in range [1, N], return that option.
  If invalid number, re-prompt.
- Parse as text → re-filter with new query, print new list, re-prompt.
- Empty input (just Enter) → return first option (the top result).
- EOF or Ctrl+C → throw `PickerCancelledError`.
- Cap printed options to a reasonable number (e.g., 20) but still accept numeric
  input up to the actual count.

#### `packages/opencode/src/cli/fuzzy.ts`

```typescript
/**
 * Score a normalized query against a normalized candidate string.
 * Higher = better match. Returns 0 for no match.
 *
 * Normalization: lowercase, collapse whitespace, trim.
 */
export function fuzzyScore(query: string, candidate: string): number

/**
 * Filter and sort options by fuzzy score against query.
 * Preserves original order for equal scores.
 * Returns all options when query is empty.
 */
export function fuzzyFilter<T extends { title: string; subtitle?: string }>(
  query: string,
  options: T[],
): T[]
```

Scoring rules:
- Normalize: lowercase both, collapse whitespace
- Exact match: score = candidate.length * 10
- Prefix match (candidate starts with query): score = query.length * 5
- Substring match: score = query.length * 3
- Subsequence match (characters in order but not adjacent): score = sum of consecutive run bonuses
- Partial token match (query matches beginning of space/hyphen/underscore-separated tokens): +2 per token

## Data model / state ownership

No new persistent state. The interactive picker is in-memory only.

No schema changes needed. The `session` table has `title`, `directory`,
`time_updated`, and `project_id` (denormalized via `project` join) — all the fields
the picker needs.

## Data flow / lifecycle

```
opencode resume
  │
  ├─ effectCmd handler (instance: false, AppServices)
  │   │
  │   ├─ Session.Service.listGlobal({ roots: true, limit: 200 })
  │   │   └─ SQL: SELECT * FROM session WHERE parent_id IS NULL
  │   │       AND time_archived IS NULL
  │   │       ORDER BY time_updated DESC LIMIT 200
  │   │       + JOIN project for name/worktree
  │   │
  │   ├─ [input provided?]
  │   │   YES → resolveSession(sessions, input)
  │   │   NO  → pickSession(sessions)  // interactive TUI
  │   │
  │   └─ spawn("opencode", "-s", sessionID, { cwd: session.dir })
  │       └─ child process inherits terminal
  │
  └─ parent process exits with child exit code
```

```
opencode attach
  │
  ├─ no URL → construct http://<host>:<port>
  │   optionally probe server health
  │
  ├─ validateSession(url, sessionID, directory, headers)
  │
  └─ boot full TUI (app.ts) against external server
```

## Interfaces and contracts

### `Session.Interface.listGlobal`

Already exists. Used by `resume` command.

```typescript
listGlobal(input?: {
  directory?: string
  roots?: boolean        // we set roots: true
  start?: number
  cursor?: number
  search?: string
  limit?: number         // we set limit: 200
  archived?: boolean     // we leave default (false = exclude archived)
}): Effect.Effect<Session.GlobalInfo[]>
```

### `Session.Info` and `Session.GlobalInfo` types

```typescript
// Session.Info (from Session.Service.get)
type Info = {
  id: string           // "ses_abc123..."
  title: string        // "Fix login button styling"
  directory: string    // absolute path: "/home/user/projects/my-project"
  projectID: string
  // ... other fields: slug, parentID, time, cost, tokens, etc.
}

// Session.GlobalInfo (from Session.Service.listGlobal — extends Info)
type GlobalInfo = Info & {
  project: {           // joined from project table (nullable)
    id: string
    name?: string      // "my-project"
    worktree: string   // "/home/user/projects/my-project"
  } | null
}
```

For the direct-ID lookup path (`opencode resume ses_abc`):
- `Session.Service.get(sessionID)` returns `Info` which has `directory` (absolute).
- `session.directory` is sufficient for spawning; no project lookup needed.
- For error/disambiguation messages, print `info.id`, `info.title`, and
  `info.directory`.

## Implementation notes

### File layout

```
packages/opencode/src/cli/cmd/
  resume.ts            ← new: ResumeCommand
  tui/attach.ts        ← modified: AttachCommand (url optional)
packages/opencode/src/cli/
  picker.ts            ← new: interactive picker
  fuzzy.ts             ← new: fuzzy matcher
packages/opencode/src/
  index.ts             ← modified: register ResumeCommand
specs/
  cli-resume-attach.md ← this file
```

### Dependencies

No new npm dependencies. All implementation uses:
- Node built-ins: `child_process`, `readline`, `process`
- Existing opencode services: `Session.Service`, `effectCmd`, `cmd`
- Effect for handler orchestration

### Edge cases

1. **No sessions exist**: Interactive picker shows "No sessions found" and exits.
2. **Session directory doesn't exist**: Warn the user before spawning; the spawned
   opencode will handle it.
3. **Terminal window too narrow**: Picker truncates columns intelligently. At very
   narrow widths (<40 cols), show only title.
4. **Stdin piped** (non-TTY): Picker falls back to numbered list + input prompt.
5. **Ctrl+C during picker**: Exit cleanly, restore terminal mode.
6. **Large session count** (e.g. 500+): --max-count limits loaded sessions.
7. **Session with NULL project**: Display project as "(unknown)" — can happen for
   sessions whose project was deleted.

## Validation strategy

### Manual smoke tests

```bash
# resume with no sessions (fresh install)
opencode resume

# resume interactively
opencode resume
# → type "login" → see filtered results → Enter to select
# → should launch opencode in session directory

# resume by session ID
opencode resume ses_abc123

# resume by title
opencode resume "Fix login bug"

# resume with --list
opencode resume --list
opencode resume --list --format json

# attach auto-discover
opencode serve &       # start server
opencode attach        # should connect without URL
opencode attach --port 4097  # custom port
kill %1

# attach with explicit URL (backward compatible)
opencode attach http://localhost:4096

# attach to non-existent server
opencode attach        # → clear error: "Could not connect..."
```

### Automated tests

Test file: `packages/opencode/test/cli/resume.test.ts`
(These test the resolution logic in isolation, not the TTY picker.)

- `resolveSession` with exact valid session ID → returns that session via `Session.Service.get`
- `resolveSession` with exact invalid session ID → throws error
- `resolveSession` with exact title → returns matching session (unique)
- `resolveSession` with exact title (duplicates) → throws error with disambiguation table
- `resolveSession` with unique title prefix → returns matching session
- `resolveSession` with ambiguous title prefix → throws error with candidates
- `resolveSession` with no match → throws error with fuzzy suggestions
- `resolveSession` with undefined input → returns from picker (mock picker)

Test file: `packages/opencode/test/cli/fuzzy.test.ts`

- Exact match scores higher than prefix
- Prefix scores higher than substring
- Substring scores higher than subsequence
- Empty query matches all
- Case insensitivity
- Whitespace normalization
- Token boundary bonus

Test file: `packages/opencode/test/cli/attach.test.ts`

- `resolveAttachUrl` with explicit URL → returns URL unchanged
- `resolveAttachUrl` with no URL, default options → returns `http://127.0.0.1:4096`
- `resolveAttachUrl` with `--port 1234` → returns `http://127.0.0.1:1234`
- `resolveAttachUrl` with `--hostname 0.0.0.0 --port 3000` → `http://0.0.0.0:3000`
- `probeAttach` with connection refused → `{ ok: false, reason: "No opencode server listening at ..." }`
- `probeAttach` with HTTP 200 → `{ ok: true }`
- `probeAttach` with HTTP 401 → `{ ok: true }`
- `probeAttach` with HTTP 403 → `{ ok: false, reason: "Server rejected authentication." }`
- `probeAttach` with timeout → `{ ok: false, reason: "Connection to ... timed out" }`

Note: All attach tests can run without a live server; `probeAttach` uses `fetch` which can be tested with mock HTTP or by letting actual network calls fail.

### Type checking

```bash
bun --cwd packages/opencode typecheck
```

## Risks and tradeoffs

| Risk | Mitigation |
|------|-----------|
| Interactive picker raw-mode terminal state may leak on crashes | `try/finally` block restores terminal mode, removes listeners; SIGINT handler in raw mode restores then exits 130 |
| `spawnOpencode` may fail to construct the correct launch command in edge cases | `process.execPath` detection covers dev (`bun`/`node`) and compiled binary modes; error handler prints clear message on spawn failure |
| `listGlobal()` loaded candidates may not include the session the user wants to resume by title | Exact session-ID lookup uses `Session.Service.get()` (direct PK query, unlimited by `--max-count`). Title resolution queries up to `--max-count` (default 200); user can increase with `--max-count`. |
| `Session.Service.get()` returns `Session.Info` (not `GlobalInfo`), which lacks `.project.worktree` | After direct ID lookup, we fetch the project separately or search the candidate list for the matching ID; the `session.directory` field is absolute and sufficient for launch |
| Duplicate session titles (common with auto-generated names) could produce ambiguous results | Exact title match with duplicates launches the picker pre-filtered to those sessions (query = title). User confirms visually instead of getting an error. |
| `attach` auto-discovery may fail silently if port 4096 has a non-opencode server listening | Pre-flight probe distinguishes genuine opencode responses (even 401/403) from non-opencode or connection-refused errors |
| `attach` URL resolution may not match `serve` port if user relied on ephemeral fallback | The probe reports the specific URL attempted and suggests using the URL printed by `opencode serve` |
| Non-TTY stdin (e.g., piped input) could hang waiting for picker input | Non-TTY path reads exactly one line; EOF or empty input produces an error instead of hanging |

## Open questions

1. **Should `resume` try to attach to a running server first before spawning?**
   - Decision: No for v1. Users with a running server use `opencode attach`.
   - Reasoning: Determining whether a session "belongs" to the running server
     (matching directory/project) adds complexity without clear UX benefit.

2. **Should `opencode serve` write a port/pid file for discovery?**
   - Decision: No for v1. `opencode attach` auto-discovery via config-aware
     URL resolution covers the common case. Pid file adds platform-specific
     locking and cleanup complexity.

3. **Should the picker show archived sessions?**
   - Decision: No. `listGlobal({ roots: true })` excludes archived sessions by
     default. Add `--archived` flag if requested later.

4. **Should `resume` support forking directly?**
   - Decision: No for v1. The spawned `opencode` process supports `--fork`.
     Add `--fork` flag to `resume` later if requested.

5. **Should `resume` accept `--dir` to filter sessions by project directory?**
   - Decision: Deferred. The interactive picker shows project name for each
     session, which is sufficient for most users. Add if needed.

6. **What happens when a session's directory no longer exists?**
   - Decision: `spawnOpencode` will fail with an ENOENT-like error from the
     child process. The parent receives the error event, prints it, and exits.
     No pre-validation of directory existence in the parent.

## Review findings

This spec incorporates fixes from architecture-critic review (see `@architecture-critic`):

| Severity | Finding | Resolution |
|----------|---------|------------|
| blocker | Spawn target not robust across dev vs compiled binary | `spawnOpencode()` helper detects mode via `process.execPath` |
| major | `--list` flow conflicts with picker | Split `--list` path (load+print, no resolution) from resume path (resolve+launch) |
| major | Session resolution misses older sessions, mishandles duplicates | Exact ID uses direct `Session.Service.get()`; duplicate titles print disambiguation, never silently pick first |
| major | Attach URL diverges from network config | Reuse `resolveNetworkOptionsNoConfig` from `network.ts`; use `--hostname` not `--host` |
| major | TTY picker lifecycle leaks terminal state | Acquire/release in `try/finally`; SIGINT handler; listener cleanup |
| major | Attach probe endpoint blurs auth vs network errors | Probe distinguishes `ECONNREFUSED`, timeout, and HTTP status classes |
| minor | Use Session.Service, not standalone generator | Confirmed; `effectCmd(instance:false)` with `Session.Service` is the design |
