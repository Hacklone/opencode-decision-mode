import { describe, expect, it, vi } from "vitest"
import {
  BulkMapService,
  MAX_RECORDS,
  PROGRESS_INTERVAL,
  chunkResults,
} from "../../src/application/bulk-map-service"
import type { BackendRegistry } from "../../src/ports/decision-backend"
import { BackendError } from "../../src/ports/decision-backend"
import type { DecisionCache } from "../../src/ports/cache"
import type { RunStore, StoredRunPage } from "../../src/ports/run-store"
import type { SourceReader, SourceRecord } from "../../src/ports/source-reader"
import { MemoryKv } from "../fakes"
import { StorageCache } from "../../src/adapters/persistence/opencode-cache"
import { StorageRunStore } from "../../src/adapters/persistence/opencode-run-store"

const signal = new AbortController().signal
const question = { id: "b", type: "noul" as const, instructions: "is it spam?" }

function makeReader(records: SourceRecord[]): SourceReader {
  return { read: vi.fn(async () => records) }
}

function makeBackend(fail: (index: number) => boolean = () => false): BackendRegistry["openrouter"] & object {
  const calls: Array<{ state: unknown }> = []
  return {
    provider: "openrouter",
    decide: vi.fn(async (request: { state: unknown }) => {
      calls.push({ state: request.state })
      const index = (request.state as { index: number }).index
      if (fail(index)) throw new BackendError("provider hiccup")
      return {
        provider: "openrouter" as const,
        requestedModel: "jev",
        resolvedModel: "typesafe/jev-1.14-20261001",
        answers: { b: { type: "noul", pTrue: index % 3 === 0 ? 0.9 : index % 3 === 1 ? 0.7 : 0.1 } },
        usage: { inputTokens: 5, outputTokens: 1, costUsd: 0.0001, costSource: "provider" as const },
      }
    }),
  } as never
}

function makeStore(): RunStore & { saved: { pages: StoredRunPage[]; summaries: string[] } } {
  const saved: { pages: StoredRunPage[]; summaries: string[] } = { pages: [], summaries: [] }
  return {
    saved,
    saveRun: async (meta, pages) => {
      saved.summaries.push(meta.id)
      saved.pages.push(...pages)
    },
    getSummary: async () => null,
    getResults: async () => null,
    listSummaries: async () => [],
  }
}

function records(n: number): SourceRecord[] {
  return Array.from({ length: n }, (_, i) => ({ index: i, key: i === 1 ? "special" : null, fields: { index: i, text: `row ${i}` } }))
}

function service(options: {
  rows: SourceRecord[]
  backend?: ReturnType<typeof makeBackend>
  failAll?: boolean
}): { bulk: BulkMapService; store: ReturnType<typeof makeStore>; backend: NonNullable<BackendRegistry["openrouter"]> } {
  const backend = options.backend ?? makeBackend()
  const store = makeStore()
  const bulk = new BulkMapService(
    { openrouter: backend, typesafe: null, openai: null },
    new StorageCache(new MemoryKv()),
    store,
    makeReader(options.rows),
    () => 1_000_000,
  )
  return { bulk, store, backend: backend as NonNullable<BackendRegistry["openrouter"]> }
}

const baseRequest = {
  path: "/tmp/x.csv",
  format: "csv" as const,
  state: "$record",
  questions: [question],
  provider: "openrouter" as const,
  model: "jev",
  concurrency: 4,
  signal,
}

describe("BulkMapService", () => {
  it("projects named fields as raw-typed state", async () => {
    const rows = [{ index: 0, key: "a", fields: { index: 0, text: "hi", n: 3, tags: ["x"], secret: "leak" } }]
    const { bulk, backend } = service({ rows })
    await bulk.map({ ...baseRequest, state: undefined, project: ["text", "n", "tags"] })
    expect(backend.decide).toHaveBeenCalledWith(expect.objectContaining({ state: { text: "hi", n: 3, tags: ["x"] } }))
  })

  it("a missing projected field is a per-record error, not silent data loss", async () => {
    const rows = [
      { index: 0, key: null, fields: { index: 0, text: "ok" } },
      { index: 1, key: null, fields: { index: 1 } },
    ]
    const { bulk } = service({ rows })
    const { summary, preview } = await bulk.map({ ...baseRequest, state: undefined, project: ["text"] })
    expect(summary.error).toBe(1)
    expect(preview[1]!.error).toMatch(/record 1: projected field "text" does not exist/)
  })

  it("maps every record, tallies verdicts, and persists a chunked run", async () => {
    const { bulk, store } = service({ rows: records(5) })
    const { summary, preview } = await bulk.map({ ...baseRequest })
    expect(summary.total).toBe(5)
    expect(summary.ok).toBe(5)
    expect(summary.error).toBe(0)
    expect(summary.verdicts).toEqual({ pass: 1, review: 2, fail: 2 })
    expect(summary.cached).toBe(0)
    expect(summary.resolvedModel).toBe("typesafe/jev-1.14-20261001")
    expect(preview).toHaveLength(5)
    expect(store.saved.summaries).toHaveLength(1)
    expect(store.saved.pages).toHaveLength(1)
    // Record snapshots persist with the results so reports can quote content.
    expect(store.saved.pages[0]!.results[0]!.record).toEqual({ index: 0, text: "row 0" })
  })

  it("snapshots record fields on error results too", async () => {
    const { bulk, store } = service({ rows: records(2), backend: makeBackend(() => true) })
    await bulk.map({ ...baseRequest })
    const stored = store.saved.pages.flatMap((page) => page.results)
    expect(stored).toHaveLength(2)
    expect(stored.every((r) => r.status === "error" && r.record !== undefined)).toBe(true)
  })

  it("bails out early once identical failures become systematic", async () => {
    const { bulk, backend } = service({ rows: records(20), backend: makeBackend(() => true) })
    const { summary, aborted } = await bulk.map({ ...baseRequest })
    expect(aborted).not.toBeNull()
    expect(aborted!.error).toBe("provider hiccup")
    // 6 errors trip the bail; at most concurrency-1 extra calls were in flight.
    expect(vi.mocked(backend.decide).mock.calls.length).toBeLessThanOrEqual(9)
    expect(aborted!.skipped).toBe(20 - vi.mocked(backend.decide).mock.calls.length)
    // Skipped records still get honest error results (no provider call) with snapshots.
    expect(summary.error).toBe(20)
    expect(summary.total).toBe(20)
  })

  it("groups error signatures that differ only in numbers", async () => {
    // Per-record varying numbers (e.g. fractional score values) must count as
    // the SAME systematic failure, not eleven unrelated one-offs.
    const backend = {
      provider: "openrouter",
      decide: vi.fn(async (request: { state: unknown }) => {
        const index = (request.state as { index: number }).index
        throw new BackendError(`score answer ${1 + index * 0.37} does not match any criteria level`)
      }),
    } as never
    const { bulk } = service({ rows: records(12), backend })
    const { aborted } = await bulk.map({ ...baseRequest })
    expect(aborted).not.toBeNull()
    expect(aborted!.error).toMatch(/does not match any criteria level/)
  })

  it("does not bail below the systematic threshold", async () => {
    const { bulk } = service({ rows: records(5), backend: makeBackend(() => true) })
    const { aborted, summary } = await bulk.map({ ...baseRequest })
    expect(aborted).toBeNull()
    expect(summary.error).toBe(5)
  })

  it("samples records without provider calls or a run", async () => {
    const { bulk, backend, store } = service({ rows: records(30) })
    expect((await bulk.sample({ path: "/tmp/x.csv", format: "csv", limit: 3 })).map((r) => r.index)).toEqual([0, 1, 2])
    // Clamped to [1, MAX_SAMPLE]; no backend calls, no persisted run.
    expect(await bulk.sample({ path: "/tmp/x.csv", format: "csv", limit: 500 })).toHaveLength(20)
    expect(await bulk.sample({ path: "/tmp/x.csv", format: "csv", limit: 0 })).toHaveLength(1)
    expect(backend.decide).not.toHaveBeenCalled()
    expect(store.saved.summaries).toEqual([])
  })

  it("isolates per-record errors without failing the run", async () => {
    const { bulk } = service({ rows: records(3), backend: makeBackend((i) => i === 1) })
    const { summary } = await bulk.map({ ...baseRequest })
    expect(summary.ok).toBe(2)
    expect(summary.error).toBe(1)
  })

  it("serves repeat records from cache and counts hits", async () => {
    const rows = [
      { index: 0, key: null, fields: { text: "same" } },
      { index: 1, key: null, fields: { text: "same" } },
    ]
    const { bulk, backend } = service({ rows })
    // concurrency 1 makes the cache fill deterministic.
    const { summary } = await bulk.map({ ...baseRequest, state: { text: "{{text}}" }, concurrency: 1 })
    expect(summary.cached).toBe(1)
    expect(backend.decide).toHaveBeenCalledTimes(1)
  })

  it("projects per-record state from templates", async () => {
    const { bulk, backend } = service({ rows: records(2) })
    await bulk.map({ ...baseRequest, state: { row: "{{text}}", n: "{{index}}" } })
    const calls = (backend.decide as ReturnType<typeof vi.fn>).mock.calls as Array<[{ state: unknown }]>
    expect(calls[0]![0].state).toEqual({ row: "row 0", n: "0" })
    expect(calls[1]![0].state).toEqual({ row: "row 1", n: "1" })
  })

  it("aborts promptly when the signal fires", async () => {
    const controller = new AbortController()
    const backend = makeBackend()
    ;(backend.decide as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      controller.abort()
      return {
        provider: "openrouter" as const,
        requestedModel: "j",
        resolvedModel: "j",
        answers: {},
        usage: { inputTokens: 1, outputTokens: 1, costUsd: null, costSource: null },
      }
    })
    const { bulk } = service({ rows: records(10), backend })
    await expect(bulk.map({ ...baseRequest, signal: controller.signal })).rejects.toThrow(/aborted/)
  })

  it("enforces the per-run record cap", async () => {
    const { bulk } = service({ rows: records(MAX_RECORDS + 1) })
    await expect(bulk.map({ ...baseRequest })).rejects.toThrow(/per-run cap/)
  })

  it("rejects when no backend exists for the provider", async () => {
    const bulk = new BulkMapService(
      { openrouter: null, typesafe: null, openai: null },
      new StorageCache(new MemoryKv()),
      makeStore(),
      makeReader(records(1)),
    )
    await expect(bulk.map({ ...baseRequest })).rejects.toThrow(/no backend configured/)
  })

  it("applies offset/limit slicing and reports totalRecords", async () => {
    const { bulk } = service({ rows: records(6) })
    const { summary } = await bulk.map({ ...baseRequest, offset: 2, limit: 2 })
    expect(summary.total).toBe(2)
    expect(summary.source.totalRecords).toBe(6)
  })

  it("aborts when a backend error races the abort signal, tolerates non-Error throws, and defaults bad concurrency", async () => {
    const controller = new AbortController()
    const backend = makeBackend()
    ;(backend.decide as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      controller.abort()
      throw "string-failure" // non-Error throw while aborted
    })
    const { bulk } = service({ rows: records(2), backend })
    await expect(bulk.map({ ...baseRequest, signal: controller.signal })).rejects.toThrow(/aborted/)

    // Non-Error throw without abort → per-record error with stringified message.
    const backend2 = makeBackend()
    ;(backend2.decide as ReturnType<typeof vi.fn>).mockRejectedValue("plain-string")
    const { bulk: bulk2 } = service({ rows: records(1), backend: backend2 })
    const { summary, preview } = await bulk2.map({ ...baseRequest })
    expect(summary.error).toBe(1)
    expect(preview[0]).toMatchObject({ status: "error", error: "plain-string" })

    // Invalid concurrency falls back to the default.
    const { bulk: bulk3 } = service({ rows: records(2) })
    const { summary: summary3 } = await bulk3.map({ ...baseRequest, concurrency: 0 })
    expect(summary3.ok).toBe(2)
  })

  it("tallies records without verdicts into neither bucket", async () => {
    const backend = makeBackend()
    ;(backend.decide as ReturnType<typeof vi.fn>).mockResolvedValue({
      provider: "openrouter",
      requestedModel: "j",
      resolvedModel: "j",
      answers: { c: { type: "choice", choice: "x", probabilities: {} } },
      usage: { inputTokens: 1, outputTokens: 1, costUsd: null, costSource: null },
    })
    const { bulk } = service({ rows: records(1), backend })
    const { summary } = await bulk.map({
      ...baseRequest,
      questions: [{ id: "c", type: "choice", instructions: "pick", criteria: { x: null } }],
    })
    expect(summary.verdicts).toEqual({ pass: 0, review: 0, fail: 0 })
  })

  it("keeps mixed resolved models conservative (falls back to requested)", async () => {
    const backend = makeBackend()
    let n = 0
    ;(backend.decide as ReturnType<typeof vi.fn>).mockImplementation(async (request: { state: { index: number } }) => {
      n += 1
      return {
        provider: "openrouter" as const,
        requestedModel: "jev",
        resolvedModel: n === 1 ? "typesafe/jev-1.14-a" : "typesafe/jev-1.14-b",
        answers: { b: { type: "noul", pTrue: 0.1 } },
        usage: { inputTokens: 1, outputTokens: 1, costUsd: null, costSource: null },
      }
    })
    const { bulk } = service({ rows: records(2), backend })
    const { summary } = await bulk.map({ ...baseRequest })
    expect(summary.resolvedModel).toBe("jev")
  })
})

describe("score legends and levels table", () => {
  const scoreQuestion = { id: "sev", type: "score" as const, instructions: "how bad?", criteria: ["low", "high"] }
  const scoreBackend = () => {
    const backend = makeBackend()
    ;(backend.decide as ReturnType<typeof vi.fn>).mockResolvedValue({
      provider: "openrouter",
      requestedModel: "jev",
      resolvedModel: "typesafe/jev-1.14-20261001",
      answers: { sev: { type: "score", score: 1, legend: "high", probabilities: { low: 0.2, high: 0.8 } } },
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.0001, costSource: "provider" as const },
    })
    return backend
  }

  it("stores level labels once in the summary and strips them from rows", async () => {
    const { bulk, store } = service({ rows: records(2), backend: scoreBackend() })
    const { summary, preview } = await bulk.map({ ...baseRequest, questions: [scoreQuestion] })
    expect(summary.levels).toEqual({ sev: ["low", "high"] })
    for (const row of [...preview, ...store.saved.pages.flatMap((p) => p.results)]) {
      expect(row.answers).toEqual({
        sev: { type: "score", score: 1, legend: null, probabilities: { low: 0.2, high: 0.8 } },
      })
    }
  })

  it("omits the levels table when no score question exists", async () => {
    const { bulk, store } = service({ rows: records(1) })
    const { summary } = await bulk.map({ ...baseRequest })
    expect(summary.levels).toBeUndefined()
    expect(store.saved.pages[0]!.results[0]!.answers).toEqual({ b: { type: "noul", pTrue: 0.9 } })
  })

  it("strips legends on cache hits too (cache keeps the full answer)", async () => {
    const { bulk } = service({ rows: records(2), backend: scoreBackend() })
    // First run fills the cache; the second serves from it — rows must be
    // stripped identically on both paths.
    await bulk.map({ ...baseRequest, questions: [scoreQuestion], concurrency: 1, state: { text: "{{index}}" } })
    const { summary, preview } = await bulk.map({
      ...baseRequest,
      questions: [scoreQuestion],
      concurrency: 1,
      state: { text: "{{index}}" },
    })
    expect(summary.cached).toBe(2)
    expect(
      preview.every((row) => (row.answers!["sev"] as { legend: string | null }).legend === null),
    ).toBe(true)
  })
})

describe("preview control", () => {
  it("defaults to 10 and honours numeric and false values", async () => {
    const { bulk } = service({ rows: records(12) })
    expect((await bulk.map({ ...baseRequest })).preview).toHaveLength(10)
    expect((await bulk.map({ ...baseRequest, preview: 3 })).preview).toHaveLength(3)
    expect((await bulk.map({ ...baseRequest, preview: 0 })).preview).toEqual([])
    expect((await bulk.map({ ...baseRequest, preview: -5 })).preview).toEqual([])
  })

  it("clamps large previews to MAX_PREVIEW_SIZE", async () => {
    const { bulk } = service({ rows: records(60) })
    expect((await bulk.map({ ...baseRequest, preview: 999 })).preview).toHaveLength(50)
  })
})

describe("cache bypass", () => {
  it("skips the cache read but refreshes the cache with fresh answers", async () => {
    const { bulk, backend } = service({ rows: records(2) })
    await bulk.map({ ...baseRequest })
    expect(vi.mocked(backend.decide).mock.calls.length).toBe(2)

    // Bypass: cache has both records, yet the backend is called again.
    const bypassed = await bulk.map({ ...baseRequest, cache: "bypass" })
    expect(bypassed.summary.cached).toBe(0)
    expect(vi.mocked(backend.decide).mock.calls.length).toBe(4)

    // The bypass run's writes refreshed the cache: a normal run hits it again.
    const cached = await bulk.map({ ...baseRequest })
    expect(cached.summary.cached).toBe(2)
    expect(vi.mocked(backend.decide).mock.calls.length).toBe(4)
  })
})

describe("progress reporting", () => {
  it("reports every PROGRESS_INTERVAL completions and once at the end", async () => {
    const { bulk } = service({ rows: records(120) })
    const onProgress = vi.fn()
    await bulk.map({ ...baseRequest, onProgress })
    const dones = onProgress.mock.calls.map((call) => call[0])
    expect([...dones].sort((a, b) => a - b)).toEqual([50, 100, 120])
    expect(onProgress.mock.calls.every((call) => call[1] === 120)).toBe(true)
    expect(onProgress).toHaveBeenLastCalledWith(120, 120)
    expect(PROGRESS_INTERVAL).toBe(50)
  })

  it("reports a single record once", async () => {
    const { bulk } = service({ rows: records(1) })
    const onProgress = vi.fn()
    await bulk.map({ ...baseRequest, onProgress })
    expect(onProgress).toHaveBeenCalledTimes(1)
    expect(onProgress).toHaveBeenCalledWith(1, 1)
  })

  it("reports skipped records too", async () => {
    const { bulk } = service({ rows: records(8), backend: makeBackend(() => true) })
    const onProgress = vi.fn()
    await bulk.map({ ...baseRequest, onProgress })
    expect(onProgress).toHaveBeenLastCalledWith(8, 8)
  })
})

describe("framing context and input fingerprint", () => {
  it("composes context into projected state as the reserved $context key", async () => {
    const rows = [{ index: 0, key: "a", fields: { index: 0, text: "hi" } }]
    const { bulk, backend } = service({ rows })
    await bulk.map({ ...baseRequest, state: undefined, project: ["text"], context: "Rate for a comedy app." })
    expect(backend.decide).toHaveBeenCalledWith(
      expect.objectContaining({ state: { $context: "Rate for a comedy app.", text: "hi" } }),
    )
  })

  it("prepends context to string-template state", async () => {
    const rows = [{ index: 0, key: null, fields: { index: 0, text: "hi" } }]
    const { bulk, backend } = service({ rows })
    await bulk.map({ ...baseRequest, state: "Row: {{text}}", context: "Frame." })
    expect(backend.decide).toHaveBeenCalledWith(
      expect.objectContaining({ state: "Frame.\n\nRow: hi" }),
    )
  })

  it("fingerprints the instrument in summary.inputHash: stable, context-sensitive", async () => {
    const { bulk } = service({ rows: records(1) })
    const first = await bulk.map({ ...baseRequest, state: undefined, project: ["text"] })
    const second = await bulk.map({ ...baseRequest, state: undefined, project: ["text"] })
    expect(second.summary.inputHash).toBe(first.summary.inputHash)
    const reframed = await bulk.map({
      ...baseRequest,
      state: undefined,
      project: ["text"],
      context: "Frame.",
    })
    expect(reframed.summary.inputHash).not.toBe(first.summary.inputHash)
  })
})

describe("chunkResults", () => {
  it("chunks in RUN_PAGE_SIZE pages, empty-safe", () => {
    expect(chunkResults([])).toEqual([])
    const many = records(250).map((r) => ({ index: r.index, key: null, status: "ok" as const }))
    const pages = chunkResults(many)
    expect(pages).toHaveLength(3)
    expect(pages[0]!.results).toHaveLength(100)
    expect(pages[2]!.results).toHaveLength(50)
  })
})
