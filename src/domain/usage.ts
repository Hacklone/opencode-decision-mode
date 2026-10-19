import type { Usage } from "./decision-types"

/**
 * Aggregate per-record usage into run totals.
 *
 * Tokens are summed where known; unknowns stay unknown rather than being
 * coerced to zero. Cost handling is source-aware:
 *   - every contributing record provider-reported → "provider"
 *   - any estimated record mixed in               → "estimated"
 *   - nothing known                               → null
 */
export function aggregateUsage(items: readonly Usage[]): Usage {
  let inputTokens: number | null = 0
  let outputTokens: number | null = 0
  let costUsd: number | null = null
  let costSource: Usage["costSource"] = null
  let sawProvider = false
  let sawEstimated = false

  for (const item of items) {
    if (item.inputTokens === null) inputTokens = null
    else if (inputTokens !== null) inputTokens += item.inputTokens
    if (item.outputTokens === null) outputTokens = null
    else if (outputTokens !== null) outputTokens += item.outputTokens
    if (item.costUsd !== null) {
      costUsd = (costUsd ?? 0) + item.costUsd
      if (item.costSource === "provider") sawProvider = true
      else sawEstimated = true
    }
  }

  if (costUsd !== null) costSource = sawEstimated ? "estimated" : "provider"
  if (sawProvider && sawEstimated) {
    // Mixed provenance: the sum is part reported, part estimated.
    costSource = "estimated"
  }

  return { inputTokens, outputTokens, costUsd, costSource }
}

/** Estimate cost in USD from token counts at a given $/1M-input-tokens price. Output is free. */
export function estimateCost(inputTokens: number | null, usdPerMillionInput: number): number | null {
  if (inputTokens === null) return null
  return round6((inputTokens / 1_000_000) * usdPerMillionInput)
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}

/** Pricing used when a provider does not report cost (USD per 1M input tokens; output free). */
export const ESTIMATED_PRICING = {
  typesafe: 0.042,
  openai: 0.1,
} as const
