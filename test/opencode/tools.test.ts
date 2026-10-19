import { describe, expect, it, vi } from "vitest"
import { buildTools, compactAnswers, reportProgress, resolveTarget, type ToolContext } from "../../src/opencode/tools"
import { DecisionService } from "../../src/application/decision-service"
import { BulkMapService } from "../../src/application/bulk-map-service"
import { ResultQueryService } from "../../src/application/result-query-service"
import { BackendManager } from "../../src/opencode/backend-manager"
import { SelectionStore } from "../../src/opencode/selection"
import { StorageCache } from "../../src/adapters/persistence/opencode-cache"
import { StorageRunStore } from "../../src/adapters/persistence/opencode-run-store"
import type { BackendRegistry } from "../../src/ports/decision-backend"
import type { CredentialSource } from "../../src/ports/credential-source"
import type { SourceReader } from "../../src/ports/source-reader"
import { kv } from "../fakes"

const signal = new AbortController().signal
const context: ToolContext = { signal, progress: vi.fn(async () => {}) }

const question = { id: "b", type: "noul", instructions: "is it spam?" }

function makeBackend(): NonNullable<BackendRegistry["openrouter"]> {
  return {
    provider: "openrouter",
    decide: vi.fn(async (request: { questions: Array<{ id: string; type: string; criteria?: unknown }> }) => ({
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
    })),
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
  return { selection, backends, decision, bulk, results }
}

async function decisionDeps(): Promise<{ deps: Awaited<ReturnType<typeof makeDeps>>; backend: ReturnType<typeof makeBackend> }> {
  const backend = makeBackend()
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
  const reader: SourceReader = { read: async () => [{ index: 0, key: "1", fields: { text: "hi" } }] }
  const deps = {
    selection,
    backends,
    decision: new DecisionService(backends.registry, cache),
    bulk: new BulkMapService(backends.registry, cache, store, reader),
    results: new ResultQueryService(store),
  }
  return { deps, backend }
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
})

describe("decision_results tool", () => {
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
