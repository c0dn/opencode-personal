/**
 * Stats TUI Plugin — internal plugin that registers the "stats" route.
 */

import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { InternalTuiPlugin } from "../plugin/internal"
import type { JSX } from "@opentui/solid"
import { createResource, createSignal, Match, Show, Switch, For } from "solid-js"
import { loadStatsCache } from "./bridge"
import type { StatsData } from "./types"

const id = "internal:stats"
const route = "stats"

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
  const [data] = createResource(loadStatsCache)
  const [tab, setTab] = createSignal<string>("overview")

  return (
    <box flexDirection="column" width="100%" height="100%">
      <box flexDirection="row" paddingLeft={1} paddingRight={1} borderStyle="single">
        <Tabs active={tab()} onChange={setTab} />
        <box flexGrow={1} />
        <text>q quit  Tab switch</text>
      </box>

      <box flexDirection="column" flexGrow={1} paddingLeft={1} paddingRight={1}>
        <Show when={!data.loading} fallback={<text>Loading stats...</text>}>
          <Show when={data()} fallback={<text>No stats data found</text>}>
            {(stats) => (
              <Switch>
                <Match when={tab() === "overview"}>
                  <OverviewTab data={stats()} />
                </Match>
                <Match when={tab() === "models"}>
                  <ModelsTab data={stats()} />
                </Match>
                <Match when={tab() === "providers"}>
                  <ProvidersTab data={stats()} />
                </Match>
                <Match when={tab() === "heatmap"}>
                  <HeatmapTab data={stats()} />
                </Match>
                <Match when={tab() === "sessions"}>
                  <SessionsTab data={stats()} />
                </Match>
              </Switch>
            )}
          </Show>
        </Show>
      </box>
    </box>
  )
}

function Tabs(props: { active: string; onChange: (t: string) => void }) {
  const tabs = ["overview", "models", "providers", "heatmap", "sessions"]
  return (
    <box flexDirection="row" gap={2}>
      <For each={tabs}>
        {(t) => (
          <text>{t === props.active ? `[${label(t)}]` : ` ${label(t)} `}</text>
        )}
      </For>
    </box>
  )
}

// ── Overview ──────────────────────────────────────────────────────────

function OverviewTab(props: { data: StatsData }): JSX.Element {
  const o = props.data.overview
  /* prettier-ignore */
  return (
    <box flexDirection="column" paddingTop={1} gap={1}>
      <text>=== OVERVIEW ===</text>
      <text> </text>
      <text>Total Tokens:  {fmt(o.totalTokens)}</text>
      <text>  Input:       {fmt(o.inputTokens)}</text>
      <text>  Output:      {fmt(o.outputTokens)}</text>
      <text>  Reasoning:   {fmt(o.reasoningTokens)}</text>
      <text>  Cache Read:  {fmt(o.cacheReadTokens)}</text>
      <text>  Cache Write: {fmt(o.cacheWriteTokens)}</text>
      <text> </text>
      <text>Total Cost:    ${o.totalCost.toFixed(2)}</text>
      <text>Sessions:      {o.sessions}</text>
      <text>Messages:      {o.messages}</text>
      <text>Models Used:   {o.modelsUsed}</text>
      <text>Active Days:   {o.activeDays}</text>
      {props.data.aggregateDrift && (
        <text>  drift: {props.data.driftPercent.toFixed(1)}% from message sums</text>
      )}
    </box>
  )
}

// ── Models ────────────────────────────────────────────────────────────

function ModelsTab(props: { data: StatsData }): JSX.Element {
  const maxTokens = props.data.models[0]
    ? props.data.models[0].inputTokens + props.data.models[0].outputTokens
    : 1
  return (
    <box flexDirection="column" paddingTop={1} gap={1}>
      <text>=== MODEL USAGE ===</text>
      <text> </text>
      <For each={props.data.models.slice(0, 20)}>
        {(m) => {
          const total = m.inputTokens + m.outputTokens
          const w = Math.max(1, Math.round((total / maxTokens) * 20))
          return (
            <text>
              {pad(m.modelId, 30)} ${m.cost.toFixed(2).padStart(8)} {fmt(total).padStart(10)} {String(m.messageCount).padStart(5)} msgs {bar(w)}
            </text>
          )
        }}
      </For>
    </box>
  )
}

// ── Providers ─────────────────────────────────────────────────────────

function ProvidersTab(props: { data: StatsData }): JSX.Element {
  const groups = new Map<string, { tokens: number; cost: number; messages: number }>()
  for (const m of props.data.models) {
    const p = groups.get(m.providerId) ?? { tokens: 0, cost: 0, messages: 0 }
    p.tokens += m.inputTokens + m.outputTokens
    p.cost += m.cost
    p.messages += m.messageCount
    groups.set(m.providerId, p)
  }
  const sorted = [...groups.entries()].sort((a, b) => b[1].tokens - a[1].tokens)
  const maxTokens = sorted[0]?.[1].tokens ?? 1

  return (
    <box flexDirection="column" paddingTop={1} gap={1}>
      <text>=== PROVIDER USAGE ===</text>
      <text> </text>
      <For each={sorted}>
        {([name, p]) => {
          const w = Math.max(1, Math.round((p.tokens / maxTokens) * 20))
          return (
            <text>
              {pad(name, 20)} ${p.cost.toFixed(2).padStart(8)} {fmt(p.tokens).padStart(10)} {String(p.messages).padStart(5)} msgs {bar(w)}
            </text>
          )
        }}
      </For>
    </box>
  )
}

// ── Heatmap ───────────────────────────────────────────────────────────

function HeatmapTab(props: { data: StatsData }): JSX.Element {
  const activeDays = props.data.heatmap.filter((d) => d.tokens > 0).length
  const maxTokens = Math.max(1, ...props.data.heatmap.map((d) => d.tokens))
  const chars = ["░", "▒", "▓", "█"]

  return (
    <box flexDirection="column" paddingTop={1} gap={1}>
      <text>=== ACTIVITY HEATMAP ===</text>
      <text>{activeDays} active days / {props.data.heatmap.length} total</text>
      <text> </text>
      <For each={props.data.heatmap.slice(-90)}>
        {(d) => {
          const level = d.tokens > 0 ? Math.min(chars.length - 1, Math.floor((d.tokens / maxTokens) * chars.length)) : 0
          return (
            <text>
              {d.day}  {chars[level]!.repeat(Math.max(1, Math.round((d.tokens / maxTokens) * 30)))}  {fmt(d.tokens)}
            </text>
          )
        }}
      </For>
    </box>
  )
}

// ── Sessions ──────────────────────────────────────────────────────────

function SessionsTab(props: { data: StatsData }): JSX.Element {
  return (
    <box flexDirection="column" paddingTop={1} gap={1}>
      <text>=== SESSIONS ({props.data.sessions.length}) ===</text>
      <text> </text>
      <For each={props.data.sessions.slice(0, 30)}>
        {(s) => (
          <text>
            {pad(s.title, 50)} {fmt(s.tokens)} tokens  ${s.cost.toFixed(2)}
          </text>
        )}
      </For>
    </box>
  )
}

// ── Helpers ───────────────────────────────────────────────────────────

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function pad(s: string, len: number): string {
  return s.length >= len ? s : s + " ".repeat(len - s.length)
}

function bar(w: number): string {
  return "\u2588".repeat(w)
}

function label(t: string): string {
  return t.charAt(0).toUpperCase() + t.slice(1)
}

// ── Plugin export ─────────────────────────────────────────────────────

const plugin: InternalTuiPlugin = {
  id,
  tui,
}

export default plugin
