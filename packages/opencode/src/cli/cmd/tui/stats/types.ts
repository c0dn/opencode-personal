/** Stats dashboard types. */

/** Time range filter for all stats queries. */
export type TimeRange = "all" | "7d" | "30d"

/** Cutoff timestamp in milliseconds for the selected range. */
export function cutoffFor(range: TimeRange): number {
  if (range === "all") return 0
  const days = range === "7d" ? 7 : 30
  return Date.now() - days * 24 * 60 * 60 * 1000
}

/** Overview stats for the dashboard header. */
export interface OverviewStats {
  totalTokens: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalCost: number
  sessions: number
  messages: number
  prompts: number
  modelsUsed: number
  activeDays: number
}

/** Per-model or per-provider usage row. */
export interface ModelUsageRow {
  modelId: string
  providerId: string
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheRead: number
  cacheWrite: number
  cost: number
  messageCount: number
}

/** Tool usage row. */
export interface ToolUsageRow {
  name: string
  completed: number
  errored: number
}

/** Daily activity entry for the heatmap. */
export interface DailyActivity {
  day: string // "YYYY-MM-DD"
  tokens: number
}

/** Session summary for the session search list. */
export interface SessionSummary {
  id: string
  title: string
  projectName: string | null
  tokens: number
  cost: number
  messageCount: number
  timeCreated: number
  timeUpdated: number
}

/** All stats data loaded from the repository. */
export interface StatsData {
  overview: OverviewStats
  models: ModelUsageRow[]
  tools: ToolUsageRow[]
  heatmap: DailyActivity[]
  sessions: SessionSummary[]
  /** True when session aggregates differ from message-level sums by >1%. */
  aggregateDrift: boolean
  /** Drift percentage (0–100). */
  driftPercent: number
}

/**
 * Multi-range cache written by the `stats` command for the TUI child process.
 * Every supported range is precomputed so the dashboard can switch ranges
 * instantly without re-querying the database.
 */
export interface StatsCache {
  ranges: Record<TimeRange, StatsData>
  /** Range the dashboard should select first (from the `--range` flag). */
  initialRange: TimeRange
}

/** Raw row shapes from SQL queries (internal). */

export interface SessionAggregateRow {
  cost: number
  tokens_input: number
  tokens_output: number
  tokens_reasoning: number
  tokens_cache_read: number
  tokens_cache_write: number
}

export interface MessageModelRow {
  provider_id: string | null
  model_id: string | null
  input_tokens: number
  output_tokens: number
  reasoning_tokens: number
  cache_read: number
  cache_write: number
  cost: number
}

export interface ToolCountRow {
  tool_name: string
  completed: number
  errored: number
}

export interface DailyActivityRow {
  day: string
  tokens: number
}

export interface SessionListRow {
  id: string
  title: string
  project_name: string | null
  cost: number
  tokens_input: number
  tokens_output: number
  tokens_reasoning: number
  tokens_cache_read: number
  tokens_cache_write: number
  time_created: number
  time_updated: number
  message_count: number
}
