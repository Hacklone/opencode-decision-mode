import { describe, expect, it } from "vitest"
import { ResultsExportService } from "../../src/application/export-service"
import { sha256 } from "../../src/application/cache-key"
import type { RecordResult, RunSummary } from "../../src/domain/decision-types"
import type { RunStore } from "../../src/ports/run-store"
import type { FileSink } from "../../src/ports/file-sink"

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

const rows: RecordResult[] = [
  {
    index: 0,
    key: "a-1",
    status: "ok",
    record: { text: 'has "quotes", commas\nand newline', id: "a-1", _index: "shadow-me" },
    answers: {
      b: { type: "noul", pTrue: 0.91 },
      c: { type: "choice", choice: "spam", probabilities: {}, confidence: 0.8 },
      s: { type: "score", score: 2, legend: "high", probabilities: {} },
    },
    verdict: "FAIL",
    verdicts: { b: "FAIL" },
    usage: { inputTokens: 3, outputTokens: 1, costUsd: 0.0001, costSource: "provider" },
    cacheHit: true,
  },
  // No record snapshot at all on this row (defensive path in the CSV writer).
  { index: 1, key: null, status: "error", error: "boom" },
  {
    index: 2,
    key: "a-3",
    status: "ok",
    record: { id: "a-3", extra: { nested: true } },
    answers: {
      b: { type: "noul", pTrue: 0.2 },
      c: { type: "choice", choice: "ham", probabilities: {} },
      s: { type: "score", score: 1, legend: null, probabilities: {} },
    },
    verdict: "PASS",
    verdicts: { b: "PASS" },
    usage: { inputTokens: 2, outputTokens: 1, costUsd: null, costSource: null },
    cacheHit: false,
  },
]

function store(results: RecordResult[] | null): RunStore {
  return {
    saveRun: async () => {},
    getSummary: async (id) => (id === summary.id ? summary : null),
    getResults: async (id) => (id === summary.id ? results : null),
    listSummaries: async (limit = 20) => [summary].slice(0, limit),
  }
}

function memorySink() {
  const files = new Map<string, string>()
  const sink: FileSink = {
    write: async (path, content) => {
      files.set(path, content)
    },
  }
  return { files, service: new ResultsExportService(store(rows), sink) }
}

describe("ResultsExportService", () => {
  it("exports lossless jsonl with count, bytes and checksum", async () => {
    const { files, service } = memorySink()
    const meta = await service.export({ run: summary.id, path: "out/results.jsonl", format: "jsonl" })
    const content = files.get("out/results.jsonl")!
    expect(content.endsWith("\n")).toBe(true)
    expect(content.trim().split("\n").map((line) => JSON.parse(line))).toEqual(rows)
    expect(meta).toEqual({
      run: summary.id,
      path: "out/results.jsonl",
      format: "jsonl",
      records: 3,
      total: 3,
      bytes: new TextEncoder().encode(content).length,
      sha256: sha256(content),
    })
  })

  it("exports flat csv: reserved meta, answer + verdict columns, then unshadowed source fields", async () => {
    const { files, service } = memorySink()
    await service.export({ run: summary.id, path: "out/r.csv", format: "csv" })
    // Whole-content assertion: row 0 legitimately embeds a newline inside a quoted cell.
    expect(files.get("out/r.csv")).toBe(
      [
        "_index,_key,_status,_error,b,b_verdict,c,s,text,id,extra",
        "0,a-1,ok,,0.91,FAIL,spam,high,\"has \"\"quotes\"\", commas",
        "and newline\",a-1,",
        "1,,error,boom,,,,,,,",
        "2,a-3,ok,,0.2,PASS,ham,1,,a-3,\"{\"\"nested\"\":true}\"",
        "",
      ].join("\n"),
    )
    // "text,id,_index,extra" is the source-field union; "_index" is shadowed by the meta column.
  })

  it("applies status and verdict filters to the written set", async () => {
    const { files, service } = memorySink()
    const meta = await service.export({ run: summary.id, path: "out/f.jsonl", format: "jsonl", verdict: "PASS" })
    expect(meta.records).toBe(1)
    expect(meta.total).toBe(3)
    expect(JSON.parse(files.get("out/f.jsonl")!).key).toBe("a-3")

    const errored = await service.export({ run: summary.id, path: "out/e.jsonl", format: "jsonl", status: "error" })
    expect(errored.records).toBe(1)
  })

  it("writes an empty jsonl file and a header-only csv when nothing matches", async () => {
    const { files, service } = memorySink()
    const jsonl = await service.export({ run: summary.id, path: "out/0.jsonl", format: "jsonl", status: "error", verdict: "FAIL" })
    expect(jsonl).toMatchObject({ records: 0, bytes: 0, sha256: sha256("") })
    expect(files.get("out/0.jsonl")).toBe("")

    const csv = await service.export({ run: summary.id, path: "out/0.csv", format: "csv", status: "error", verdict: "FAIL" })
    expect(csv.records).toBe(0)
    expect(files.get("out/0.csv")).toBe("_index,_key,_status,_error\n")
  })

  it("rejects unknown runs and runs missing their results", async () => {
    const sink: FileSink = { write: async () => {} }
    await expect(
      new ResultsExportService(store(rows), sink).export({ run: "nope", path: "x.csv", format: "csv" }),
    ).rejects.toThrow(/unknown run "nope"/)
    await expect(
      new ResultsExportService(store(null), sink).export({ run: summary.id, path: "x.csv", format: "csv" }),
    ).rejects.toThrow(/is missing its results/)
  })
})
