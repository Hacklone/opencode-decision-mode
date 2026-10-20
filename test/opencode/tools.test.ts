import { describe, expect, it, vi } from "vitest"
import { buildTools, compactAnswers, reportProgress, resolveTarget, type ToolContext } from "../../src/opencode/tools"
import { DecisionService } from "../../src/application/decision-service"
import { BulkMapService } from "../../src/application/bulk-map-service"
import { ResultQueryService } from "../../src/application/result-query-service"
import { ResultsExportService } from "../../src/application/export-service"
import { BackendManager } from "../../src/opencode/backend-manager"
import { SelectionStore } from "../../src/opencode/selection"
import { StorageCache } from "../../src/adapters/persistence/opencode-cache"
import { StorageRunStore } from "../../src/adapters/persistence/opencode-run-store"
import { BackendError, type BackendRegistry } from "../../src/ports/decision-backend"
import type { CredentialSource } from "../../src/ports/credential-source"
import type { SourceReader } from "../../src/ports/source-reader"
import { kv } from "../fakes"

const signal = new AbortController().signal
const context: ToolContext = { signal, progress: vi.fn(async () => {}) }

import type { Question } from "../../src/domain/decision-types"

const question: Question = { id: "b", type: "noul", instructions: "is it spam?" }

function memorySink() {
  const files = new Map<string, string>()
  return {
    files,
    sink: { write: async (path: string, content: string) => { files.set(path, content) } },
  }
}

function makeBackend(fail: (index: number) => boolean = () => false): NonNullable<BackendRegistry["openrouter"]> {
  return {
    provider: "openrouter",
    decide: vi.fn(async (request: { state: unknown; questions: Array<{ id: string; type: string; criteria?: unknown }> }) => {
      if (fail(Number((request.state as { index?: number }).index ?? -1))) throw new BackendError("provider hiccup")
      return {
        provider: "openrouter" as const,
        requestedModel: "typesafe/jev-1.14",
        resolvedModel: "typesafe/jev-1.14-20261001",
        answers: Object.fromEntries(
          request.questions.map((q) => {
            if (q.type === "noul") return [q.id, { type: "noul", pTrue: 0.95 }]
            if (q.type === "choice") return [q.id, { type: "choice", choice: Object.keys(q.criteria ?? {})[0]!, probabilities: {} }]
            return [q.id, { type: "score", score: 0, legend: (q.criteria as string[])[0]!, probabilities: {} }]
          }),
        ),
        usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.0007, costSource: "provider" as const },
      }
    }),
  } as never
}

async function makeDeps(options?: { reader?: SourceReader }) {
  const selection = new SelectionStore(kv())
  await selection.load()
  const credentials: CredentialSource = {
    resolve: async (provider) => (provider === "openrouter" ? "k" : null),
    available: async () => true,
  }
  const backends = new BackendManager(credentials)
  await backends.bootstrap()
  const cache = new StorageCache(kv())
  const store = new StorageRunStore(kv())
  const reader: SourceReader =
    options?.reader ?? { read: async () => [{ index: 0, key: "1", fields: { text: "hi" } }] }
  const decision = new DecisionService(backends.registry, cache)
  const bulk = new BulkMapService(backends.registry, cache, store, reader, () => 0)
  const results = new ResultQueryService(store)
  const { files, sink } = memorySink()
  const exporter = new ResultsExportService(store, sink)
  return { selection, backends, decision, bulk, results, exporter, files }
}

async function decisionDeps(options?: {
  fail?: (index: number) => boolean
  rows?: number
}): Promise<{
  deps: Awaited<ReturnType<typeof makeDeps>>
  backend: ReturnType<typeof makeBackend>
  files: Map<string, string>
}> {
  const backend = makeBackend(options?.fail ?? (() => false))
  const selection = new SelectionStore(kv())
  await selection.load()
  const backends = new BackendManager({
    resolve: async (provider) => (provider === "openrouter" ? "k" : null),
    available: async () => true,
  })
  await backends.bootstrap()
  backends.registry["openrouter"] = backend
  const cache = new StorageCache(kv())
  const store = new StorageRunStore(kv())
  const rows = Array.from({ length: options?.rows ?? 1 }, (_, i) => ({
    index: i,
    key: String(i + 1),
    fields: i === 0 ? { text: "hi" } : { index: i, text: `row ${i}` },
  }))
  const reader: SourceReader = { read: async () => rows }
  const { files, sink } = memorySink()
  const deps: Awaited<ReturnType<typeof makeDeps>> = {
    selection,
    backends,
    decision: new DecisionService(backends.registry, cache),
    bulk: new BulkMapService(backends.registry, cache, store, reader),
    results: new ResultQueryService(store),
    exporter: new ResultsExportService(store, sink),
    files,
  }
  return { deps, backend, files }
}

describe("decision tool", () => {
  it("has a focused schema and returns a compact decision payload", async () => {
    const { deps } = await decisionDeps()
    const decision = buildTools(deps)[0]!
    expect(decision.name).toBe("decision")
    expect(decision.inputSchema["required"]).toEqual(["state", "questions"])
    const output = JSON.parse((await decision.execute({ state: "hi", questions: [question] }, context)).content)
    expect(output).toMatchObject({
      provider: "openrouter",
      model: "typesafe/jev-1.14-20261001",
      cached: false,
      verdict: "FAIL",
      verdicts: { b: "FAIL" },
      answers: { b: { type: "noul", pTrue: 0.95 } },
    })
  })

  it("desugars withConfidence noul into a two-level score and answers noul-shaped with confidence", async () => {
    const { deps, backend } = await decisionDeps()
    ;(backend.decide as ReturnType<typeof vi.fn>).mockResolvedValue({
      provider: "openrouter",
      requestedModel: "typesafe/jev-1.14",
      resolvedModel: "typesafe/jev-1.14-20261001",
      answers: { b: { type: "score", score: 0.93, legend: null, confidence: 0.88 } },
      usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.0007, costSource: "provider" as const },
    })
    const decision = buildTools(deps)[0]!
    const output = JSON.parse(
      (
        await decision.execute(
          {
            state: "hi",
            questions: [{ id: "b", type: "noul", instructions: "is it spam?", withConfidence: true }],
          },
          context,
        )
      ).content,
    )
    // The provider saw the desugared two-level score (level 0 = false, level 1 = true).
    expect(backend.decide).toHaveBeenCalledWith(
      expect.objectContaining({
        questions: [
          {
            id: "b",
            type: "score",
            instructions: "is it spam?",
            criteria: ["false — the predicate does not hold", "true — the predicate holds"],
          },
        ],
      }),
    )
    // The caller sees the noul shape they asked for, plus real confidence.
    expect(output.answers).toEqual({ b: { type: "noul", pTrue: 0.93, confidence: 0.88 } })
    expect(output.verdict).toBe("FAIL")
  })

  it("propagates invalid questions as errors", async () => {
    const { deps } = await decisionDeps()
    const decision = buildTools(deps)[0]!
    await expect(decision.execute({ state: "x", questions: [] }, context)).rejects.toThrow(/at least one question/)
    await expect(decision.execute({ state: "x", questions: [{ id: "b", type: "weird", instructions: "y" }] }, context)).rejects.toThrow(
      /type must be one of/,
    )
    await expect(decision.execute({ state: "x", questions: [question], policy: { reviewAt: 5 } }, context)).rejects.toThrow(
      /number in \[0, 1\]/,
    )
  })
})

describe("decision_map tool", () => {
  it("projects named fields as the raw-typed state object", async () => {
    const { deps, backend } = await decisionDeps()
    const map = buildTools(deps)[1]!
    const output = JSON.parse(
      (
        await map.execute(
          { source: { path: "data.csv" }, project: ["text"], questions: [question] },
          context,
        )
      ).content,
    )
    expect(output.summary.total).toBe(1)
    expect(backend.decide).toHaveBeenCalledWith(expect.objectContaining({ state: { text: "hi" } }))
  })

  it("composes context into projected state and fingerprints the instrument", async () => {
    const { deps, backend } = await decisionDeps()
    const map = buildTools(deps)[1]!
    const output = JSON.parse(
      (
        await map.execute(
          { source: { path: "data.csv" }, project: ["text"], context: "Rate for a comedy app.", questions: [question] },
          context,
        )
      ).content,
    )
    expect(backend.decide).toHaveBeenCalledWith(
      expect.objectContaining({ state: { $context: "Rate for a comedy app.", text: "hi" } }),
    )
    expect(typeof output.summary.inputHash).toBe("string")
  })

  it("prepends context to string states on the single decision tool", async () => {
    const { deps, backend } = await decisionDeps()
    const decision = buildTools(deps)[0]!
    await decision.execute({ state: "x", context: "Frame.", questions: [question] }, context)
    expect(backend.decide).toHaveBeenCalledWith(expect.objectContaining({ state: "Frame.\n\nx" }))
  })

  it("rejects a non-string or empty context", async () => {
    const { deps } = await decisionDeps()
    const [decision, map] = buildTools(deps)
    if (decision === undefined || map === undefined) throw new Error("tools missing")
    await expect(decision.execute({ state: "x", context: 42, questions: [question] }, context)).rejects.toThrow(
      /context must be a non-empty string/,
    )
    await expect(decision.execute({ state: "x", context: "", questions: [question] }, context)).rejects.toThrow(
      /context must be a non-empty string/,
    )
    await expect(
      map.execute({ source: { path: "d.csv" }, project: ["text"], context: 7, questions: [question] }, context),
    ).rejects.toThrow(/context must be a non-empty string/)
  })

  it("validates project and its exclusivity with state", async () => {
    const { deps } = await decisionDeps()
    const map = buildTools(deps)[1]!
    await expect(
      map.execute({ source: { path: "d.csv" }, state: "$record", project: ["text"], questions: [question] }, context),
    ).rejects.toThrow(/state and project are mutually exclusive/)
    await expect(map.execute({ source: { path: "d.csv" }, questions: [question] }, context)).rejects.toThrow(
      /state or project is required/,
    )
    await expect(
      map.execute({ source: { path: "d.csv" }, project: "text", questions: [question] }, context),
    ).rejects.toThrow(/project must be a non-empty array of field names/)
    await expect(
      map.execute({ source: { path: "d.csv" }, project: [], questions: [question] }, context),
    ).rejects.toThrow(/project must be a non-empty array of field names/)
    await expect(
      map.execute({ source: { path: "d.csv" }, project: ["text", ""], questions: [question] }, context),
    ).rejects.toThrow(/project\[1\] must be a non-empty string/)
  })

  it("infers format from the path and returns summary + preview", async () => {
    const { deps } = await decisionDeps()
    const map = buildTools(deps)[1]!
    expect(map.name).toBe("decision_map")
    const output = JSON.parse(
      (
        await map.execute(
          { source: { path: "data.csv" }, state: "$record", questions: [question] },
          context,
        )
      ).content,
    )
    expect(output.run).toMatch(/^run_/)
    expect(output.summary.total).toBe(1)
    expect(output.preview).toHaveLength(1)
  })

  it("validates source shape and format inference", async () => {
    const { deps } = await decisionDeps()
    const map = buildTools(deps)[1]!
    await expect(map.execute({ source: "junk", state: "$record", questions: [question] }, context)).rejects.toThrow(
      /source must be an object/,
    )
    await expect(map.execute({ source: { path: "" }, state: "$record", questions: [question] }, context)).rejects.toThrow(
      /non-empty string/,
    )
    await expect(map.execute({ source: { path: "x.txt" }, state: "$record", questions: [question] }, context)).rejects.toThrow(
      /cannot infer source format/,
    )
    await expect(map.execute({ source: { path: "x.csv" }, state: "$record" }, context)).rejects.toThrow(
      /questions must be an array/,
    )
  })

  it("uses an explicit format override", async () => {
    const reader: SourceReader = { read: vi.fn(async () => []) }
    const deps = await makeDeps({ reader })
    const map = buildTools(deps)[1]!
    await map.execute(
      { source: { path: "weird.bin", format: "jsonl" }, state: "$record", questions: [question] },
      context,
    )
    expect(reader.read).toHaveBeenCalledWith("weird.bin", "jsonl")
  })

  it("peeks at records with source.sample without judging or requiring state/questions", async () => {
    const reader: SourceReader = {
      read: vi.fn(async () => [
        { index: 0, key: "1", fields: { text: "hi" } },
        { index: 1, key: null, fields: { text: "there" } },
      ]),
    }
    const deps = await makeDeps({ reader })
    const map = buildTools(deps)[1]!
    const output = JSON.parse((await map.execute({ source: { path: "x.csv", sample: 5 } }, context)).content)
    expect(output).toEqual({
      path: "x.csv",
      format: "csv",
      sampled: 2,
      records: [
        { index: 0, key: "1", fields: { text: "hi" } },
        { index: 1, key: null, fields: { text: "there" } },
      ],
    })
  })

  it("requires state when actually mapping", async () => {
    const { deps } = await decisionDeps()
    const map = buildTools(deps)[1]!
    await expect(map.execute({ source: { path: "x.csv" }, questions: [question] }, context)).rejects.toThrow(
      /state or project is required/,
    )
  })
})

describe("decision_results tool", () => {
  it("rejects unknown status/verdict filter values", async () => {
    const { deps } = await decisionDeps()
    const resultsTool = buildTools(deps)[2]!
    await expect(resultsTool.execute({ run: "r", status: "maybe" }, context)).rejects.toThrow(
      'status must be "ok" or "error"',
    )
    await expect(resultsTool.execute({ run: "r", verdict: "MAYBE" }, context)).rejects.toThrow(
      'verdict must be "PASS", "REVIEW" or "FAIL"',
    )
  })

  it("lists runs when no run id is given", async () => {
    const { deps } = await decisionDeps()
    const resultsTool = buildTools(deps)[2]!
    const output = JSON.parse((await resultsTool.execute({}, context)).content)
    expect(output.runs).toEqual([])
    const output2 = JSON.parse((await resultsTool.execute({ list: true, run: "ignored" }, context)).content)
    expect(output2.runs).toEqual([])
  })

  it("honors policy, concurrency, offset/limit and reports no verdict for non-boolean answers", async () => {
    const { deps } = await decisionDeps()
    const decision = buildTools(deps)[0]!
    const map = buildTools(deps)[1]!
    const choiceOnly = { id: "c", type: "choice", instructions: "pick", criteria: { a: null, b: null } }
    const noVerdict = JSON.parse(
      (await decision.execute({ state: "x", questions: [choiceOnly] }, context)).content,
    )
    expect(noVerdict.verdict).toBeNull()

    const run = JSON.parse(
      (
        await map.execute(
          {
            source: { path: "data.csv", offset: 0, limit: 1 },
            state: "$record",
            questions: [question],
            policy: { reviewAt: 0.9, failAt: 0.99 },
            concurrency: 2,
          },
          context,
        )
      ).content,
    )
    expect(run.summary.total).toBe(1)
    expect(run.preview[0].verdict).toBe("REVIEW") // 0.95 with lifted thresholds
  })

  it("queries a stored run", async () => {
    const { deps } = await decisionDeps()
    const map = buildTools(deps)[1]!
    const resultsTool = buildTools(deps)[2]!
    const run = JSON.parse(
      (
        await map.execute(
          { source: { path: "data.csv" }, state: "$record", questions: [question] },
          context,
        )
      ).content,
    )
    const page = JSON.parse((await resultsTool.execute({ run: run.run }, context)).content)
    expect(page.matched).toBe(1)
    expect(page.results[0]).toMatchObject({ index: 0, key: "1", status: "ok", verdict: "FAIL" })
    const errors = JSON.parse(
      (await resultsTool.execute({ run: run.run, status: "error", verdict: "FAIL", detail: "full" }, context)).content,
    )
    expect(errors.matched).toBe(0)
    await expect(resultsTool.execute({ run: "nope" }, context)).rejects.toThrow(/unknown run/)
  })

  it("re-derives verdicts from stored answers under a new policy", async () => {
    const { deps } = await decisionDeps()
    const map = buildTools(deps)[1]!
    const resultsTool = buildTools(deps)[2]!
    const run = JSON.parse(
      (
        await map.execute(
          { source: { path: "data.csv" }, state: "$record", questions: [question] },
          context,
        )
      ).content,
    )
    // Stored: pTrue 0.95 under default {0.6/0.85} → FAIL. No new provider call.
    const page = JSON.parse(
      (await resultsTool.execute({ run: run.run, policy: { reviewAt: 0.97, failAt: 0.99 } }, context)).content,
    )
    expect(page.results[0].verdict).toBe("PASS")
    expect(page.results[0].verdicts).toEqual({ b: "PASS" })
    // Filter applies to the re-derived verdicts, not the stored ones.
    const reviews = JSON.parse(
      (await resultsTool.execute({ run: run.run, verdict: "REVIEW", policy: { reviewAt: 0.9, failAt: 0.99 } }, context))
        .content,
    )
    expect(reviews.matched).toBe(1)
    await expect(
      resultsTool.execute({ run: run.run, policy: { reviewAt: 5 } }, context),
    ).rejects.toThrow(/number in \[0, 1\]/)
  })
})

describe("file export", () => {
  it("decision_map writes the full result set and returns only metadata", async () => {
    const { deps, files } = await decisionDeps()
    const map = buildTools(deps)[1]!
    const output = JSON.parse(
      (
        await map.execute(
          { source: { path: "data.csv" }, state: "$record", questions: [question], output: { path: "out/results.csv" } },
          context,
        )
      ).content,
    )
    expect(output.run).toBe(output.export.run)
    expect(output.export).toMatchObject({ path: "out/results.csv", format: "csv", records: 1, total: 1 })
    expect(output.export.sha256).toMatch(/^[0-9a-f]{64}$/)
    const written = files.get("out/results.csv")!
    expect(written.split("\n")).toEqual([
      "_index,_key,_status,_error,b,b_verdict,text",
      "0,1,ok,,0.95,FAIL,hi",
      "",
    ])
    expect(output.export.bytes).toBe(new TextEncoder().encode(written).length)
  })

  it("decision_results output exports jsonl losslessly and honors filters", async () => {
    const { deps, files } = await decisionDeps()
    const map = buildTools(deps)[1]!
    const resultsTool = buildTools(deps)[2]!
    const run = JSON.parse(
      (await map.execute({ source: { path: "data.csv" }, state: "$record", questions: [question] }, context)).content,
    )
    const exported = JSON.parse(
      (await resultsTool.execute({ run: run.run, output: { path: "res.jsonl" } }, context)).content,
    )
    expect(Object.keys(exported)).toEqual(["export"])
    expect(exported.export.records).toBe(1)
    const row = JSON.parse(files.get("res.jsonl")!.trim())
    expect(row).toMatchObject({ index: 0, key: "1", status: "ok", answers: { b: { type: "noul" } }, record: { text: "hi" } })
    expect(row.usage).toBeDefined()

    const none = JSON.parse(
      (await resultsTool.execute({ run: run.run, status: "error", output: { path: "errs.csv" } }, context)).content,
    )
    expect(none.export).toMatchObject({ records: 0, total: 1, format: "csv" })
    expect(files.get("errs.csv")).toBe("_index,_key,_status,_error\n")

    await expect(resultsTool.execute({ run: "nope", output: { path: "x.csv" } }, context)).rejects.toThrow(/unknown run/)
  })

  it("validates output shape and format inference", async () => {
    const { deps } = await decisionDeps()
    const map = buildTools(deps)[1]!
    await expect(
      map.execute({ source: { path: "d.csv" }, state: "$record", questions: [question], output: "junk" }, context),
    ).rejects.toThrow(/output must be an object/)
    await expect(
      map.execute({ source: { path: "d.csv" }, state: "$record", questions: [question], output: { path: "" } }, context),
    ).rejects.toThrow(/output.path must be a non-empty string/)
    await expect(
      map.execute({ source: { path: "d.csv" }, state: "$record", questions: [question], output: { path: "out.bin" } }, context),
    ).rejects.toThrow(/cannot infer output format/)
    // Validation happens before any provider spend: no run was created.
    const resultsTool = buildTools(deps)[2]!
    expect(JSON.parse((await resultsTool.execute({}, context)).content).runs).toEqual([])
  })

  it("export honors policy re-derivation in the verdict columns and filters", async () => {
    const { deps, files } = await decisionDeps()
    const map = buildTools(deps)[1]!
    const resultsTool = buildTools(deps)[2]!
    const run = JSON.parse(
      (await map.execute({ source: { path: "data.csv" }, state: "$record", questions: [question] }, context)).content,
    )
    const exported = JSON.parse(
      (
        await resultsTool.execute(
          { run: run.run, output: { path: "re.csv" }, policy: { reviewAt: 0.9, failAt: 0.99 } },
          context,
        )
      ).content,
    )
    expect(exported.export.records).toBe(1)
    expect(files.get("re.csv")).toBe("_index,_key,_status,_error,b,b_verdict,text\n0,1,ok,,0.95,REVIEW,hi\n")
    const none = JSON.parse(
      (
        await resultsTool.execute(
          { run: run.run, verdict: "FAIL", policy: { reviewAt: 0.9, failAt: 0.99 }, output: { path: "fails.csv" } },
          context,
        )
      ).content,
    )
    expect(none.export).toMatchObject({ records: 0, total: 1 })
  })
})

describe("polarity warnings", () => {
  it("does not warn when no question is noul", async () => {
    const { deps } = await decisionDeps()
    const decision = buildTools(deps)[0]!
    const single = JSON.parse(
      (
        await decision.execute(
          { state: "x", questions: [{ id: "c", type: "choice", instructions: "pick", criteria: { a: null } }] },
          context,
        )
      ).content,
    )
    expect(single.warnings).toBeUndefined()
  })

  it("surfaces warnings in decision and decision_map responses", async () => {
    const { deps } = await decisionDeps()
    const decision = buildTools(deps)[0]!
    const map = buildTools(deps)[1]!
    const single = JSON.parse((await decision.execute({ state: "x", questions: [question] }, context)).content)
    expect(single.warnings?.[0]).toMatch(/TRUE=bad polarity/)
    const mapped = JSON.parse(
      (await map.execute({ source: { path: "d.csv" }, state: "$record", questions: [question] }, context)).content,
    )
    expect(mapped.warnings?.[0]).toMatch(/TRUE=bad polarity/)
    const explicit = JSON.parse(
      (
        await map.execute(
          { source: { path: "d2.csv" }, state: "$record", questions: [question], policy: { reviewAt: 0.4, failAt: 0.9 } },
          context,
        )
      ).content,
    )
    expect(explicit.warnings).toBeUndefined()
  })
})

describe("systematic failure surfacing", () => {
  it("decision_map reports aborted and warns when the run bails out", async () => {
    const { deps, backend } = await decisionDeps({ fail: () => true, rows: 12 })
    const map = buildTools(deps)[1]!
    const output = JSON.parse(
      (await map.execute({ source: { path: "data.csv" }, state: "$record", questions: [question] }, context)).content,
    )
    expect(output.aborted).toMatchObject({ error: "provider hiccup" })
    expect(output.warnings[0]).toMatch(/Systematic failure: provider hiccup hit 6 records; \d+ remaining records were skipped/)
    expect(vi.mocked(backend.decide).mock.calls.length).toBeLessThanOrEqual(9)
    expect(output.summary.error).toBe(12)
  })

  it("warns on a high error rate without aborting", async () => {
    // Only records with an `index` field (rows 1..3) fail: 3/4 = 75% errors,
    // below the systematic threshold of 6 identical failures.
    const { deps } = await decisionDeps({ fail: (i) => i >= 1, rows: 4 })
    const map = buildTools(deps)[1]!
    const output = JSON.parse(
      (
        await map.execute(
          { source: { path: "data.csv" }, state: "$record", questions: [question], policy: { reviewAt: 0.6, failAt: 0.85 } },
          context,
        )
      ).content,
    )
    expect(output.aborted).toBeUndefined()
    expect(output.warnings).toEqual([expect.stringMatching(/High error rate \(3\/4\)/)])
  })
})

describe("resolveTarget", () => {
  it("prefers explicit overrides, then the pinned selection, then defaults", async () => {
    const { deps, backend } = await decisionDeps()
    expect(resolveTarget(deps, {})).toEqual({ provider: "openrouter", model: "typesafe/jev-1.14" })
    await deps.selection.set({ provider: "typesafe", model: "jev-preview" })
    expect(resolveTarget(deps, {})).toEqual({ provider: "typesafe", model: "jev-preview" })
    expect(resolveTarget(deps, { provider: "openai" })).toEqual({ provider: "openai", model: "gpt-6-luna" })
    expect(resolveTarget(deps, { model: "custom/m" })).toEqual({ provider: "typesafe", model: "custom/m" })
    void backend
  })
})

describe("compactAnswers", () => {
  it("keeps the decision, rounds confidence, drops distributions", () => {
    expect(
      compactAnswers({
        n: { type: "noul", pTrue: 0.123456 },
        c: { type: "choice", choice: "a", probabilities: { a: 1 }, confidence: 0.98765 },
        s: { type: "score", score: 2, legend: "high" },
      }),
    ).toEqual({
      n: { type: "noul", pTrue: 0.1235 },
      c: { type: "choice", choice: "a", confidence: 0.9877 },
      s: { type: "score", level: "high" },
    })
    expect(compactAnswers({ s: { type: "score", score: 1, legend: null } })).toEqual({
      s: { type: "score", level: "1" },
    })
  })
})

describe("reportProgress", () => {
  it("forwards status and swallows progress failures", async () => {
    await reportProgress({ signal, progress: vi.fn(async () => {}) }, "hi")
    await reportProgress({ signal, progress: vi.fn(async () => { throw new Error("nope") }) }, "hi")
  })
})

describe("preview, cache bypass, and progress", () => {
  it("omits the preview with preview:false and limits it numerically", async () => {
    const { deps } = await decisionDeps({ rows: 3 })
    const map = buildTools(deps)[1]!
    const off = JSON.parse(
      (await map.execute({ source: { path: "d.csv" }, project: ["text"], questions: [question], preview: false }, context)).content,
    )
    expect(off.preview).toBeUndefined()
    const two = JSON.parse(
      (await map.execute({ source: { path: "d.csv" }, project: ["text"], questions: [question], preview: 2 }, context)).content,
    )
    expect(two.preview).toHaveLength(2)
    const none = JSON.parse(
      (await map.execute({ source: { path: "d.csv" }, project: ["text"], questions: [question], preview: 0 }, context)).content,
    )
    expect(none.preview).toBeUndefined()
    const yes = JSON.parse(
      (await map.execute({ source: { path: "d.csv" }, project: ["text"], questions: [question], preview: true }, context)).content,
    )
    expect(yes.preview).toHaveLength(3)
  })

  it("rejects junk preview and cache values", async () => {
    const { deps } = await decisionDeps()
    const map = buildTools(deps)[1]!
    await expect(
      map.execute({ source: { path: "d.csv" }, project: ["text"], questions: [question], preview: "all" }, context),
    ).rejects.toThrow(/preview must be a boolean or an integer between 0 and 50/)
    await expect(
      map.execute({ source: { path: "d.csv" }, project: ["text"], questions: [question], preview: 51 }, context),
    ).rejects.toThrow(/preview must be a boolean or an integer between 0 and 50/)
    await expect(
      map.execute({ source: { path: "d.csv" }, project: ["text"], questions: [question], cache: "fresh" }, context),
    ).rejects.toThrow('cache must be "bypass"')
  })

  it("bypasses the cache on identical records and still refreshes it", async () => {
    const { deps, backend } = await decisionDeps({ rows: 2 })
    const map = buildTools(deps)[1]!
    const input = { source: { path: "d.csv" }, project: ["text"], questions: [question] }
    await map.execute(input, context)
    expect(vi.mocked(backend.decide).mock.calls.length).toBe(2)
    const bypassed = JSON.parse((await map.execute({ ...input, cache: "bypass" }, context)).content)
    expect(bypassed.summary.cached).toBe(0)
    expect(vi.mocked(backend.decide).mock.calls.length).toBe(4)
    const cached = JSON.parse((await map.execute(input, context)).content)
    expect(cached.summary.cached).toBe(2)
  })

  it("bypasses the cache for a single decision", async () => {
    const { deps } = await decisionDeps()
    const decision = buildTools(deps)[0]!
    const first = JSON.parse((await decision.execute({ state: "x", questions: [question] }, context)).content)
    expect(first.cached).toBe(false)
    const second = JSON.parse((await decision.execute({ state: "x", questions: [question] }, context)).content)
    expect(second.cached).toBe(true)
    const bypassed = JSON.parse(
      (await decision.execute({ state: "x", questions: [question], cache: "bypass" }, context)).content,
    )
    expect(bypassed.cached).toBe(false)
  })

  it("reports judged N/M progress during a run", async () => {
    const { deps } = await decisionDeps({ rows: 3 })
    const map = buildTools(deps)[1]!
    const progress = vi.fn(async (_update: Record<string, unknown>) => {})
    await map.execute(
      { source: { path: "d.csv" }, project: ["text"], questions: [question] },
      { signal, progress },
    )
    const statuses = progress.mock.calls.map((call) => call[0]!.status)
    expect(statuses[0]).toBe("decision_map: starting run")
    expect(statuses.at(-1)).toBe("decision_map: judged 3/3")
  })
})
