import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Question } from "../../../src/domain/decision-types"

const decisionsCreateMock = vi.fn()

vi.mock("openai", () => {
  class OpenAI {
    decisions = { create: decisionsCreateMock }
    constructor(_options: unknown) {}
  }
  return { default: OpenAI, OpenAI }
})

import {
  OpenAIBackend,
  estimateOpenAiUsage,
  normalizeOpenAiAnswers,
} from "../../../src/adapters/backends/openai-backend"

const questions: Question[] = [
  { id: "b", type: "noul", instructions: "is it spam?" },
  { id: "c", type: "choice", instructions: "pick", criteria: { spam: "junk", ham: null } },
  { id: "s", type: "score", instructions: "rate", criteria: ["low", "high"] },
]

const signal = new AbortController().signal

describe("OpenAIBackend.decide", () => {
  beforeEach(() => {
    decisionsCreateMock.mockReset()
  })

  it("maps noul→predicate, choice→choices, score→levels and stringifies object state", async () => {
    decisionsCreateMock.mockResolvedValue({
      model: "gpt-6-luna-2026-09-30",
      answers: [
        { type: "predicate", name: "b", probability: 0.98 },
        { type: "choice", name: "c", choice: "spam", probabilities: [{ value: "spam", probability: 0.9 }, { junk: true }, null], confidence: 0.75 },
        { type: "score", name: "s", score: "high", probabilities: [{ label: "high", probability: 0.8 }], confidence: 0.9 },
      ],
      usage: { input_tokens: 500, output_tokens: 20 },
    })
    const response = await new OpenAIBackend("k").decide({ state: { text: "x" }, questions, model: "gpt-6-luna", signal })
    expect(decisionsCreateMock).toHaveBeenCalledWith({
      model: "gpt-6-luna",
      input: '{"text":"x"}',
      questions: [
        { type: "predicate", name: "b", instructions: "is it spam?" },
        {
          type: "choice",
          name: "c",
          instructions: "pick",
          choices: [{ value: "spam", description: "junk" }, { value: "ham" }],
        },
        { type: "score", name: "s", instructions: "rate", levels: [{ label: "low" }, { label: "high" }] },
      ],
    })
    expect(response.resolvedModel).toBe("gpt-6-luna-2026-09-30")
    expect(response.answers["b"]).toEqual({ type: "noul", pTrue: 0.98 })
    expect(response.answers["c"]).toMatchObject({ choice: "spam", probabilities: { spam: 0.9 }, confidence: 0.75 })
    expect(response.answers["s"]).toEqual({
      type: "score",
      score: 1,
      legend: "high",
      probabilities: { high: 0.8 },
      confidence: 0.9,
    })
    expect(response.usage).toEqual({ inputTokens: 500, outputTokens: 20, costUsd: 0.00005, costSource: "estimated" })
  })

  it("passes string state through and resolves the model", async () => {
    decisionsCreateMock.mockResolvedValue({
      answers: [
        { type: "predicate", name: "b", probability: 0.1 },
        { type: "choice", name: "c", choice: "ham", probabilities: "junk" },
        { type: "score", name: "s", score: 0, probabilities: [] },
      ],
      usage: {},
    })
    const response = await new OpenAIBackend("k").decide({
      state: "plain",
      questions: [questions[0]!, questions[1]!, questions[2]!],
      model: "gpt-6-luna",
      signal,
    })
    expect(decisionsCreateMock.mock.calls[0]![0].input).toBe("plain")
    expect(response.resolvedModel).toBe("gpt-6-luna")
    expect(response.usage.costUsd).toBeNull()
    expect(response.answers["c"]).toEqual({ type: "choice", choice: "ham", probabilities: {} })
    expect(response.answers["s"]).toEqual({ type: "score", score: 0, legend: "low", probabilities: {} })
  })

  it("treats refusals and missing answers as errors", async () => {
    decisionsCreateMock.mockResolvedValue({
      answers: [{ type: "refusal", name: "b" }],
      usage: {},
    })
    await expect(
      new OpenAIBackend("k").decide({ state: "s", questions: [questions[0]!], model: "m", signal }),
    ).rejects.toThrow(/was refused/)

    decisionsCreateMock.mockResolvedValue({ answers: [], usage: {} })
    await expect(
      new OpenAIBackend("k").decide({ state: "s", questions: [questions[0]!], model: "m", signal }),
    ).rejects.toThrow(/missing answer for question "b"/)
  })

  it("validates answer payloads and maps transport errors", async () => {
    decisionsCreateMock.mockResolvedValue({ answers: [{ type: "predicate", name: "b" }], usage: {} })
    await expect(
      new OpenAIBackend("k").decide({ state: "s", questions: [questions[0]!], model: "m", signal }),
    ).rejects.toThrow(/missing probability/)

    decisionsCreateMock.mockResolvedValue({ answers: [{ type: "weird", name: "b" }], usage: {} })
    await expect(
      new OpenAIBackend("k").decide({ state: "s", questions: [questions[0]!], model: "m", signal }),
    ).rejects.toThrow(/unrecognized answer type/)

    decisionsCreateMock.mockResolvedValue({
      answers: [{ type: "choice", name: "c" }],
      usage: {},
    })
    await expect(
      new OpenAIBackend("k").decide({ state: "s", questions: [questions[1]!], model: "m", signal }),
    ).rejects.toThrow(/missing selection/)

    decisionsCreateMock.mockResolvedValue({
      answers: [{ type: "score", name: "s", score: 5 }],
      usage: {},
    })
    await expect(
      new OpenAIBackend("k").decide({ state: "s", questions: [questions[2]!], model: "m", signal }),
    ).rejects.toThrow(/does not match any criteria level/)

    decisionsCreateMock.mockResolvedValue({
      answers: [{ type: "score", name: "s", score: 1 }],
      usage: {},
    })
    await expect(
      new OpenAIBackend("k").decide({ state: "s", questions: [{ id: "s", type: "noul", instructions: "rate" }], model: "m", signal }),
    ).rejects.toThrow(/score answer for noul question/)

    decisionsCreateMock.mockRejectedValue(Object.assign(new Error("quota"), { status: 402 }))
    await expect(
      new OpenAIBackend("k").decide({ state: "s", questions: [questions[0]!], model: "m", signal }),
    ).rejects.toMatchObject({ message: "openai: quota" })
  })

  it("rejects non-object responses", async () => {
    decisionsCreateMock.mockResolvedValue(null)
    await expect(
      new OpenAIBackend("k").decide({ state: "s", questions: [questions[0]!], model: "m", signal }),
    ).rejects.toThrow(/response was not an object/)
  })
})

describe("normalizeOpenAiAnswers / estimateOpenAiUsage", () => {
  it("ignores entries without usable names and junk usage", () => {
    expect(
      normalizeOpenAiAnswers(
        [{ type: "predicate", probability: 0.5 }, "junk", { type: "predicate", name: "b", probability: 0.5 }],
        [questions[0]!],
      ),
    ).toEqual({ b: { type: "noul", pTrue: 0.5 } })
    expect(normalizeOpenAiAnswers(undefined, [])).toEqual({})
    expect(estimateOpenAiUsage("junk")).toEqual({ inputTokens: null, outputTokens: null, costUsd: null, costSource: null })
    expect(estimateOpenAiUsage({ input_tokens: -1, output_tokens: null })).toEqual({
      inputTokens: 0,
      outputTokens: null,
      costUsd: 0,
      costSource: "estimated",
    })
  })
})
