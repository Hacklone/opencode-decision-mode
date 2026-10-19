import { describe, expect, it } from "vitest"
import { aggregateUsage, estimateCost } from "../../src/domain/usage"

describe("aggregateUsage", () => {
  it("sums tokens and keeps unknowns unknown", () => {
    const total = aggregateUsage([
      { inputTokens: 10, outputTokens: 5, costUsd: 0.001, costSource: "provider" },
      { inputTokens: null, outputTokens: 5, costUsd: 0.002, costSource: "provider" },
    ])
    expect(total).toEqual({ inputTokens: null, outputTokens: 10, costUsd: 0.003, costSource: "provider" })
  })

  it("marks mixed provenance as estimated", () => {
    const total = aggregateUsage([
      { inputTokens: 1, outputTokens: 1, costUsd: 0.001, costSource: "provider" },
      { inputTokens: 1, outputTokens: 1, costUsd: 0.002, costSource: "estimated" },
    ])
    expect(total.costSource).toBe("estimated")
    expect(total.costUsd).toBeCloseTo(0.003)
  })

  it("returns nulls when nothing is known", () => {
    const total = aggregateUsage([
      { inputTokens: null, outputTokens: null, costUsd: null, costSource: null },
    ])
    expect(total).toEqual({ inputTokens: null, outputTokens: null, costUsd: null, costSource: null })
  })

  it("empty input sums to zero tokens with null cost", () => {
    expect(aggregateUsage([])).toEqual({ inputTokens: 0, outputTokens: 0, costUsd: null, costSource: null })
  })
})

describe("estimateCost", () => {
  it("prices input tokens only and rounds to 6 decimals", () => {
    expect(estimateCost(1_000_000, 0.042)).toBe(0.042)
    expect(estimateCost(0, 0.042)).toBe(0)
    expect(estimateCost(null, 0.042)).toBeNull()
  })
})
