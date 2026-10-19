import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Question } from "../../../src/domain/decision-types"

const createMock = vi.fn()

vi.mock("@openrouter/sdk", () => {
  class OpenRouter {
    alpha = { decisions: { create: createMock } }
    constructor(_options: unknown) {}
  }
  return { OpenRouter }
})

import { OpenRouterBackend, normalizeUsage } from "../../../src/adapters/backends/openrouter-backend"
import { normalizeAnswer, normalizeAnswers, normalizeProbabilityMap } from "../../../src/adapters/backends/answers"
import { BackendError } from "../../../src/ports/decision-backend"

const questions: Question[] = [
  { id: "b", type: "noul", instructions: "is it spam?" },
  { id: "c", type: "choice", instructions: "pick", criteria: { spam: "junk", ham: null } },
  { id: "s", type: "score", instructions: "rate", criteria: ["low", "high"] },
]

const signal = new AbortController().signal

describe("OpenRouterBackend.decide", () => {
  beforeEach(() => {
    createMock.mockReset()
  })

  it("maps questions into the decisions request and normalizes answers", async () => {
    createMock.mockResolvedValue({
      model: "typesafe/jev-1.14-20261001",
      answers: {
        b: { type: "noul", noul: 1.4 },
        c: { type: "choice", choice: "spam", probabilities: { spam: 0.9, ham: 0.05, junk: "bad" }, confidence: 0.8 },
        s: { type: "score", score: "high", legend: "high", probabilities: { high: 0.8 }, confidence: 2 },
      },
      usage: { input_tokens: 120.4, output_tokens: 8.6, cost: 0.0009 },
    })
    const response = await new OpenRouterBackend("k").decide({ state: { text: "x" }, questions, model: "typesafe/jev-1.14", signal })
    expect(createMock).toHaveBeenCalledWith({
      decisionsRequest: {
        model: "typesafe/jev-1.14",
        state: { text: "x" },
        questions: {
          b: { type: "noul", instructions: "is it spam?" },
          c: { type: "choice", instructions: "pick", criteria: { spam: "junk", ham: null } },
          s: { type: "score", instructions: "rate", criteria: ["low", "high"] },
        },
      },
    })
    expect(response.resolvedModel).toBe("typesafe/jev-1.14-20261001")
    expect(response.answers["b"]).toEqual({ type: "noul", pTrue: 1 })
    expect(response.answers["c"]).toMatchObject({ choice: "spam", probabilities: { spam: 0.9, ham: 0.05 }, confidence: 0.8 })
    expect(response.answers["s"]).toMatchObject({ score: 1, legend: "high", confidence: 1 })
    expect(response.usage).toEqual({ inputTokens: 120, outputTokens: 9, costUsd: 0.0009, costSource: "provider" })
  })

  it("noul questions carry criteria when provided", async () => {
    createMock.mockResolvedValue({ answers: { b: { type: "noul", noul: 0.1 } }, usage: {} })
    const withCriteria: Question[] = [{ id: "b", type: "noul", instructions: "x", criteria: { true: "t", false: "f" } }]
    await new OpenRouterBackend("k").decide({ state: "s", questions: withCriteria, model: "m", signal })
    expect(createMock.mock.calls[0]![0].decisionsRequest.questions["b"]).toEqual({
      type: "noul",
      instructions: "x",
      criteria: { true: "t", false: "f" },
    })
  })

  it("falls back to the requested model and tolerates a missing usage block", async () => {
    createMock.mockResolvedValue({ answers: { b: { type: "noul", noul: 0.1 } } })
    const response = await new OpenRouterBackend("k").decide({ state: "s", questions: [questions[0]!], model: "m", signal })
    expect(response.resolvedModel).toBe("m")
    expect(response.usage).toEqual({ inputTokens: null, outputTokens: null, costUsd: null, costSource: null })
  })

  it("fails loudly on missing answers and unknown answer types", async () => {
    createMock.mockResolvedValue({ answers: {}, usage: {} })
    await expect(
      new OpenRouterBackend("k").decide({ state: "s", questions, model: "m", signal }),
    ).rejects.toThrow(/missing answer for question "b"/)

    createMock.mockResolvedValue({ answers: { b: { type: "weird" } }, usage: {} })
    await expect(
      new OpenRouterBackend("k").decide({ state: "s", questions: [questions[0]!], model: "m", signal }),
    ).rejects.toThrow(/unrecognized answer type/)

    createMock.mockResolvedValue({ answers: { b: { type: "noul" } }, usage: {} })
    await expect(
      new OpenRouterBackend("k").decide({ state: "s", questions: [questions[0]!], model: "m", signal }),
    ).rejects.toThrow(/missing probability/)
  })

  it("maps SDK errors through toBackendError", async () => {
    createMock.mockRejectedValue(Object.assign(new Error("overloaded"), { status: 529 }))
    await expect(
      new OpenRouterBackend("k").decide({ state: "s", questions: [questions[0]!], model: "m", signal }),
    ).rejects.toMatchObject({ message: "openrouter: overloaded", retryable: true })
  })

  it("rejects non-object and malformed responses", async () => {
    createMock.mockResolvedValue(null)
    await expect(
      new OpenRouterBackend("k").decide({ state: "s", questions: [questions[0]!], model: "m", signal }),
    ).rejects.toThrow(/response was not an object/)
    createMock.mockResolvedValue({ answers: null, usage: {} })
    await expect(
      new OpenRouterBackend("k").decide({ state: "s", questions: [questions[0]!], model: "m", signal }),
    ).rejects.toThrow(/answers was not an object/)
  })
})

describe("normalization helpers", () => {
  it("normalizeAnswer validates choice/score shapes", () => {
    expect(() => normalizeAnswer({ type: "choice" }, questions[1]!, "openrouter")).toThrow(/missing selection/)
    // Fractional scores are legitimate (probability-weighted position); numbers
    // outside the range clamp to the nearest level instead of failing.
    expect(normalizeAnswer({ type: "score", score: 9 }, questions[2]!, "openrouter")).toMatchObject({ score: 1, legend: "high" })
    expect(normalizeAnswer({ type: "score", score: 0.4 }, questions[2]!, "openrouter")).toMatchObject({ score: 0.4, legend: "low" })
    expect(() => normalizeAnswer({ type: "score", score: 0 }, questions[0]!, "openrouter")).toThrow(/score answer for noul question/)
    const noLegend = normalizeAnswer({ type: "score", score: 1 }, questions[2]!, "openrouter")
    expect(noLegend).toMatchObject({ score: 1, legend: "high" })
  })

  it("normalizeAnswers maps the whole answer set", () => {
    const answers = normalizeAnswers(
      {
        b: { type: "noul", noul: 0.5 },
        c: { type: "choice", choice: "ham", probabilities: null },
        s: { type: "score", score: 0, legend: "low" },
      },
      questions,
      "openrouter",
    )
    expect(Object.keys(answers)).toEqual(["b", "c", "s"])
    expect(answers["c"]).toEqual({ type: "choice", choice: "ham", probabilities: {} })
  })

  it("normalizeProbabilityMap keeps only numeric entries", () => {
    expect(normalizeProbabilityMap({ a: 0.5, b: "x", c: null })).toEqual({ a: 0.5 })
    expect(normalizeProbabilityMap("nope")).toEqual({})
  })

  it("normalizeUsage rounds and buckets cost provenance", () => {
    expect(normalizeUsage({ input_tokens: -5, output_tokens: 2.7, cost: 0.5 })).toEqual({
      inputTokens: 0,
      outputTokens: 3,
      costUsd: 0.5,
      costSource: "provider",
    })
    expect(normalizeUsage("junk")).toEqual({ inputTokens: null, outputTokens: null, costUsd: null, costSource: null })
  })
})
