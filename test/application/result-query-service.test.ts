import { describe, expect, it } from "vitest"
import { ResultQueryService } from "../../src/application/result-query-service"
import type { RecordResult, RunSummary } from "../../src/domain/decision-types"
import type { RunStore } from "../../src/ports/run-store"

function result(overrides: Partial<RecordResult>): RecordResult {
  return {
    index: 0,
    key: null,
    status: "ok",
    answers: {
      b: { type: "noul", pTrue: 0.9 },
      c: { type: "choice", choice: "spam", probabilities: { spam: 0.9, ham: 0.1 }, confidence: 0.8 },
      s: { type: "score", score: 2, legend: "high", probabilities: { low: 0.1, high: 0.9 }, confidence: 0.7 },
    },
    verdict: "FAIL",
    verdicts: { b: "FAIL" },
    usage: { inputTokens: 3, outputTokens: 1, costUsd: 0.0001, costSource: "provider" },
    ...overrides,
  }
}

const summary: RunSummary = {
  id: "run_x",
  provider: "openrouter",
  requestedModel: "typesafe/jev-1.14",
  resolvedModel: "typesafe/jev-1.14-20261001",
  total: 3,
  ok: 2,
  error: 1,
  cached: 1,
  verdicts: { pass: 1, review: 0, fail: 1 },
  usage: { inputTokens: 9, outputTokens: 3, costUsd: 0.0003, costSource: "provider" },
  durationMs: 42,
  createdAt: "2026-10-19T00:00:00.000Z",
  source: { path: "/tmp/x.csv", format: "csv", totalRecords: 3 },
}

function store(results: RecordResult[]): RunStore {
  return {
    saveRun: async () => {},
    getSummary: async (id) => (id === summary.id ? summary : null),
    getResults: async (id) => (id === summary.id ? results : null),
    listSummaries: async (limit = 20) => [summary].slice(0, limit),
  }
}

const rows: RecordResult[] = [
  result({ index: 0, record: { text: "row zero" } }),
  result({ index: 1, status: "error", error: "boom", answers: undefined, verdict: undefined, verdicts: undefined, usage: undefined }),
  result({ index: 2, verdict: "PASS", verdicts: { b: "PASS" }, cacheHit: true }),
]

describe("ResultQueryService", () => {
  it("lists recent runs", async () => {
    const service = new ResultQueryService(store(rows))
    expect(await service.listRuns(5)).toEqual([summary])
  })

  it("paginates without filters", async () => {
    const service = new ResultQueryService(store(rows))
    const page = await service.query({ run: summary.id, limit: 2 })
    expect(page.matched).toBe(3)
    expect(page.results).toHaveLength(2)
    expect(page.summary).toEqual(summary)
    const second = await service.query({ run: summary.id, offset: 2, limit: 2 })
    expect(second.results.map((r) => r.index)).toEqual([2])
  })

  it("filters by status and verdict", async () => {
    const service = new ResultQueryService(store(rows))
    const errors = await service.query({ run: summary.id, status: "error" })
    expect(errors.matched).toBe(1)
    expect(errors.results[0]!.error).toBe("boom")
    const fails = await service.query({ run: summary.id, verdict: "FAIL" })
    expect(fails.matched).toBe(1)
    const passes = await service.query({ run: summary.id, verdict: "PASS" })
    expect(passes.results[0]!.cacheHit).toBe(true)
  })

  it("compacts by default and keeps everything with detail: full", async () => {
    const service = new ResultQueryService(store(rows))
    const compact = await service.query({ run: summary.id, offset: 0, limit: 1 })
    expect(compact.results[0]!.answers).toEqual({
      b: { type: "noul", pTrue: 0.9 },
      c: { type: "choice", choice: "spam" },
      s: { type: "score", score: 2, legend: "high" },
    })
    expect(compact.results[0]!.usage).toBeUndefined()
    const full = await service.query({ run: summary.id, offset: 0, limit: 1, detail: "full" })
    expect(full.results[0]!.usage).toBeDefined()
    expect(full.results[0]!.answers!["c"]).toMatchObject({ probabilities: { spam: 0.9, ham: 0.1 } })
  })

  it("keeps the record snapshot in full detail and drops it in compact", async () => {
    const service = new ResultQueryService(store(rows))
    const compact = await service.query({ run: summary.id, limit: 1 })
    expect(compact.results[0]!.record).toBeUndefined()
    const full = await service.query({ run: summary.id, limit: 1, detail: "full" })
    expect(full.results[0]!.record).toEqual({ text: "row zero" })
  })

  it("compacts error records without inventing fields", async () => {
    const service = new ResultQueryService(store(rows))
    const page = await service.query({ run: summary.id, status: "error" })
    expect(page.results[0]).toEqual({ index: 1, key: null, status: "error", error: "boom" })
  })

  it("rejects unknown or incomplete runs", async () => {
    const service = new ResultQueryService(store(rows))
    await expect(service.query({ run: "nope" })).rejects.toThrow(/unknown run/)
    const resultsOnly: RunStore = { ...store(rows), getSummary: async () => summary, getResults: async () => null }
    await expect(new ResultQueryService(resultsOnly).query({ run: summary.id })).rejects.toThrow(
      /missing its results/,
    )
  })

  it("clamps limits", async () => {
    const service = new ResultQueryService(store(rows))
    expect((await service.query({ run: summary.id, limit: 0 })).results).toHaveLength(3)
    expect((await service.query({ run: summary.id, limit: 500 })).results).toHaveLength(3)
  })

  it("re-derives verdicts from stored answers under a new policy", async () => {
    const service = new ResultQueryService(store(rows))
    // Stored: b=0.9 → FAIL under {failAt: 0.85}. Loosen the policy: PASS.
    const page = await service.query({ run: summary.id, policy: { reviewAt: 0.95, failAt: 0.99 } })
    expect(page.results[0]!.verdicts).toEqual({ b: "PASS" })
    expect(page.results[0]!.verdict).toBe("PASS")
    // The stored summary still reflects the original run.
    expect(page.summary).toEqual(summary)
  })

  it("applies the verdict filter to re-derived verdicts", async () => {
    const service = new ResultQueryService(store(rows))
    // Both ok rows have b=0.9. Stored verdicts differ (FAIL, PASS) but under
    // {reviewAt: 0.8, failAt: 0.99} both re-derive to REVIEW.
    const page = await service.query({ run: summary.id, verdict: "FAIL", policy: { reviewAt: 0.8, failAt: 0.99 } })
    expect(page.matched).toBe(0)
    const reviews = await service.query({ run: summary.id, verdict: "REVIEW", policy: { reviewAt: 0.8, failAt: 0.99 } })
    expect(reviews.matched).toBe(2)
  })

  it("re-derivation leaves error rows untouched", async () => {
    const service = new ResultQueryService(store(rows))
    const page = await service.query({ run: summary.id, status: "error", policy: { reviewAt: 0.1, failAt: 0.2 } })
    expect(page.results[0]).toEqual({ index: 1, key: null, status: "error", error: "boom" })
  })

  it("reconstructs score legends from the summary's levels table", async () => {
    const withLevels: RunSummary = { ...summary, levels: { s: ["low", "mid", "high"] } }
    const stored: RecordResult[] = [
      result({ index: 0, answers: { s: { type: "score", score: 1.2, legend: null, probabilities: {} } } }),
    ]
    const levelStore: RunStore = {
      saveRun: async () => {},
      getSummary: async () => withLevels,
      getResults: async () => stored,
      listSummaries: async () => [withLevels],
    }
    const service = new ResultQueryService(levelStore)
    const compact = await service.query({ run: withLevels.id })
    expect(compact.results[0]!.answers!["s"]).toEqual({ type: "score", score: 1.2, legend: "mid" })
    const full = await service.query({ run: withLevels.id, detail: "full" })
    expect(full.results[0]!.answers!["s"]).toMatchObject({ legend: "mid", probabilities: {} })
  })

  it("leaves null legends alone when the summary has no levels table", async () => {
    // Legacy run: rows carry null legends and the summary predates levels.
    const service = new ResultQueryService(
      store([result({ index: 0, answers: { s: { type: "score", score: 1, legend: null, probabilities: {} } } })]),
    )
    const page = await service.query({ run: summary.id })
    expect(page.results[0]!.answers!["s"]).toEqual({ type: "score", score: 1, legend: null })
  })
})
