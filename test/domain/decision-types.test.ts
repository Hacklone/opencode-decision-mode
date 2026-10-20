import { describe, expect, it } from "vitest"
import {
  DEFAULT_POLICY,
  MAX_CHOICE_OPTIONS,
  MAX_SCORE_LEVELS,
  MIN_SCORE_LEVELS,
  isProviderId,
  isQuestionType,
  parsePolicy,
  parsePolicySpec,
  parseQuestion,
  parseQuestions,
  policyFor,
  legendFor,
} from "../../src/domain/decision-types"

describe("parseQuestion", () => {
  it("accepts a minimal noul question without criteria", () => {
    const q = parseQuestion({ id: "b", type: "noul", instructions: "is it true?" })
    expect(q).toEqual({ id: "b", type: "noul", instructions: "is it true?" })
  })

  it("keeps only defined noul criteria sides", () => {
    const q = parseQuestion({ id: "b", type: "noul", instructions: {}, criteria: { true: "yes means" } })
    expect(q).toMatchObject({ criteria: { true: "yes means" } })
    expect(Object.keys((q as { criteria: object }).criteria)).toEqual(["true"])
    const falseOnly = parseQuestion({ id: "b", type: "noul", instructions: {}, criteria: { false: "no means" } })
    expect(falseOnly).toMatchObject({ criteria: { false: "no means" } })
    expect(Object.keys((falseOnly as { criteria: object }).criteria)).toEqual(["false"])
  })

  it("rejects non-object noul criteria", () => {
    expect(() => parseQuestion({ id: "b", type: "noul", instructions: "x", criteria: "no" })).toThrow(
      /criteria must be an object/,
    )
  })

  it("accepts choice criteria with null descriptions and enforces the option cap", () => {
    const q = parseQuestion({ id: "c", type: "choice", instructions: "pick", criteria: { a: "A", b: null } })
    expect(q).toMatchObject({ criteria: { a: "A", b: null } })
    const tooMany = Object.fromEntries(Array.from({ length: MAX_CHOICE_OPTIONS + 1 }, (_, i) => [`o${i}`, null]))
    expect(() => parseQuestion({ id: "c", type: "choice", instructions: "pick", criteria: tooMany })).toThrow(
      /exceeds 255 options/,
    )
  })

  it("rejects empty choice criteria and non-string descriptions", () => {
    expect(() => parseQuestion({ id: "c", type: "choice", instructions: "pick", criteria: {} })).toThrow(
      /at least one option/,
    )
    expect(() => parseQuestion({ id: "c", type: "choice", instructions: "pick", criteria: { a: 1 } })).toThrow(
      /must be a string or null/,
    )
    expect(() => parseQuestion({ id: "c", type: "choice", instructions: "pick", criteria: [1] })).toThrow(
      /must be an object/,
    )
  })

  it("accepts score criteria between the level bounds", () => {
    const q = parseQuestion({ id: "s", type: "score", instructions: "rate", criteria: ["low", "mid", "high"] })
    expect(q).toMatchObject({ criteria: ["low", "mid", "high"] })
  })

  it("rejects score criteria outside 2–10 or non-strings", () => {
    for (const n of [MIN_SCORE_LEVELS - 1, MAX_SCORE_LEVELS + 1]) {
      const criteria = Array.from({ length: n }, (_, i) => `l${i}`)
      expect(() => parseQuestion({ id: "s", type: "score", instructions: "rate", criteria })).toThrow(
        /2–10 levels/,
      )
    }
    expect(() => parseQuestion({ id: "s", type: "score", instructions: "rate", criteria: ["", "x"] })).toThrow(
      /non-empty level/,
    )
    expect(() => parseQuestion({ id: "s", type: "score", instructions: "rate", criteria: "no" })).toThrow(
      /must be an array/,
    )
  })

  it("rejects bad id, type and instructions", () => {
    expect(() => parseQuestion(null)).toThrow(/must be an object/)
    expect(() => parseQuestion({ id: "", type: "noul", instructions: "x" })).toThrow(/non-empty string/)
    expect(() => parseQuestion({ id: "x", type: "boolean", instructions: "x" })).toThrow(/type must be one of/)
    expect(() => parseQuestion({ id: "x", type: "noul", instructions: 42 })).toThrow(/instructions/)
    expect(() => parseQuestion({ id: "x", type: "noul", instructions: null })).toThrow(/instructions/)
  })
})

describe("parseQuestions", () => {
  it("rejects non-arrays, empty arrays and duplicate ids", () => {
    expect(() => parseQuestions("nope")).toThrow(/must be an array/)
    expect(() => parseQuestions([])).toThrow(/at least one question/)
    const q = { id: "a", type: "noul", instructions: "x" }
    expect(() => parseQuestions([q, q])).toThrow(/duplicate question id/)
  })

  it("passes valid questions through", () => {
    expect(parseQuestions([{ id: "a", type: "noul", instructions: "x" }])).toHaveLength(1)
  })
})

describe("policy parsing", () => {
  it("rejects out-of-range or inverted thresholds", () => {
    expect(() => parsePolicy("x")).toThrow(/must be an object/)
    expect(() => parsePolicy({ reviewAt: -0.1, failAt: 1 })).toThrow(/number in \[0, 1\]/)
    expect(() => parsePolicy({ reviewAt: 0.5, failAt: 1.1 })).toThrow(/number in \[0, 1\]/)
    expect(() => parsePolicy({ reviewAt: 0.9, failAt: 0.5 })).toThrow(/failAt must be >= policy\.reviewAt/)
    expect(parsePolicy({ reviewAt: 0.5, failAt: 0.5 })).toEqual({ reviewAt: 0.5, failAt: 0.5 })
  })

  it("parses per-question specs", () => {
    expect(() => parsePolicySpec("junk")).toThrow(/policy must be an object/)
    const spec = parsePolicySpec({ default: { reviewAt: 0.4, failAt: 0.9 }, questions: { b: { reviewAt: 0.1, failAt: 0.2 } } })
    expect(policyFor(spec, "b")).toEqual({ reviewAt: 0.1, failAt: 0.2 })
    expect(policyFor(spec, "other")).toEqual({ reviewAt: 0.4, failAt: 0.9 })
    expect(policyFor(undefined, "b")).toEqual(DEFAULT_POLICY)
    expect(policyFor(parsePolicySpec({ questions: { b: { reviewAt: 0.1, failAt: 0.2 } } }), "other")).toEqual(
      DEFAULT_POLICY,
    )
    expect(() => parsePolicySpec({ questions: null })).toThrow(/must be an object/)
    expect(() => parsePolicySpec({ questions: { b: { reviewAt: 9, failAt: 9 } } })).toThrow(/number in/)
  })

  it("treats flat objects without questions/default as a plain policy", () => {
    const spec = parsePolicySpec({ reviewAt: 0.2, failAt: 0.3 })
    expect(policyFor(spec, "any")).toEqual({ reviewAt: 0.2, failAt: 0.3 })
  })
})

describe("type guards", () => {
  it("isProviderId and isQuestionType", () => {
    expect(isProviderId("openrouter")).toBe(true)
    expect(isProviderId("nope")).toBe(false)
    expect(isQuestionType("score")).toBe(true)
    expect(isQuestionType("noul")).toBe(true)
    expect(isQuestionType("predicate")).toBe(false)
  })
})

describe("legendFor", () => {
  const levels = { s: ["low", "mid", "high"] }

  it("rounds a fractional score to the nearest level label", () => {
    expect(legendFor(levels, "s", 1.2)).toBe("mid")
    expect(legendFor(levels, "s", 1.6)).toBe("high")
    expect(legendFor(levels, "s", 2)).toBe("high")
  })

  it("clamps out-of-range scores", () => {
    expect(legendFor(levels, "s", -1)).toBe("low")
    expect(legendFor(levels, "s", 7)).toBe("high")
  })

  it("returns null without a table, for an unknown id, or on a hole", () => {
    expect(legendFor(undefined, "s", 1)).toBeNull()
    expect(legendFor({}, "s", 1)).toBeNull()
    expect(legendFor({ s: [] }, "s", 1)).toBeNull()
    // A sparse level table (never produced by parsing, tolerated defensively).
    const sparse: string[] = new Array(3)
    sparse[0] = "low"
    sparse[2] = "high"
    expect(legendFor({ s: sparse }, "s", 1)).toBeNull()
  })
})
