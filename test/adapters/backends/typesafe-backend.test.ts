import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Question } from "../../../src/domain/decision-types"

const systemOneMock = vi.fn()

vi.mock("@typesafe-ai/sdk", () => {
  class TypeSafeClient {
    systemOne = systemOneMock
    constructor(_options: unknown) {}
  }
  return { TypeSafeClient }
})

const KEY = "ts-key"

import { TypesafeBackend, estimateTypesafeUsage } from "../../../src/adapters/backends/typesafe-backend"

const question: Question = { id: "b", type: "noul", instructions: "is it spam?" }
const signal = new AbortController().signal

describe("TypesafeBackend.decide", () => {
  beforeEach(() => {
    systemOneMock.mockReset()
  })

  it("sends state, model and questions; estimates cost from input tokens", async () => {
    systemOneMock.mockResolvedValue({
      model: "jev-1.13.0",
      answers: { b: { type: "noul", noul: 0.7 } },
      usage: { input_tokens: 1_000_000, output_tokens: 10 },
    })
    const response = await new TypesafeBackend(KEY).decide({ state: { a: 1 }, questions: [question], model: "jev-latest", signal })
    expect(systemOneMock).toHaveBeenCalledWith({
      state: { a: 1 },
      questions: { b: question },
      model: "jev-latest",
    })
    expect(response.provider).toBe("typesafe")
    expect(response.resolvedModel).toBe("jev-1.13.0")
    expect(response.usage).toEqual({ inputTokens: 1_000_000, outputTokens: 10, costUsd: 0.042, costSource: "estimated" })
  })

  it("supports disabling compression", async () => {
    systemOneMock.mockResolvedValue({ answers: { b: { type: "noul", noul: 0.7 } } })
    await new TypesafeBackend(KEY, { compression: false }).decide({ state: "s", questions: [question], model: "jev-latest", signal })
    expect(systemOneMock).toHaveBeenCalledTimes(1)
  })

  it("falls back to the requested model and tolerates a missing usage block", async () => {
    systemOneMock.mockResolvedValue({ answers: { b: { type: "noul", noul: 0.7 } } })
    const response = await new TypesafeBackend(KEY).decide({ state: "s", questions: [question], model: "jev-latest", signal })
    expect(response.resolvedModel).toBe("jev-latest")
    expect(response.usage).toEqual({ inputTokens: null, outputTokens: null, costUsd: null, costSource: null })
  })

  it("maps provider errors through toBackendError", async () => {
    systemOneMock.mockRejectedValue(Object.assign(new Error("too large"), { status: 413 }))
    await expect(
      new TypesafeBackend(KEY).decide({ state: "s", questions: [question], model: "m", signal }),
    ).rejects.toMatchObject({ message: "typesafe: too large" })
  })

  it("rejects malformed responses and bad answer shapes", async () => {
    systemOneMock.mockResolvedValue(null)
    await expect(
      new TypesafeBackend(KEY).decide({ state: "s", questions: [question], model: "m", signal }),
    ).rejects.toThrow(/response was not an object/)

    systemOneMock.mockResolvedValue({ answers: "nope" })
    await expect(
      new TypesafeBackend(KEY).decide({ state: "s", questions: [question], model: "m", signal }),
    ).rejects.toThrow(/answers was not an object/)

    systemOneMock.mockResolvedValue({ answers: { b: { type: "noul" } } })
    await expect(
      new TypesafeBackend(KEY).decide({ state: "s", questions: [question], model: "m", signal }),
    ).rejects.toThrow(/missing probability/)
  })
})

describe("estimateTypesafeUsage", () => {
  it("handles junk and negative values", () => {
    expect(estimateTypesafeUsage("junk")).toEqual({ inputTokens: null, outputTokens: null, costUsd: null, costSource: null })
    expect(estimateTypesafeUsage({ input_tokens: -3, output_tokens: 2 })).toEqual({
      inputTokens: 0,
      outputTokens: 2,
      costUsd: 0,
      costSource: "estimated",
    })
  })
})
