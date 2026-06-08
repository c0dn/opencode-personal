/**
 * StatsRepository — typed raw SQL queries for the stats dashboard.
 *
 * All queries are parameterized via Drizzle `sql` tagged template.
 * JSON extraction paths use sql.raw() for literal SQL fragments.
 */

import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import type {
  StatsData,
  SessionAggregateRow,
  MessageModelRow,
  ToolCountRow,
  DailyActivityRow,
  SessionListRow,
  ModelUsageRow,
  CountRow,
} from "./types"
import { cutoffFor, type TimeRange } from "./types"
import { buildPriceLookup, resolveCost, type PriceLookup } from "./pricing"

/** Load all stats data for the given time range. */
export function loadStats(range: TimeRange) {
  return Effect.gen(function* () {
    const cutoff = cutoffFor(range)
    const modelsDev = yield* ModelsDev.Service

    // Independent reads run concurrently instead of in series. The models.dev
    // catalog is the in-repo pricing source opencode already maintains on disk
    // (TTL-cached, falls back to a bundled snapshot offline), so cost estimation
    // reuses the same prices opencode uses to compute live message cost. If the
    // catalog is genuinely unavailable, degrade to an empty price table: the
    // dashboard still renders and simply keeps stored costs (no estimation).
    const priceCatalog = modelsDev
      .get()
      .pipe(Effect.catchDefect(() => Effect.succeed<Record<string, ModelsDev.Provider>>({})))
    const [priceData, aggregate, messageModels, tools, heatmap, sessions, promptCount] = yield* Effect.all(
      [
        priceCatalog,
        queryOverview(cutoff),
        queryModelUsage(cutoff),
        queryToolUsage(cutoff),
        queryDailyActivity(),
        querySessionList(cutoff),
        queryPromptCount(cutoff),
      ],
      { concurrency: "unbounded" },
    )

    const prices = buildPriceLookup(priceData)
    return buildStatsData(aggregate, messageModels, tools, heatmap, sessions, promptCount?.count ?? 0, prices)
  })
}

// ── Query functions ───────────────────────────────────────────────────

function queryOverview(cutoff: number) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    return yield* db.get<SessionAggregateRow>(
      sql`SELECT
        CAST(COALESCE(SUM(s.cost), 0) AS REAL) as cost,
        CAST(COALESCE(SUM(s.tokens_input), 0) AS INTEGER) as tokens_input,
        CAST(COALESCE(SUM(s.tokens_output), 0) AS INTEGER) as tokens_output,
        CAST(COALESCE(SUM(s.tokens_reasoning), 0) AS INTEGER) as tokens_reasoning,
        CAST(COALESCE(SUM(s.tokens_cache_read), 0) AS INTEGER) as tokens_cache_read,
        CAST(COALESCE(SUM(s.tokens_cache_write), 0) AS INTEGER) as tokens_cache_write
      FROM session s
      WHERE s.parent_id IS NULL
        AND s.time_updated >= ${cutoff}`,
    )
  })
}

function queryModelUsage(cutoff: number) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    return yield* db.all<MessageModelRow>(
      sql`SELECT
        COALESCE(CAST(${sql.raw("json_extract(m.data, '$.providerID')")} AS TEXT), 'unknown') as provider_id,
        COALESCE(CAST(${sql.raw("json_extract(m.data, '$.modelID')")} AS TEXT), 'unknown') as model_id,
        COALESCE(CAST(${sql.raw("json_extract(m.data, '$.tokens.input')")} AS INTEGER), 0) as input_tokens,
        COALESCE(CAST(${sql.raw("json_extract(m.data, '$.tokens.output')")} AS INTEGER), 0) as output_tokens,
        COALESCE(CAST(${sql.raw("json_extract(m.data, '$.tokens.reasoning')")} AS INTEGER), 0) as reasoning_tokens,
        COALESCE(CAST(${sql.raw("json_extract(m.data, '$.tokens.cache.read')")} AS INTEGER), 0) as cache_read,
        COALESCE(CAST(${sql.raw("json_extract(m.data, '$.tokens.cache.write')")} AS INTEGER), 0) as cache_write,
        COALESCE(CAST(${sql.raw("json_extract(m.data, '$.cost')")} AS REAL), 0) as cost
      FROM message m
      JOIN session s ON m.session_id = s.id
      WHERE ${sql.raw("json_extract(m.data, '$.role')")} = 'assistant'
        AND s.parent_id IS NULL
        AND s.time_updated >= ${cutoff}`,
    )
  })
}

function queryToolUsage(cutoff: number) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    return yield* db.all<ToolCountRow>(
      sql`SELECT
        COALESCE(CAST(${sql.raw("json_extract(p.data, '$.tool')")} AS TEXT), 'unknown') as tool_name,
        CAST(COALESCE(SUM(CASE WHEN ${sql.raw("json_extract(p.data, '$.state.status')")} = 'completed' THEN 1 ELSE 0 END), 0) AS INTEGER) as completed,
        CAST(COALESCE(SUM(CASE WHEN ${sql.raw("json_extract(p.data, '$.state.status')")} = 'error' THEN 1 ELSE 0 END), 0) AS INTEGER) as errored
      FROM part p
      JOIN session s ON p.session_id = s.id
      WHERE ${sql.raw("json_extract(p.data, '$.type')")} = 'tool'
        AND s.parent_id IS NULL
        AND s.time_updated >= ${cutoff}
      GROUP BY tool_name
      ORDER BY (completed + errored) DESC`,
    )
  })
}

function queryDailyActivity() {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const heatmapCutoff = Date.now() - 365 * 24 * 60 * 60 * 1000
    return yield* db.all<DailyActivityRow>(
      sql`SELECT
        date(time_updated / 1000, 'unixepoch') as day,
        CAST(SUM(
          COALESCE(tokens_input, 0)
          + COALESCE(tokens_output, 0)
          + COALESCE(tokens_reasoning, 0)
        ) AS INTEGER) as tokens
      FROM session
      WHERE parent_id IS NULL
        AND time_updated >= ${heatmapCutoff}
      GROUP BY day
      ORDER BY day`,
    )
  })
}

function querySessionList(cutoff: number) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    // Message counts come from a single grouped scan joined once, instead of a
    // correlated subquery that re-counts the message table for every session row.
    return yield* db.all<SessionListRow>(
      sql`SELECT
        s.id,
        s.title,
        p.name as project_name,
        s.cost,
        s.tokens_input,
        s.tokens_output,
        s.tokens_reasoning,
        s.tokens_cache_read,
        s.tokens_cache_write,
        s.time_created,
        s.time_updated,
        COALESCE(mc.message_count, 0) as message_count
      FROM session s
      LEFT JOIN project p ON s.project_id = p.id
      LEFT JOIN (
        SELECT session_id, COUNT(*) as message_count
        FROM message
        GROUP BY session_id
      ) mc ON mc.session_id = s.id
      WHERE s.parent_id IS NULL
        AND s.time_updated >= ${cutoff}
      ORDER BY s.time_updated DESC`,
    )
  })
}

function queryPromptCount(cutoff: number) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    // A "prompt" is one user message. Scope matches the other queries
    // (top-level sessions within the range) so the count lines up with them.
    return yield* db.get<CountRow>(
      sql`SELECT CAST(COALESCE(COUNT(*), 0) AS INTEGER) as count
      FROM message m
      JOIN session s ON m.session_id = s.id
      WHERE ${sql.raw("json_extract(m.data, '$.role')")} = 'user'
        AND s.parent_id IS NULL
        AND s.time_updated >= ${cutoff}`,
    )
  })
}

// ── Data builder ──────────────────────────────────────────────────────

function buildStatsData(
  agg: SessionAggregateRow | undefined,
  messageModels: MessageModelRow[],
  tools: ToolCountRow[],
  dailyActivity: DailyActivityRow[],
  sessions: SessionListRow[],
  prompts: number,
  prices: PriceLookup,
): StatsData {
  const a = agg ?? {
    cost: 0, tokens_input: 0, tokens_output: 0,
    tokens_reasoning: 0, tokens_cache_read: 0, tokens_cache_write: 0,
  }

  const totalTokens =
    a.tokens_input + a.tokens_output + a.tokens_reasoning +
    a.tokens_cache_read + a.tokens_cache_write

  // Model usage. Cost is resolved per message — stored cost wins when positive,
  // otherwise it is estimated from tokens × model price (handles older/zero-cost
  // rows that still have token usage). Overview cost is summed from the same
  // per-message resolution so the Overview and Models/Providers tabs always agree.
  const modelMap = new Map<string, ModelUsageRow>()
  let messageTotalTokens = 0
  let messageTotalCost = 0

  for (const row of messageModels) {
    const key = `${row.provider_id}/${row.model_id}`
    const existing = modelMap.get(key)
    const msgTokens =
      row.input_tokens + row.output_tokens + row.reasoning_tokens +
      row.cache_read + row.cache_write

    messageTotalTokens += msgTokens

    const cost = resolveCost(
      row.cost,
      {
        input: row.input_tokens,
        output: row.output_tokens,
        reasoning: row.reasoning_tokens,
        cacheRead: row.cache_read,
        cacheWrite: row.cache_write,
      },
      prices(row.provider_id ?? "unknown", row.model_id ?? "unknown"),
    )
    messageTotalCost += cost

    if (existing) {
      existing.inputTokens += row.input_tokens
      existing.outputTokens += row.output_tokens
      existing.reasoningTokens += row.reasoning_tokens
      existing.cacheRead += row.cache_read
      existing.cacheWrite += row.cache_write
      existing.cost += cost
      existing.messageCount += 1
    } else {
      modelMap.set(key, {
        modelId: row.model_id ?? "unknown",
        providerId: row.provider_id ?? "unknown",
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        reasoningTokens: row.reasoning_tokens,
        cacheRead: row.cache_read,
        cacheWrite: row.cache_write,
        cost,
        messageCount: 1,
      })
    }
  }

  const models = [...modelMap.values()].sort(
    (x, y) => (y.inputTokens + y.outputTokens) - (x.inputTokens + x.outputTokens),
  )

  const modelIds = new Set(models.map((m) => m.modelId))
  const activeDays = dailyActivity.filter((d) => d.tokens > 0).length
  let totalMessages = 0
  for (const s of sessions) { totalMessages += s.message_count }

  const driftPct = totalTokens > 0
    ? Math.abs(totalTokens - messageTotalTokens) / totalTokens * 100
    : 0

  return {
    overview: {
      totalTokens,
      inputTokens: a.tokens_input,
      outputTokens: a.tokens_output,
      reasoningTokens: a.tokens_reasoning,
      cacheReadTokens: a.tokens_cache_read,
      cacheWriteTokens: a.tokens_cache_write,
      totalCost: messageTotalCost,
      sessions: sessions.length,
      messages: totalMessages,
      prompts,
      modelsUsed: modelIds.size,
      activeDays,
    },
    models,
    tools: tools.map((t) => ({ name: t.tool_name, completed: t.completed, errored: t.errored })),
    heatmap: dailyActivity.map((d) => ({ day: d.day, tokens: d.tokens })),
    sessions: sessions.map((s) => ({
      id: s.id,
      title: s.title,
      projectName: s.project_name,
      tokens: s.tokens_input + s.tokens_output + s.tokens_reasoning + s.tokens_cache_read + s.tokens_cache_write,
      cost: s.cost,
      messageCount: s.message_count,
      timeCreated: s.time_created,
      timeUpdated: s.time_updated,
    })),
    aggregateDrift: driftPct > 1,
    driftPercent: driftPct,
  }
}
