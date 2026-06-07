/**
 * Pure formatting, aggregation, and heatmap-math helpers for the stats dashboard.
 *
 * This module deliberately has NO OpenTUI or SolidJS imports so it can be unit
 * tested in isolation. It may only depend on TypeScript types from `./types`.
 */

import type { DailyActivity, ModelUsageRow } from "./types"

/** Normalized table row shared by the Models and Providers tables. */
export type UsageRow = { name: string; sub: string; cost: number; tokens: number; messages: number }

/** Run-length-encoded segment of equal-intensity heatmap cells. */
export type CalRun = { level: number; count: number }

/** Computed GitHub-style calendar grid for the heatmap tab. */
export type Calendar = { weeks: number; monthRow: string; weekdays: Array<{ label: string; runs: CalRun[] }> }

export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
export const GLYPHS = ["·", "░", "▒", "▓", "█"]

export function fmt(n: number): string {
  if (n >= 1_000_000_000_000) return `${(n / 1_000_000_000_000).toFixed(1)}T`
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

export function money(n: number): string {
  return `$${n.toFixed(2)}`
}

/** Left-aligned cell: truncate with ellipsis and pad to `width`, keeping a gap. */
export function cell(value: string, width: number): string {
  const inner = width - 1
  const text = value.length > inner ? value.slice(0, Math.max(1, inner - 1)) + "…" : value
  return text.padEnd(width)
}

/** Right-aligned numeric cell padded to `width`. */
export function num(value: string, width: number): string {
  if (value.length >= width) return value.slice(0, width)
  return value.padStart(width)
}

export function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value))
}

export function relativeTime(ms: number): string {
  const diff = Date.now() - ms
  if (diff < 60_000) return "just now"
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(diff / 3_600_000)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(diff / 86_400_000)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.floor(days / 365)}y ago`
}

export function glyph(level: number): string {
  if (level < 0) return " "
  return GLYPHS[level] ?? "·"
}

export function levelOf(tokens: number, max: number): number {
  if (tokens <= 0) return 0
  const fraction = tokens / max
  if (fraction > 0.66) return 4
  if (fraction > 0.33) return 3
  if (fraction > 0.1) return 2
  return 1
}

export function weekdayLabel(row: number): string {
  const label = row === 1 ? "Mon" : row === 3 ? "Wed" : row === 5 ? "Fri" : ""
  return label.padEnd(4)
}

export function parseDay(value: string): Date {
  const [year, month, day] = value.split("-").map(Number)
  return new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1)
}

export function fmtDay(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

export function addDays(date: Date, amount: number): Date {
  const next = new Date(date)
  next.setDate(next.getDate() + amount)
  return next
}

export function rleRow(weeks: number, levelAt: (column: number) => number): CalRun[] {
  const runs: CalRun[] = []
  for (let column = 0; column < weeks; column++) {
    const level = levelAt(column)
    const last = runs[runs.length - 1]
    if (last && last.level === level) {
      last.count += 1
      continue
    }
    runs.push({ level, count: 1 })
  }
  return runs
}

/** GitHub-style calendar: weeks as columns, 7 weekday rows, anchored to the most recent day. */
export function buildCalendar(heatmap: DailyActivity[], availWidth: number): Calendar | null {
  if (heatmap.length === 0) return null
  const gutter = 4
  const weeks = clamp(availWidth - gutter, 8, 53)
  const map = new Map<string, number>()
  for (const day of heatmap) map.set(day.day, day.tokens)

  const end = parseDay(heatmap[heatmap.length - 1]!.day)
  const endTime = end.getTime()
  const start = addDays(addDays(end, -end.getDay()), -(weeks - 1) * 7)

  let max = 1
  for (let column = 0; column < weeks; column++) {
    for (let row = 0; row < 7; row++) {
      const date = addDays(start, column * 7 + row)
      if (date.getTime() > endTime) continue
      const tokens = map.get(fmtDay(date)) ?? 0
      if (tokens > max) max = tokens
    }
  }

  const levelAt = (column: number, row: number) => {
    const date = addDays(start, column * 7 + row)
    if (date.getTime() > endTime) return -1
    return levelOf(map.get(fmtDay(date)) ?? 0, max)
  }

  const weekdays = Array.from({ length: 7 }, (_, row) => ({
    label: weekdayLabel(row),
    runs: rleRow(weeks, (column) => levelAt(column, row)),
  }))

  const monthCells = new Array<string>(weeks).fill(" ")
  let lastMonth = -1
  for (let column = 0; column < weeks; column++) {
    const month = addDays(start, column * 7).getMonth()
    if (month === lastMonth) continue
    const label = MONTHS[month] ?? ""
    for (let offset = 0; offset < label.length && column + offset < weeks; offset++) {
      monthCells[column + offset] = label[offset]!
    }
    lastMonth = month
  }
  const monthRow = " ".repeat(gutter) + monthCells.join("")

  return { weeks, monthRow, weekdays }
}

export function modelRows(models: ModelUsageRow[]): UsageRow[] {
  return models.slice(0, 20).map((model) => ({
    name: model.modelId,
    sub: model.providerId,
    cost: model.cost,
    tokens: model.inputTokens + model.outputTokens,
    messages: model.messageCount,
  }))
}

export function providerRows(models: ModelUsageRow[]): UsageRow[] {
  const groups = new Map<string, { tokens: number; cost: number; messages: number; models: number }>()
  for (const model of models) {
    const group = groups.get(model.providerId) ?? { tokens: 0, cost: 0, messages: 0, models: 0 }
    group.tokens += model.inputTokens + model.outputTokens
    group.cost += model.cost
    group.messages += model.messageCount
    group.models += 1
    groups.set(model.providerId, group)
  }
  return [...groups.entries()]
    .sort((a, b) => b[1].tokens - a[1].tokens)
    .map(([name, group]) => ({
      name,
      sub: `${group.models} model${group.models === 1 ? "" : "s"}`,
      cost: group.cost,
      tokens: group.tokens,
      messages: group.messages,
    }))
}
