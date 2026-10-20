import { describe, expect, it, vi } from "vitest"
import { DecisionService } from "../../src/application/decision-service"
import type { BackendRegistry, DecisionBackend } from "../../src/ports/decision-backend"
import type { DecisionCache, CachedEntry } from "../../src/ports/cache"
import { MemoryKv } from "../fakes"
import { StorageCache } from "../../src/adapters/persistence/opencode-cache"

const signal = new AbortController().signal

const noulQuestion = { id: "b", type: "noul" as const, instructions: "is it spam?" }

function backend(answer: Record<string, unknown>, resolved = "typesafe/jev-1.13-20260917"): DecisionBackend {
  return {
    provider: "openrouter",
    decide: vi.fn(async () => ({
      provider: "openrouter" as const,
      requestedModel: "typesafe/jev-1.14",
      resolvedModel: resolved,
      answers: answer as Record<string, never>,
      usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.0007, costSource: "provider" as const },
    })),
  }
}

// Backends return provider-normalized answers (pTrue, choice, score index).
const noulAnswer = { b: { type: "noul", pTrue: 0.9 } }

function registry(b: DecisionBackend | null): BackendRegistry {
  return { openrouter: b, typesafe: null, openai: null }
}

describe("DecisionService", () => {
  it("calls the backend, applies verdicts, and reports provider cost", async () => {
    const cache: DecisionCache = { get: async () => null, set: async () => {} }
    const service = new DecisionService(registry(backend(noulAnswer)), cache)
    const outcome = await service.decide({
      state: { text: "buy now" },
      questions: [noulQuestion],
      provider: "openrouter",
      model: "typesafe/jev-1.14",
      signal,
    })
    expect(outcome.cacheHit).toBe(false)
    expect(outcome.resolvedModel).toBe("typesafe/jev-1.13-20260917")
    expect(outcome.verdicts).toEqual({ b: "FAIL" })
    expect(outcome.verdict).toBe("FAIL")
    expect(outcome.usage.costSource).toBe("provider")
  })

  it("serves identical requests from cache without touching the backend", async () => {
    const b = backend({ b: { type: "noul", pTrue: 0.2 } })
    const service = new DecisionService(registry(b), new StorageCache(new MemoryKv()))
    const request = {
      state: "same",
      questions: [noulQuestion],
      provider: "openrouter" as const,
      model: "typesafe/jev-1.14",
      signal,
    }
    const first = await service.decide(request)
    expect(first.cacheHit).toBe(false)
    const second = await service.decide(request)
    expect(second.cacheHit).toBe(true)
    expect(second.answers).toEqual(first.answers)
    expect(b.decide).toHaveBeenCalledTimes(1)
  })

  it("applies the caller's policy on cache hits (policy is not part of the key)", async () => {
    const entry: CachedEntry = {
      answers: { b: { type: "noul", pTrue: 0.7 } },
      usage: { inputTokens: 1, outputTokens: 1, costUsd: null, costSource: null },
      resolvedModel: "m",
    }
    const cache: DecisionCache = { get: async () => entry, set: async () => {} }
    const service = new DecisionService(registry(null), cache)
    const outcome = await service.decide({
      state: "s",
      questions: [noulQuestion],
      policy: { reviewAt: 0.65, failAt: 0.9 },
      provider: "openrouter",
      model: "m",
      signal,
    })
    expect(outcome.verdicts).toEqual({ b: "REVIEW" })
  })

  it("throws when no backend is configured for the provider", async () => {
    const service = new DecisionService(registry(null), { get: async () => null, set: async () => {} })
    await expect(
      service.decide({ state: "s", questions: [noulQuestion], provider: "openrouter", model: "m", signal }),
    ).rejects.toThrow(/no backend configured for provider openrouter/)
  })

  it("cache bypass skips the read but refreshes the cache", async () => {
    const b = backend({ b: { type: "noul", pTrue: 0.2 } })
    const service = new DecisionService(registry(b), new StorageCache(new MemoryKv()))
    const request = {
      state: "same",
      questions: [noulQuestion],
      provider: "openrouter" as const,
      model: "typesafe/jev-1.14",
      signal,
    }
    await service.decide(request)
    const bypassed = await service.decide({ ...request, cache: "bypass" })
    expect(bypassed.cacheHit).toBe(false)
    expect(b.decide).toHaveBeenCalledTimes(2)
    // The bypass run's write refreshed the cache: the next normal call hits it.
    const after = await service.decide(request)
    expect(after.cacheHit).toBe(true)
    expect(b.decide).toHaveBeenCalledTimes(2)
  })

  it("composes the context preamble into the state before caching and calling", async () => {
    const b = backend({ b: { type: "noul", pTrue: 0.2 } })
    const service = new DecisionService(registry(b), new StorageCache(new MemoryKv()))
    const request = {
      state: { text: "hi" },
      context: "Frame.",
      questions: [noulQuestion],
      provider: "openrouter" as const,
      model: "typesafe/jev-1.14",
      signal,
    }
    await service.decide(request)
    expect(b.decide).toHaveBeenCalledWith(expect.objectContaining({ state: { $context: "Frame.", text: "hi" } }))
    // The composed state is what the cache keys on: same context hits, a changed context re-calls.
    const again = await service.decide(request)
    expect(again.cacheHit).toBe(true)
    await service.decide({ ...request, context: "Other frame." })
    expect(b.decide).toHaveBeenCalledTimes(2)
  })

  it("asks confidence-bearing noul questions as two-level scores and resugars the answer", async () => {
    const b = backend({ g: { type: "score", score: 0.93, legend: null, confidence: 0.88 } })
    const service = new DecisionService(registry(b), new StorageCache(new MemoryKv()))
    const request = {
      state: "s",
      questions: [{ id: "g", type: "noul" as const, instructions: "TRUE if the gate fails", withConfidence: true }],
      provider: "openrouter" as const,
      model: "m",
      signal,
    }
    const outcome = await service.decide(request)
    expect(b.decide).toHaveBeenCalledWith(
      expect.objectContaining({
        questions: [
          {
            id: "g",
            type: "score",
            instructions: "TRUE if the gate fails",
            criteria: ["false — the predicate does not hold", "true — the predicate holds"],
          },
        ],
      }),
    )
    expect(outcome.answers.g).toEqual({ type: "noul", pTrue: 0.93, confidence: 0.88 })
    expect(outcome.verdicts).toEqual({ g: "FAIL" })
    // The cache stores the raw provider shape; a cache hit resugars it again.
    const second = await service.decide(request)
    expect(second.cacheHit).toBe(true)
    expect(second.answers.g).toEqual({ type: "noul", pTrue: 0.93, confidence: 0.88 })
    expect(b.decide).toHaveBeenCalledTimes(1)
  })

  it("shares the cache between a confidence-bearing noul and the equivalent two-level score", async () => {
    const b = backend({ g: { type: "score", score: 0.93, legend: null, confidence: 0.88 } })
    const service = new DecisionService(registry(b), new StorageCache(new MemoryKv()))
    const criteria = ["false — the predicate does not hold", "true — the predicate holds"]
    const scoreRequest = {
      state: "s",
      questions: [{ id: "g", type: "score" as const, instructions: "TRUE if the gate fails", criteria }],
      provider: "openrouter" as const,
      model: "m",
      signal,
    }
    await service.decide(scoreRequest)
    const outcome = await service.decide({
      ...scoreRequest,
      questions: [{ id: "g", type: "noul" as const, instructions: "TRUE if the gate fails", withConfidence: true }],
    })
    expect(outcome.cacheHit).toBe(true)
    expect(outcome.answers.g).toEqual({ type: "noul", pTrue: 0.93, confidence: 0.88 })
    expect(b.decide).toHaveBeenCalledTimes(1)
  })
})
