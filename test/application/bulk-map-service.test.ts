import { describe, expect, it, vi } from "vitest"
import { BulkMapService, MAX_RECORDS, chunkResults } from "../../src/application/bulk-map-service"
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
