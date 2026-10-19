import { describe, expect, it } from "vitest"
import { StorageCache } from "../../src/adapters/persistence/opencode-cache"
import { StorageRunStore } from "../../src/adapters/persistence/opencode-run-store"
import type { RecordResult, RunSummary } from "../../src/domain/decision-types"
import { kv } from "../fakes"

import type { CachedEntry } from "../../src/ports/cache"

const entry: CachedEntry = {
  answers: { b: { type: "noul", pTrue: 0.5 } },
  usage: { inputTokens: 1, outputTokens: 1, costUsd: null, costSource: null },
  resolvedModel: "m",
}

describe("StorageCache", () => {
  it("round-trips entries and returns null for misses or corrupt values", async () => {
    const cache = new StorageCache(kv())
    expect(await cache.get("k")).toBeNull()
    await cache.set("k", entry)
    expect(await cache.get("k")).toEqual(entry)
    await cache.set("bad", { answers: 1 } as unknown as CachedEntry)
    expect(await cache.get("bad")).toBeNull()
  })
})

describe("StorageRunStore", () => {
  const summary: RunSummary = {
    id: "run_1",
    provider: "openrouter",
    requestedModel: "typesafe/jev-1.14",
    resolvedModel: "typesafe/jev-1.14",
    total: 3,
    ok: 2,
    error: 1,
    cached: 0,
    verdicts: { pass: 1, review: 0, fail: 1 },
    usage: { inputTokens: 9, outputTokens: 3, costUsd: 0.0003, costSource: "provider" },
    durationMs: 5,
    createdAt: "2026-10-19T00:00:00.000Z",
    source: { path: "x.csv", format: "csv", totalRecords: 3 },
  }

  const results: RecordResult[] = [
    { index: 0, key: null, status: "ok", verdict: "FAIL" },
    { index: 1, key: null, status: "ok", verdict: "PASS" },
    { index: 2, key: null, status: "error", error: "boom" },
  ]

  it("persists paged results and the summary", async () => {
    const store = new StorageRunStore(kv(), 2)
    await store.saveRun({ id: summary.id, summary }, [
      { runId: summary.id, page: 0, results: results.slice(0, 2) },
      { runId: summary.id, page: 1, results: results.slice(2) },
    ])
    expect(await store.getSummary(summary.id)).toEqual(summary)
    expect(await store.getResults(summary.id)).toEqual(results)
  })

  it("returns null for unknown runs and tolerates corrupt pages", async () => {
    const storage = kv()
    const store = new StorageRunStore(storage)
    expect(await store.getSummary("nope")).toBeNull()
    expect(await store.getResults("nope")).toBeNull()
    await storage.set("runs/run_2/meta", summary)
    await storage.set("runs/run_2/p/000000", { page: 0, results: "corrupt" })
    expect(await store.getResults("run_2")).toEqual([])
    // Partially-corrupt shapes exercise every validity branch.
    await storage.set("runs/run_3/meta", "junk")
    expect(await store.getSummary("run_3")).toBeNull()
    await storage.set("runs/run_4/meta", { id: "run_4", total: 1 })
    expect(await store.getSummary("run_4")).toBeNull()
    await storage.set("runs/run_5/meta", { id: "run_5", total: "1", source: {} })
    expect(await store.getSummary("run_5")).toBeNull()
    await storage.set("runs/run_6/p/000000", null)
    await storage.set("runs/run_6/p/000001", { page: "zero", results: [] })
    await storage.set("runs/run_6/meta", summary)
    expect(await store.getResults("run_6")).toEqual([])
  })

  it("lists summaries newest first and skips corrupt meta", async () => {
    const storage = kv()
    const store = new StorageRunStore(storage)
    const older = { ...summary, id: "run_a", createdAt: "2026-10-18T00:00:00.000Z" }
    const twin = { ...summary, id: "run_twin" } // same createdAt as run_1: exercises the tie branch
    await store.saveRun({ id: summary.id, summary }, [])
    await store.saveRun({ id: "run_twin", summary: twin }, [])
    await store.saveRun({ id: "run_a", summary: older }, [{ runId: "run_a", page: 0, results: [] }])
    await storage.set("runs/run_broken/meta", { junk: true })
    const listed = await store.listSummaries(10)
    expect(listed.map((s) => s.id)).toEqual([summary.id, "run_twin", "run_a"])
    expect((await store.listSummaries(1)).map((s) => s.id)).toEqual([summary.id])
    expect(await new StorageRunStore(kv()).listSummaries(0)).toEqual([])
  })
})
