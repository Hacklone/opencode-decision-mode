import { describe, expect, it } from "vitest"
import { desugarQuestions, resugarAnswers } from "../../src/domain/noul-confidence"
import { parseQuestion } from "../../src/domain/decision-types"

describe("desugarQuestions", () => {
  it("turns a confidence-bearing noul into a two-level score (false, true)", () => {
    const [desugared] = desugarQuestions([
      parseQuestion({
        id: "g",
        type: "noul",
        instructions: "TRUE if the gate fails",
        criteria: { true: "the gate fails", false: "the gate holds" },
        withConfidence: true,
      }),
    ])
    expect(desugared).toEqual({
      id: "g",
      type: "score",
      instructions: "TRUE if the gate fails",
      criteria: ["the gate holds", "the gate fails"],
    })
  })

  it("falls back to default level text when noul criteria are missing", () => {
    const [desugared] = desugarQuestions([
      parseQuestion({ id: "g", type: "noul", instructions: "TRUE if spam", withConfidence: true }),
    ])
    expect(desugared).toEqual({
      id: "g",
      type: "score",
      instructions: "TRUE if spam",
      criteria: ["false — the predicate does not hold", "true — the predicate holds"],
    })
  })

  it("stringifies object criteria descriptions (score levels are plain strings on the wire)", () => {
    const [desugared] = desugarQuestions([
      parseQuestion({
        id: "g",
        type: "noul",
        instructions: "TRUE if spam",
        criteria: { true: { what: "spam", examples: ["buy now"] } },
        withConfidence: true,
      }),
    ])
    if (desugared === undefined || desugared.type !== "score") throw new Error("desugar failed")
    expect(desugared.criteria[1]).toBe(JSON.stringify({ what: "spam", examples: ["buy now"] }))
  })

  it("passes every other question through unchanged", () => {
    const questions = [
      parseQuestion({ id: "plain", type: "noul", instructions: "plain noul" }),
      parseQuestion({
        id: "off",
        type: "noul",
        instructions: "explicitly off",
        withConfidence: false,
      }),
      parseQuestion({ id: "c", type: "choice", instructions: "pick", criteria: { a: null } }),
      parseQuestion({ id: "s", type: "score", instructions: "rate", criteria: ["low", "high"] }),
    ]
    expect(desugarQuestions(questions)).toEqual(questions)
  })
})

describe("parseQuestion withConfidence", () => {
  it("rejects a non-boolean withConfidence", () => {
    expect(() =>
      parseQuestion({ id: "g", type: "noul", instructions: "x", withConfidence: "yes" }),
    ).toThrow(/withConfidence must be a boolean/)
  })
})

describe("resugarAnswers", () => {
  const withConfidence = parseQuestion({
    id: "g",
    type: "noul",
    instructions: "TRUE if the gate fails",
    withConfidence: true,
  })
  const plain = parseQuestion({ id: "p", type: "noul", instructions: "plain" })

  it("maps a two-level score answer back to a noul answer with real confidence", () => {
    const out = resugarAnswers([withConfidence], {
      g: { type: "score", score: 0.93, legend: null, confidence: 0.88 },
    })
    expect(out).toEqual({ g: { type: "noul", pTrue: 0.93, confidence: 0.88 } })
  })

  it("clamps the score position into [0, 1] and omits absent confidence", () => {
    const out = resugarAnswers([withConfidence], {
      g: { type: "score", score: 1.2, legend: null },
    })
    expect(out).toEqual({ g: { type: "noul", pTrue: 1 } })
  })

  it("passes answers for non-desugared questions through untouched", () => {
    const score = { type: "score", score: 0.5, legend: "mid" } as const
    const noul = { type: "noul", pTrue: 0.4 } as const
    const out = resugarAnswers([plain], { p: noul, other: score })
    expect(out).toEqual({ p: noul, other: score })
  })

  it("rejects a non-score answer for a confidence-bearing question", () => {
    expect(() =>
      resugarAnswers([withConfidence], { g: { type: "noul", pTrue: 0.5 } }),
    ).toThrow(/expected a score answer for a confidence-bearing noul question/)
  })
})
