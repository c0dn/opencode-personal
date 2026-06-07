# Stats TUI Dashboard — Architecture

## Purpose

Replace `opencode stats` (slow terminal-print, no interactivity) with a fast,
interactive TUI dashboard built on OpenTUI + SolidJS. Inspired by `oc-stats`.

## Goals

- Fast: raw SQL queries against the opencode SQLite DB, no per-session fan-out
- Interactive: tabbed pages (overview, models, providers, heatmap, session search)
- Familiar: OpenTUI/SolidJS patterns matching the existing TUI codebase
- Self-contained: launches as a full-screen TUI from `opencode stats`

## Non-goals

- No server-side aggregation pipeline (unlike `packages/stats/core`)
- No real-time streaming of stats (snapshot on load, refresh on demand)
- No export/share features (not in v1)
- No pricing cache management (use `models.dev` data already in core)
- No geo/market-share breakdowns (no local data source)

## Critic review findings (resolved)

| Severity | Finding | Resolution |
|----------|---------|------------|
| major | Data source consistency | Document canonical sources per metric (see Data model section) |
| major | Raw SQL guardrails | All SQL behind `StatsRepository` with typed rows, parameterized Drizzle `sql`, COALESCE/null handling |
| major | TUI lifecycle | Use **internal plugin route** pattern, not standalone TUI |
| major | Route structure | Register as plugin route like `session.v2.messages`; tabs are component state |
| minor | Feature parity | Added trends, cache ratio, session cost distribution, project filter to plan |

## Current state

`src/cli/cmd/stats.ts` — 393 lines:
- Uses `Session.Service.messages()` per session in a fan-out loop
- `Effect.forEach(..., { concurrency: 20 })` — N sessions × M messages DB calls
- Outputs ASCII-art tables to stdout (OVERVIEW, COST & TOKENS, MODEL USAGE, TOOL USAGE)
- No interactivity beyond `--days`, `--tools`, `--models`, `--project` flags
- Slow for large datasets (1000+ sessions)

## Target architecture

### Data layer (`repository.ts`)

All SQL queries live behind a `StatsRepository` class with typed result rows.
Uses Drizzle's `sql` tagged template for parameterized queries — never string
interpolation. All `json_extract` uses `COALESCE` + `CAST` for null safety.

**Canonical data sources per metric:**

| Metric | Source | Why |
|--------|--------|-----|
| Total tokens, cost (overview) | `session.cost`, `session.tokens_*` columns | Pre-aggregated, fast |
| Per-model tokens, cost | `json_extract(message.data, ...)` | Not aggregated at session level |
| Per-provider tokens, cost | Same as per-model, grouped by provider | — |
| Tool usage counts | `json_extract(part.data, '$.tool')` | Individual part rows |
| Daily activity (heatmap) | `session.tokens_*` grouped by `date(time_updated/1000)` | Fast from indexed columns |
| Session list | `session` + `project` join | Direct table read |

**Reconciliation:** Overview totals from session columns are compared against
message-derived sums on load. If they differ by >1%, show a small "⚠" indicator.
This catches projector drift without blocking the UI.

```
┌─────────────────────────────────────────────────┐
│               opencode.db (SQLite)              │
│                                                 │
│  session table                                   │
│  - id, title, project_id, time_created, ...      │
│  - cost, tokens_input, tokens_output,            │
│    tokens_reasoning, tokens_cache_read/write     │
│                                                 │
│  message table                                   │
│  - session_id, data (JSON)                       │
│  - json_extract(data, '$.modelID')               │
│  - json_extract(data, '$.tokens.input') etc.     │
│                                                 │
│  part table                                      │
│  - session_id, data (JSON)                       │
│  - json_extract(data, '$.type') = 'tool'         │
│  - json_extract(data, '$.tool') = tool name      │
│                                                 │
│  project table                                   │
│  - id, name, worktree                            │
└──────────────┬──────────────────────────────────┘
               │ Drizzle sql`` tagged template
               ▼
┌──────────────────────────────┐
│  StatsRepository              │
│  - overview(cutoff)           │  → session columns
│  - modelUsage(cutoff)         │  → message.data JSON
│  - providerUsage(cutoff)      │  → message.data JSON (grouped)
│  - toolUsage(cutoff)          │  → part.data JSON
│  - dailyActivity(cutoff)      │  → session columns, date grouped
│  - sessionList(cutoff)        │  → session + project join
└──────────────┬───────────────┘
               │ typed StatsData
               ▼
         TUI components
```

**Key queries (via `sql` tagged template, parameterized):**

```sql
-- Per-message model usage (for model/provider breakdown)
SELECT
  COALESCE(CAST(json_extract(m.data, '$.providerID') AS TEXT), 'unknown') as provider_id,
  COALESCE(CAST(json_extract(m.data, '$.modelID') AS TEXT), 'unknown') as model_id,
  COALESCE(CAST(json_extract(m.data, '$.tokens.input') AS INTEGER), 0) as input_tokens,
  COALESCE(CAST(json_extract(m.data, '$.tokens.output') AS INTEGER), 0) as output_tokens,
  COALESCE(CAST(json_extract(m.data, '$.tokens.reasoning') AS INTEGER), 0) as reasoning_tokens,
  COALESCE(CAST(json_extract(m.data, '$.tokens.cache.read') AS INTEGER), 0) as cache_read,
  COALESCE(CAST(json_extract(m.data, '$.tokens.cache.write') AS INTEGER), 0) as cache_write,
  COALESCE(CAST(json_extract(m.data, '$.cost') AS REAL), 0) as cost
FROM message m
JOIN session s ON m.session_id = s.id
WHERE json_extract(m.data, '$.role') = 'assistant'
  AND s.parent_id IS NULL
  AND s.time_updated >= ?

-- Tool usage
SELECT
  COALESCE(CAST(json_extract(p.data, '$.tool') AS TEXT), 'unknown') as tool_name,
  COUNT(*) as count
FROM part p
JOIN session s ON p.session_id = s.id
WHERE json_extract(p.data, '$.type') = 'tool'
  AND json_extract(p.data, '$.state.status') IN ('completed', 'error')
  AND s.parent_id IS NULL
  AND s.time_updated >= ?
GROUP BY tool_name
ORDER BY count DESC

-- Daily activity (365-day heatmap) — uses pre-aggregated session columns
SELECT
  date(time_updated / 1000, 'unixepoch') as day,
  CAST(SUM(COALESCE(tokens_input, 0)
     + COALESCE(tokens_output, 0)
     + COALESCE(tokens_reasoning, 0)) AS INTEGER) as tokens
FROM session
WHERE parent_id IS NULL
  AND time_updated >= ?  -- 365 days ago
GROUP BY day
ORDER BY day
```

### Route (plugin route, not top-level)

Register stats as an **internal TUI plugin route** — same pattern as the
existing `session.v2.messages` debug route. This avoids adding a new top-level
route type and reuses the existing TUI lifecycle (renderer, keybindings, providers).

```
src/cli/cmd/tui/stats/
├── plugin.tsx          # register plugin route + StatsPage component
├── index.tsx           # StatsPage — top-level layout, tab bar, time range selector
├── overview.tsx        # Overview tab
├── models.tsx          # Models tab — per-model breakdown with bar chart
├── providers.tsx       # Providers tab — per-provider aggregation
├── heatmap.tsx         # 365-day activity heatmap (GitHub-style)
├── session-search.tsx  # Fuzzy search sessions, per-session drill-down
├── repository.ts       # StatsRepository — typed raw SQL queries via Drizzle
└── types.ts            # StatsData, TimeRange, Tab types
```

**Tabs are internal component state**, not separate routes. The plugin route has
a single `{ type: "plugin", plugin: "stats" }` route, and the StatsPage
component manages its own tab bar with SolidJS signals.

### Entry point: `opencode stats --tui`

Modify `src/cli/cmd/stats.ts` to launch the TUI when `--tui` flag is passed:

```typescript
export const StatsCommand = effectCmd({
  command: "stats",
  describe: "show token usage and cost statistics",
  builder: (yargs) =>
    yargs
      .option("tui", { type: "boolean", describe: "launch interactive TUI dashboard" }),
  handler: Effect.fn("Cli.stats")(function* (args) {
    if (args.tui) {
      // Launch existing TUI with initial route = stats plugin
      yield* launchStatsTUI()
      return
    }
    // Fallback: non-TTY mode, print to stdout (legacy behavior)
    yield* printStats(args.days, args.project)
  }),
})
```

`launchStatsTUI()` starts the normal TUI thread with an initial route pointing
to the stats plugin page. This reuses the existing renderer, SDK providers, and
cleanup lifecycle — no duplicate workers, no extra plugin bootstrap, no leak risk.

When launched from within an already-running TUI (e.g., keybinding), it just
navigates to the plugin route.

### Layout

```
┌─ Stats ── [All time ▼] ─── project: my-project ─────────────────────┐
│  Overview │ Models │ Providers │ Heatmap │ Sessions                   │
│                                                                       │
│  ┌── OVERVIEW ──────────────────────────────────────────────────────┐ │
│  │                                                                    │ │
│  │  Total Tokens      12.4M        Cost                  $42.18      │ │
│  │  ─ Input            6.1M        ─ Avg/day             $0.15       │ │
│  │  ─ Output           4.2M        Cost/1M tokens        $3.40       │ │
│  │  ─ Cache read       1.8M                                          │ │
│  │  ─ Cache write       0.3M       Sessions                247       │ │
│  │                                  Messages               4,821     │ │
│  │  Cache ratio         17%        Models Used               12      │ │
│  │                                  Active Days               89      │ │
│  │                                                                    │ │
│  │  ≈ 12 copies of the King James Bible                              │ │
│  │                                                                    │ │
│  │  Data: session aggregates  ⚠ 1.2% drift from message totals      │ │
│  └──────────────────────────────────────────────────────────────────┘ │
│                                                                       │
│  ┌── TOP MODELS ────────────────────────────────────────────────────┐ │
│  │  Model                     Cost     Tokens    Msgs  ████████████   │ │
│  │  ─────────────────────────────────────────────────────────────── │ │
│  │  claude-sonnet-4.5        $24.50    6.2M     2,100  ██████████░░  │ │
│  │  gpt-5                    $12.30    4.1M     1,800  ██████░░░░░░  │ │
│  │  deepseek-v4               $5.38    2.1M       921  ███░░░░░░░░░  │ │
│  └──────────────────────────────────────────────────────────────────┘ │
│                                                                       │
│  ┌── TOP TOOLS ─────────────────────────────────────────────────────┐ │
│  │  tool                       count  ████████████████████           │ │
│  │  ─────────────────────────────────────────────────────────────── │ │
│  │  read                      3,421  ████████████████████░░░░       │ │
│  │  write                     2,103  ████████████░░░░░░░░░░░░       │ │
│  │  bash                      1,892  ███████████░░░░░░░░░░░░░       │ │
│  └──────────────────────────────────────────────────────────────────┘ │
│                                                                       │
│  Tab/←→ tabs  1/2/3 range   ↑↓ scroll   q quit   / search            │
└──────────────────────────────────────────────────────────────────────┘
```

### Time range

| Key | Range |
|-----|-------|
| `1` | All time |
| `2` | Last 7 days |
| `3` | Last 30 days |
| `r` | Cycle through ranges |

### Session search

Fuzzy search all sessions (reuse `DialogSelect` pattern). Selecting a session
shows per-session stats:

- Session title, project, date range
- Total tokens, cost, messages
- Model breakdown for that session
- Tool usage for that session

### Heatmap

GitHub-style 365-day activity calendar. Each cell is a day, color intensity
represents token count:

```
        Jan              Feb              Mar       ...
  Mon  ░░░░░░░░░░░░░  ░░░░░░░░░░░░░░  ░░░░░░░░░░░░
  Tue  ░░░░░░░░░░░░░  ░░░░░░░░░░░░░░  ░░░░░░░░░░░░
  Wed  ░░░░░░░░░░░░░  ░░░░░░▓▓░░░░░░  ░░░░░░░░░░░░
  Thu  ░░░░░░░░░░░░░  ░░▓▓▓▓▓▓░░░░░░  ░░░░░░░░░░░░
  Fri  ░░░░░░░▓▓░░░░  ░░▓▓▓▓▓▓▓░░░░░  ░░░░░░░░░░░░
  Sat  ░░░░░░░░░░░░░  ░░░░░░░░░░░░░░  ░░░░░░░░░░░░
  Sun  ░░░░░░░░░░░░░  ░░░░░░░░░░░░░░  ░░░░░░░░░░░░
```

Use OpenTUI `box` elements with background color intensity. Five levels:
`░` empty, `▒` light, `▓` medium, `▓` heavy, `█` max.

### Keybindings

| Key | Action |
|-----|--------|
| `Tab` / `→` / `l` | Next tab |
| `←` / `h` | Previous tab |
| `↑` / `↓` / `j` / `k` | Scroll list (models, providers, sessions) |
| `1` / `2` / `3` | Time range: All / 7d / 30d |
| `r` | Cycle time range |
| `Enter` | Select session (in session search tab) |
| `/` | Focus search (in session search tab) |
| `q` / `Esc` | Quit stats, return to home or exit |

### Color palette

Borrow from the existing TUI theme:
- Primary text: white/bright
- Secondary text: dim/gray
- Accent: the existing TUI accent color
- Heatmap: 5-level green intensity
- Bar charts: use existing pipe/block characters with color

## Data model / state ownership

```
StatsData {
  overview: {
    totalTokens, inputTokens, outputTokens, cacheTokens,
    totalCost, sessions, messages, prompts,
    modelsUsed, activeDays, funComparison
  }
  modelUsage: Array<{ modelId, providerId, tokens { input, output }, cost, messages }>
  providerUsage: Array<{ providerId, tokens, cost, messages }>
  toolUsage: Array<{ name, count }>
  heatmap: Array<{ date, tokens }>  // 365 entries
  sessions: Array<{ id, title, project, tokens, cost, updated }>
}
```

State is loaded once via `createResource` when the stats page mounts.
Re-fetched when time range changes.

## Implementation phases

### Phase 1: Data layer (`repository.ts`)
- Implement `StatsRepository` with parameterized Drizzle `sql` queries
- `overview()`, `modelUsage()`, `providerUsage()`, `toolUsage()`, `dailyActivity()`, `sessionList()`
- COALESCE + CAST null safety on all `json_extract` paths
- Reconciliation check: session aggregates vs message-derived sums
- Build typed `StatsData` from raw rows
- Unit tests with test DB fixtures

### Phase 2: Plugin route + entry point
- Register stats as internal TUI plugin route (like `session.v2.messages`)
- Add `--tui` flag to `opencode stats`
- `launchStatsTUI()` reuses existing TUI thread with initial stats route
- Legacy print-to-stdout path preserved for non-TTY / `--json`
- Basic page shell with tab bar (Overview | Models | Providers | Heatmap | Sessions)
- Loading state with spinner (using `createResource`)

### Phase 3: Overview page
- Render overview card: total tokens, cost, sessions, messages, prompts, models used, active days
- Cache read/write ratio display
- Cost per day / tokens per session
- Token comparison fun text (≈ copies of King James Bible)
- Date range indicator + last-updated timestamp

### Phase 4: Models + Providers pages
- Scrollable list with horizontal bar chart visualization
- Sort by tokens or cost (toggle with key)
- Show provider, model name, token counts, cost, message count, percentage
- Models tab: per-model breakdown
- Providers tab: grouped by provider, with per-model drill-down on Enter

### Phase 5: Heatmap
- 365-day GitHub-style activity calendar
- 53 columns × 7 rows grid using `<box>` with backgroundColor
- Month labels, weekday labels, legend
- Focused-day detail panel (date + tokens) on hover/select
- Five intensity levels based on quantiles

### Phase 6: Session search
- Fuzzy search all sessions (reuse `DialogSelect` pattern)
- Per-session drill-down: title, project, date range, tokens, cost, models, tools
- Navigable by arrow keys, Enter to select, Esc to go back

### Phase 7: Polish
- Date range selector (All / 7d / 30d) with `1`/`2`/`3`/`r` keys
- Project filter (current project or all)
- Keybinding help bar
- No-data and loading states
- Error state (DB not found, permission denied)

## Risks and tradeoffs

1. **Raw SQL vs Drizzle ORM**: Using raw SQL bypasses type safety but is necessary for `json_extract`. All queries are read-only, parameterized, and behind a typed `StatsRepository` facade that returns typed rows. COALESCE + CAST on every `json_extract` path.
2. **Plugin route lifecycle**: Reusing the existing TUI thread means stats inherits all app providers (SDK, sync, plugins). This is intentional — no duplicate renderer/window to leak. The stats plugin does not subscribe to session events or modify state.
3. **Data consistency**: Session aggregates may drift from message-level sums if the projector misses updates. The UI shows a ⚠ indicator when drift >1%. Not a correctness issue since both sources are from the same DB transaction log.
4. **Time range filter**: Queries use `time_updated` from session table. Sessions with NULL or 0 timestamps are filtered out by the `WHERE ... >= ?` clause.
5. **Large datasets**: For 10k+ sessions, JSON extraction across all messages may be slow. The message query already filters by `time_updated >= cutoff`. For all-time views, consider a `LIMIT` with "showing top N" note.

## Open questions

1. ~Launch mode: standalone TUI or integrated?~
   - **Resolved**: Plugin route pattern. `opencode stats --tui` launches the existing TUI with initial stats route.
2. ~Cost calculation: stored vs recomputed?~
   - **Resolved**: Use stored `session.cost` for speed. Show option to re-estimate with `models.dev` pricing (via keybinding).
3. Legacy mode: should `opencode stats` without `--tui` still print to stdout?
   - **Decision**: Yes. Keep `--days`, `--models`, `--tools`, `--project`, `--json` flags for machine/pipe use. `--tui` flag is new.
4. Heatmap cell rendering: `<box>` with backgroundColor vs Unicode block characters?
   - **Decision**: Start with Unicode block characters (`░▒▓█`) in a fixed grid using `<text>`. Simpler than managing hundreds of `<box>` elements. Switch to `<box>` if performance issues arise at scale.
