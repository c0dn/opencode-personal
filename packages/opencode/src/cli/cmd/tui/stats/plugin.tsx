/**
 * Stats TUI Plugin — internal plugin that registers the "stats" route.
 *
 * Renders a polished, keyboard-navigable stats dashboard (OpenTUI + SolidJS).
 * The stats process is launched standalone via
 * `opencode --route '{"type":"plugin","id":"stats"}'`, so quitting the route
 * exits the whole app via the Exit context.
 */

import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { InternalTuiPlugin } from "../plugin/internal"
import type { JSX } from "@opentui/solid"
import type { RGBA, ScrollBoxRenderable } from "@opentui/core"
import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createResource, createSignal, For, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { loadStatsCache } from "./bridge"
import type { OverviewStats, StatsData, TimeRange } from "./types"
import type { UsageRow } from "./format"
import { buildCalendar, cell, clamp, fmt, glyph, modelRows, money, num, providerRows, relativeTime } from "./format"
import { selectedForeground, tint, useTheme } from "../context/theme"
import { useExit } from "../context/exit"
import { useBindings, useOpencodeModeStack } from "../keymap"
import { getScrollAcceleration } from "../util/scroll"

const id = "internal:stats"
const route = "stats"

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "models", label: "Models" },
  { id: "providers", label: "Providers" },
  { id: "heatmap", label: "Heatmap" },
  { id: "sessions", label: "Sessions" },
] as const
type TabId = (typeof TABS)[number]["id"]

// Time ranges cycled by `r`, in order. Each is precomputed in the cache.
const RANGES: TimeRange[] = ["all", "7d", "30d"]

// Dedicated keymap mode so single-key stats bindings (1–5, j/k, h/l, r) win
// over always-active base-mode app bindings such as Tab → agent.cycle.
const STATS_MODE = "stats"

// Shared table column widths (monospace cells, padded for alignment).
const RANK_W = 4
const NAME_W = 24
const SUB_W = 13
const COST_W = 9
const TOK_W = 9
const MSG_W = 6
const PROJ_W = 16
const TIME_W = 10

type ThemeView = ReturnType<typeof useTheme>["theme"]
type TermSize = ReturnType<typeof useTerminalDimensions>
type SetScroll = (el: ScrollBoxRenderable | undefined) => void

function tui(api: TuiPluginApi) {
  api.route.register([
    {
      name: route,
      render: () => StatsPage({ api }),
    },
  ])
  return Promise.resolve()
}

function StatsPage(props: { api: TuiPluginApi }): JSX.Element {
  const [cache] = createResource(loadStatsCache)
  const { theme } = useTheme()
  const exit = useExit()
  const term = useTerminalDimensions()
  const modeStack = useOpencodeModeStack()
  const [tab, setTab] = createSignal<TabId>("overview")
  const [range, setRange] = createSignal<TimeRange>("all")

  // Adopt the range chosen on the CLI (`--range`) once the cache loads.
  let rangeInitialized = false
  createEffect(() => {
    const loaded = cache()
    if (!loaded || rangeInitialized) return
    rangeInitialized = true
    setRange(loaded.initialRange)
  })

  // Active dataset for the selected range. All ranges are precomputed, so
  // switching with `r` never re-queries the database.
  const active = createMemo(() => cache()?.ranges[range()])

  // The active scrollable tab registers its scrollbox here so the key
  // bindings can drive it. Only one tab is mounted at a time.
  let scroll: ScrollBoxRenderable | undefined
  const setScroll: SetScroll = (el) => {
    scroll = el
  }
  const selectTab = (next: TabId) => {
    scroll = undefined
    setTab(next)
  }
  const cycle = (direction: number) => {
    const index = TABS.findIndex((entry) => entry.id === tab())
    selectTab(TABS[(index + direction + TABS.length) % TABS.length]!.id)
  }
  const cycleRange = () => {
    const index = RANGES.indexOf(range())
    setRange(RANGES[(index + 1) % RANGES.length]!)
  }
  const scrollBy = (delta: number) => {
    scroll?.scrollBy(delta)
  }

  // Stats owns a dedicated keymap mode so its bindings deactivate the
  // always-active base-mode app bindings (e.g. Tab → agent.cycle). Mirrors
  // routes/session/question.tsx.
  onMount(() => {
    const popMode = modeStack.push(STATS_MODE)
    onCleanup(popMode)
  })

  // Drive input through the app's keymap (the proven mechanism used by every
  // other route/dialog), not the raw keyInput emitter that useKeyboard hooks —
  // that listener never wins because the keymap host consumes events first.
  useBindings(() => ({
    mode: STATS_MODE,
    bindings: [
      { key: "q", desc: "Quit", group: "Stats", cmd: () => void exit() },
      { key: "escape", desc: "Quit", group: "Stats", cmd: () => void exit() },
      { key: "ctrl+c", desc: "Quit", group: "Stats", cmd: () => void exit() },
      { key: "ctrl+d", desc: "Quit", group: "Stats", cmd: () => void exit() },
      ...TABS.map((entry, index) => ({
        key: String(index + 1),
        desc: entry.label,
        group: "Stats",
        cmd: () => selectTab(entry.id),
      })),
      { key: "tab", desc: "Next tab", group: "Stats", cmd: () => cycle(1) },
      { key: "shift+tab", desc: "Previous tab", group: "Stats", cmd: () => cycle(-1) },
      { key: "l", desc: "Next tab", group: "Stats", cmd: () => cycle(1) },
      { key: "right", desc: "Next tab", group: "Stats", cmd: () => cycle(1) },
      { key: "h", desc: "Previous tab", group: "Stats", cmd: () => cycle(-1) },
      { key: "left", desc: "Previous tab", group: "Stats", cmd: () => cycle(-1) },
      { key: "j", desc: "Scroll down", group: "Stats", cmd: () => scrollBy(2) },
      { key: "down", desc: "Scroll down", group: "Stats", cmd: () => scrollBy(2) },
      { key: "k", desc: "Scroll up", group: "Stats", cmd: () => scrollBy(-2) },
      { key: "up", desc: "Scroll up", group: "Stats", cmd: () => scrollBy(-2) },
      { key: "r", desc: "Cycle range", group: "Stats", cmd: () => cycleRange() },
    ],
  }))

  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor={theme.background}>
      <Header overview={active()?.overview} range={range()} />
      <Show when={!cache.loading} fallback={<Centered>Loading…</Centered>}>
        <Show when={active()} fallback={<Centered>No stats data found.</Centered>}>
          {(stats) => (
            <>
              <TabBar active={tab()} onSelect={selectTab} />
              <box flexGrow={1} minHeight={0} flexDirection="column" paddingLeft={1} paddingRight={1}>
                <Switch>
                  <Match when={tab() === "overview"}>
                    <OverviewTab data={stats()} term={term} setScroll={setScroll} />
                  </Match>
                  <Match when={tab() === "models"}>
                    <UsageTable
                      rows={modelRows(stats().models)}
                      nameLabel="Model"
                      subLabel="Provider"
                      term={term}
                      setScroll={setScroll}
                    />
                  </Match>
                  <Match when={tab() === "providers"}>
                    <UsageTable
                      rows={providerRows(stats().models)}
                      nameLabel="Provider"
                      subLabel="Models"
                      term={term}
                      setScroll={setScroll}
                    />
                  </Match>
                  <Match when={tab() === "heatmap"}>
                    <HeatmapTab data={stats()} term={term} setScroll={setScroll} />
                  </Match>
                  <Match when={tab() === "sessions"}>
                    <SessionsTab data={stats()} term={term} setScroll={setScroll} />
                  </Match>
                </Switch>
              </box>
            </>
          )}
        </Show>
      </Show>
      <Footer />
    </box>
  )
}

// ── Chrome ────────────────────────────────────────────────────────────

function Header(props: { overview?: OverviewStats; range: TimeRange }): JSX.Element {
  const { theme } = useTheme()
  return (
    <box
      flexDirection="row"
      justifyContent="space-between"
      alignItems="center"
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
      border={["bottom"]}
      borderColor={theme.border}
    >
      <text wrapMode="none">
        <span style={{ fg: theme.accent, bold: true }}>opencode</span>
        <span style={{ fg: theme.textMuted }}> · stats · </span>
        <span style={{ fg: theme.text, bold: true }}>{props.range}</span>
      </text>
      <Show when={props.overview}>
        {(overview) => (
          <text wrapMode="none">
            <span style={{ fg: theme.textMuted }}>cost </span>
            <span style={{ fg: theme.success, bold: true }}>{money(overview().totalCost)}</span>
            <span style={{ fg: theme.textMuted }}>   tokens </span>
            <span style={{ fg: theme.text, bold: true }}>{fmt(overview().totalTokens)}</span>
            <span style={{ fg: theme.textMuted }}>   sessions </span>
            <span style={{ fg: theme.text, bold: true }}>{String(overview().sessions)}</span>
          </text>
        )}
      </Show>
    </box>
  )
}

function TabBar(props: { active: TabId; onSelect: (id: TabId) => void }): JSX.Element {
  const { theme } = useTheme()
  return (
    <box flexDirection="row" gap={1} paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
      <For each={TABS}>
        {(entry, index) => {
          const active = () => entry.id === props.active
          return (
            <box
              paddingLeft={1}
              paddingRight={1}
              backgroundColor={active() ? theme.accent : undefined}
              onMouseUp={() => props.onSelect(entry.id)}
            >
              <text wrapMode="none">
                <span style={{ fg: active() ? selectedForeground(theme, theme.accent) : theme.accent, bold: true }}>
                  {index() + 1}
                </span>
                <span
                  style={{ fg: active() ? selectedForeground(theme, theme.accent) : theme.textMuted, bold: active() }}
                >
                  {" " + entry.label}
                </span>
              </text>
            </box>
          )
        }}
      </For>
    </box>
  )
}

function Footer(): JSX.Element {
  const { theme } = useTheme()
  return (
    <box
      flexDirection="row"
      gap={2}
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
      border={["top"]}
      borderColor={theme.border}
    >
      <Hint keys="1–5" label="tabs" />
      <Hint keys="tab / h l" label="switch" />
      <Hint keys="↑↓ / j k" label="scroll" />
      <Hint keys="r" label="range" />
      <Hint keys="q" label="quit" />
    </box>
  )
}

function Hint(props: { keys: string; label: string }): JSX.Element {
  const { theme } = useTheme()
  return (
    <text wrapMode="none">
      <span style={{ fg: theme.accent, bold: true }}>{props.keys}</span>
      <span style={{ fg: theme.textMuted }}>{" " + props.label}</span>
    </text>
  )
}

function Centered(props: { children: JSX.Element }): JSX.Element {
  const { theme } = useTheme()
  return (
    <box flexGrow={1} minHeight={0} alignItems="center" justifyContent="center">
      <text fg={theme.textMuted}>{props.children}</text>
    </box>
  )
}

function ScrollRegion(props: { setScroll: SetScroll; children: JSX.Element }): JSX.Element {
  return (
    <scrollbox
      ref={(el: ScrollBoxRenderable) => props.setScroll(el)}
      flexGrow={1}
      scrollAcceleration={getScrollAcceleration()}
      verticalScrollbarOptions={{ visible: false }}
      horizontalScrollbarOptions={{ visible: false }}
    >
      {props.children}
    </scrollbox>
  )
}

// ── Overview ──────────────────────────────────────────────────────────

function OverviewTab(props: { data: StatsData; term: TermSize; setScroll: SetScroll }): JSX.Element {
  const { theme } = useTheme()
  // Reactive so cycling the time range (`r`) re-renders the cards in place.
  const o = createMemo(() => props.data.overview)
  const breakdownMax = createMemo(() =>
    Math.max(
      1,
      o().inputTokens,
      o().outputTokens,
      o().reasoningTokens,
      o().cacheReadTokens,
      o().cacheWriteTokens,
    ),
  )
  const barWidth = createMemo(() => clamp(props.term().width - 40, 10, 36))
  return (
    <box flexDirection="column" flexGrow={1} minHeight={0}>
      <ScrollRegion setScroll={props.setScroll}>
        <box flexDirection="column" gap={1} paddingTop={1} paddingBottom={1}>
          <box flexDirection="row" gap={1}>
            <Card title="Cost" grow>
              <text attributes={TextAttributes.BOLD} fg={theme.accent}>
                {money(o().totalCost)}
              </text>
              <text fg={theme.textMuted}>total spend</text>
              <text wrapMode="none">
                <span style={{ fg: theme.textMuted }}>{cell("avg / session", 14)}</span>
                <span style={{ fg: theme.text }}>{money(o().sessions > 0 ? o().totalCost / o().sessions : 0)}</span>
              </text>
            </Card>
            <Card title="Tokens" grow>
              <text attributes={TextAttributes.BOLD} fg={theme.accent}>
                {fmt(o().totalTokens)}
              </text>
              <text fg={theme.textMuted}>total tokens</text>
              <text wrapMode="none">
                <span style={{ fg: theme.textMuted }}>in </span>
                <span style={{ fg: theme.text }}>{fmt(o().inputTokens)}</span>
                <span style={{ fg: theme.textMuted }}>{"   out "}</span>
                <span style={{ fg: theme.text }}>{fmt(o().outputTokens)}</span>
              </text>
            </Card>
            <Card title="Activity" grow>
              <StatRow label="Sessions" value={o().sessions} />
              <StatRow label="Messages" value={o().messages} />
              <StatRow label="Models used" value={o().modelsUsed} />
              <StatRow label="Active days" value={o().activeDays} />
            </Card>
          </box>
          <Card title="Token Breakdown">
            <BreakdownRow
              label="Input"
              value={o().inputTokens}
              max={breakdownMax()}
              width={barWidth()}
              color={theme.info}
            />
            <BreakdownRow
              label="Output"
              value={o().outputTokens}
              max={breakdownMax()}
              width={barWidth()}
              color={theme.success}
            />
            <BreakdownRow
              label="Reasoning"
              value={o().reasoningTokens}
              max={breakdownMax()}
              width={barWidth()}
              color={theme.secondary}
            />
            <BreakdownRow
              label="Cache read"
              value={o().cacheReadTokens}
              max={breakdownMax()}
              width={barWidth()}
              color={theme.accent}
            />
            <BreakdownRow
              label="Cache write"
              value={o().cacheWriteTokens}
              max={breakdownMax()}
              width={barWidth()}
              color={theme.warning}
            />
          </Card>
          <Show when={props.data.aggregateDrift}>
            <box paddingLeft={1}>
              <text wrapMode="none">
                <span style={{ fg: theme.warning, bold: true }}>⚠ drift  </span>
                <span style={{ fg: theme.textMuted }}>session totals differ from message sums by </span>
                <span style={{ fg: theme.warning }}>{props.data.driftPercent.toFixed(1)}%</span>
              </text>
            </box>
          </Show>
        </box>
      </ScrollRegion>
    </box>
  )
}

function Card(props: { title: string; grow?: boolean; children: JSX.Element }): JSX.Element {
  const { theme } = useTheme()
  // `grow` distributes width across the 3-card row. The full-width Token
  // Breakdown card omits it so it sizes to its content height in the column
  // scroll container (flexGrow+flexBasis:0 there would collapse it to ~0 height).
  return (
    <box
      flexDirection="column"
      flexGrow={props.grow ? 1 : undefined}
      flexBasis={props.grow ? 0 : undefined}
      minWidth={props.grow ? 0 : undefined}
      gap={1}
      borderStyle="single"
      borderColor={theme.border}
      title={props.title}
      titleAlignment="center"
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
    >
      {props.children}
    </box>
  )
}

function StatRow(props: { label: string; value: string | number }): JSX.Element {
  const { theme } = useTheme()
  return (
    <text wrapMode="none">
      <span style={{ fg: theme.textMuted }}>{cell(props.label, 13)}</span>
      <span style={{ fg: theme.text, bold: true }}>{String(props.value)}</span>
    </text>
  )
}

function BreakdownRow(props: { label: string; value: number; max: number; width: number; color: RGBA }): JSX.Element {
  const { theme } = useTheme()
  const filled = props.value > 0 ? clamp(Math.round((props.value / props.max) * props.width), 1, props.width) : 0
  return (
    <text wrapMode="none">
      <span style={{ fg: theme.textMuted }}>{cell(props.label, 13)}</span>
      <span style={{ fg: theme.text }}>{num(fmt(props.value), 9)}</span>
      <span style={{ fg: props.color }}>{"  " + "█".repeat(filled)}</span>
      <span style={{ fg: theme.borderSubtle }}>{"░".repeat(props.width - filled)}</span>
    </text>
  )
}

// ── Models / Providers ────────────────────────────────────────────────

function UsageTable(props: {
  rows: UsageRow[]
  nameLabel: string
  subLabel: string
  term: TermSize
  setScroll: SetScroll
}): JSX.Element {
  const { theme } = useTheme()
  const max = createMemo(() => Math.max(1, props.rows[0]?.tokens ?? 1))
  const barWidth = createMemo(() => clamp(props.term().width - 71, 6, 24))
  return (
    <box flexDirection="column" flexGrow={1} minHeight={0}>
      <text wrapMode="none">
        <span style={{ fg: theme.textMuted, bold: true }}>{cell("#", RANK_W)}</span>
        <span style={{ fg: theme.textMuted, bold: true }}>{cell(props.nameLabel, NAME_W)}</span>
        <span style={{ fg: theme.textMuted, bold: true }}>{cell(props.subLabel, SUB_W)}</span>
        <span style={{ fg: theme.textMuted, bold: true }}>{num("Cost", COST_W)}</span>
        <span style={{ fg: theme.textMuted, bold: true }}>{num("Tokens", TOK_W)}</span>
        <span style={{ fg: theme.textMuted, bold: true }}>{num("Msgs", MSG_W)}</span>
        <span style={{ fg: theme.textMuted, bold: true }}>{"  Usage"}</span>
      </text>
      <ScrollRegion setScroll={props.setScroll}>
        <Show when={props.rows.length > 0} fallback={<text fg={theme.textMuted}>No usage recorded.</text>}>
          <For each={props.rows}>
            {(row, index) => {
              const filled = row.tokens > 0 ? clamp(Math.round((row.tokens / max()) * barWidth()), 1, barWidth()) : 0
              return (
                <text wrapMode="none">
                  <span style={{ fg: theme.textMuted }}>{cell(`${index() + 1}.`, RANK_W)}</span>
                  <span style={{ fg: theme.text }}>{cell(row.name, NAME_W)}</span>
                  <span style={{ fg: theme.textMuted }}>{cell(row.sub, SUB_W)}</span>
                  <span style={{ fg: costColor(theme, row.cost) }}>{num(money(row.cost), COST_W)}</span>
                  <span style={{ fg: theme.text }}>{num(fmt(row.tokens), TOK_W)}</span>
                  <span style={{ fg: theme.textMuted }}>{num(String(row.messages), MSG_W)}</span>
                  <span style={{ fg: theme.accent }}>{" " + "█".repeat(filled)}</span>
                  <span style={{ fg: theme.borderSubtle }}>{"░".repeat(barWidth() - filled)}</span>
                </text>
              )
            }}
          </For>
        </Show>
      </ScrollRegion>
    </box>
  )
}

// ── Heatmap ───────────────────────────────────────────────────────────

function HeatmapTab(props: { data: StatsData; term: TermSize; setScroll: SetScroll }): JSX.Element {
  const { theme } = useTheme()
  const activeDays = createMemo(() => props.data.heatmap.filter((day) => day.tokens > 0).length)
  const calendar = createMemo(() => buildCalendar(props.data.heatmap, props.term().width - 6))
  const ramp = createMemo<RGBA[]>(() => [
    theme.borderSubtle,
    tint(theme.textMuted, theme.accent, 0),
    tint(theme.textMuted, theme.accent, 1 / 3),
    tint(theme.textMuted, theme.accent, 2 / 3),
    theme.accent,
  ])
  const cellColor = (level: number) => ramp()[Math.max(0, level)] ?? theme.borderSubtle

  return (
    <box flexDirection="column" flexGrow={1} minHeight={0}>
      <ScrollRegion setScroll={props.setScroll}>
        <Show when={calendar()} fallback={<text fg={theme.textMuted}>No activity recorded yet.</text>}>
          {(cal) => (
            <box flexDirection="column" paddingTop={1}>
              <text fg={theme.textMuted} wrapMode="none">
                {cal().monthRow}
              </text>
              <For each={cal().weekdays}>
                {(weekday) => (
                  <box flexDirection="row">
                    <text fg={theme.textMuted} wrapMode="none">
                      {weekday.label}
                    </text>
                    <For each={weekday.runs}>
                      {(run) => (
                        <text fg={cellColor(run.level)} wrapMode="none">
                          {glyph(run.level).repeat(run.count)}
                        </text>
                      )}
                    </For>
                  </box>
                )}
              </For>
              <box flexDirection="row" gap={2} paddingTop={1}>
                <text fg={theme.textMuted} wrapMode="none">
                  {activeDays()} active days
                </text>
                <box flexDirection="row" gap={1} alignItems="center">
                  <text fg={theme.textMuted}>Less</text>
                  <box flexDirection="row">
                    <For each={[0, 1, 2, 3, 4]}>
                      {(level) => (
                        <text fg={cellColor(level)} wrapMode="none">
                          {glyph(level)}
                        </text>
                      )}
                    </For>
                  </box>
                  <text fg={theme.textMuted}>More</text>
                </box>
              </box>
            </box>
          )}
        </Show>
      </ScrollRegion>
    </box>
  )
}

// ── Sessions ──────────────────────────────────────────────────────────

function SessionsTab(props: { data: StatsData; term: TermSize; setScroll: SetScroll }): JSX.Element {
  const { theme } = useTheme()
  const rows = createMemo(() => props.data.sessions.slice(0, 30))
  const titleWidth = createMemo(() =>
    clamp(props.term().width - (PROJ_W + TOK_W + COST_W + MSG_W + TIME_W) - 8, 16, 48),
  )
  return (
    <box flexDirection="column" flexGrow={1} minHeight={0}>
      <text wrapMode="none">
        <span style={{ fg: theme.textMuted, bold: true }}>{cell("Session", titleWidth())}</span>
        <span style={{ fg: theme.textMuted, bold: true }}>{cell("Project", PROJ_W)}</span>
        <span style={{ fg: theme.textMuted, bold: true }}>{num("Tokens", TOK_W)}</span>
        <span style={{ fg: theme.textMuted, bold: true }}>{num("Cost", COST_W)}</span>
        <span style={{ fg: theme.textMuted, bold: true }}>{num("Msgs", MSG_W)}</span>
        <span style={{ fg: theme.textMuted, bold: true }}>{num("Updated", TIME_W)}</span>
      </text>
      <ScrollRegion setScroll={props.setScroll}>
        <Show when={rows().length > 0} fallback={<text fg={theme.textMuted}>No sessions recorded.</text>}>
          <For each={rows()}>
            {(session) => (
              <text wrapMode="none">
                <span style={{ fg: theme.text }}>{cell(session.title || "(untitled)", titleWidth())}</span>
                <span style={{ fg: theme.textMuted }}>{cell(session.projectName ?? "—", PROJ_W)}</span>
                <span style={{ fg: theme.text }}>{num(fmt(session.tokens), TOK_W)}</span>
                <span style={{ fg: costColor(theme, session.cost) }}>{num(money(session.cost), COST_W)}</span>
                <span style={{ fg: theme.textMuted }}>{num(String(session.messageCount), MSG_W)}</span>
                <span style={{ fg: theme.textMuted }}>{num(relativeTime(session.timeUpdated), TIME_W)}</span>
              </text>
            )}
          </For>
        </Show>
      </ScrollRegion>
    </box>
  )
}

// ── Helpers ───────────────────────────────────────────────────────────

function costColor(theme: ThemeView, cost: number): RGBA {
  if (cost >= 5) return theme.warning
  if (cost > 0) return theme.success
  return theme.textMuted
}

// ── Plugin export ─────────────────────────────────────────────────────

const plugin: InternalTuiPlugin = {
  id,
  tui,
}

export default plugin
