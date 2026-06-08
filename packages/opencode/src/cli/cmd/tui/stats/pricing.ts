/**
 * Pure cost-estimation helpers for the stats dashboard.
 *
 * This module has NO DB or OpenTUI imports so it can be unit tested in
 * isolation (same philosophy as `./format`). Pricing comes from the models.dev
 * catalog opencode already maintains on disk (see `ModelsDev.Service`), so the
 * dashboard reuses the same per-token prices opencode uses to compute live
 * message cost rather than fetching pricing again.
 *
 * The estimation mirrors opencode's canonical cost math in
 * `packages/opencode/src/session/session.ts`: prices are quoted per million
 * tokens, and reasoning tokens are charged at the output rate (models.dev has
 * no separate reasoning price). Keeping the same formula means an estimated
 * cost (stored cost was 0) is directly comparable to a stored cost (> 0).
 */

/** Per-million-token prices for one model, normalized from the models.dev catalog. */
export interface ModelPrice {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** Token usage for one assistant message. */
export interface CostTokens {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

/** models.dev quotes prices per million tokens. */
const PER_MILLION = 1_000_000

/**
 * Estimate message cost from token usage and per-million-token prices.
 *
 * Mirrors `session.ts`: input/output/cache tokens are charged at their own
 * rate, and reasoning tokens are charged at the output rate.
 */
export function estimateCost(tokens: CostTokens, price: ModelPrice): number {
  const micros =
    tokens.input * price.input +
    tokens.output * price.output +
    tokens.reasoning * price.output +
    tokens.cacheRead * price.cacheRead +
    tokens.cacheWrite * price.cacheWrite
  return micros / PER_MILLION
}

/**
 * Resolve the spend for a row: trust a positive stored cost, otherwise estimate
 * from tokens × price. Returns 0 when the stored cost is missing/zero and no
 * price is known, so unknown models never inflate the headline total.
 */
export function resolveCost(storedCost: number, tokens: CostTokens, price: ModelPrice | undefined): number {
  if (storedCost > 0) return storedCost
  if (!price) return 0
  return estimateCost(tokens, price)
}

/** Minimal structural shape of the models.dev catalog this module reads. */
export interface PriceCatalog {
  [providerId: string]: {
    models: {
      [modelId: string]: {
        cost?: {
          input: number
          output: number
          cache_read?: number
          cache_write?: number
        }
      }
    }
  }
}

/** Resolves a normalized `ModelPrice` for a provider/model pair, or undefined when unknown. */
export type PriceLookup = (providerId: string, modelId: string) => ModelPrice | undefined

/**
 * Build a price lookup from the models.dev catalog opencode already caches.
 * Models without cost metadata (or unknown provider/model ids) resolve to
 * undefined, which `resolveCost` treats as "no estimate available".
 */
export function buildPriceLookup(catalog: PriceCatalog): PriceLookup {
  return (providerId, modelId) => {
    const cost = catalog[providerId]?.models[modelId]?.cost
    if (!cost) return undefined
    return {
      input: cost.input,
      output: cost.output,
      cacheRead: cost.cache_read ?? 0,
      cacheWrite: cost.cache_write ?? 0,
    }
  }
}
