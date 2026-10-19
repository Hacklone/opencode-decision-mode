import { describe, expect, it } from "vitest"
import { applyVerdicts, verdictFor, worstVerdict } from "../../src/domain/verdict"

const policy = { reviewAt: 0.6, failAt: 0.85 }

describe("verdictFor", () => {
  it("is deterministic with inclusive boundaries (FAIL wins ties)", () => {
    expect(verdictFor(0.85, policy)).toBe("FAIL")
    expect(verdictFor(0.8499, policy)).toBe("REVIEW")
    expect(verdictFor(0.6, policy)).toBe("REVIEW")
    expect(verdictFor(0.5999, policy)).toBe("PASS")
  })
})

describe("worstVerdict", () => {
  it("ranks FAIL > REVIEW > PASS and returns undefined for empty input", () => {
    expect(worstVerdict([])).toBeUndefined()
    expect(worstVerdict(["PASS"])).toBe("PASS")
    expect(worstVerdict(["PASS", "FAIL", "REVIEW"])).toBe("FAIL")
    expect(worstVerdict(["REVIEW", "PASS"])).toBe("REVIEW")
  })
})

describe("applyVerdicts", () => {
  it("judges only noul answers and picks the worst as overall verdict", () => {
    const { verdicts, verdict } = applyVerdicts(
      {
        safe: { type: "noul", pTrue: 0.9 },
        spam: { type: "noul", pTrue: 0.1 },
        topic: { type: "choice", choice: "x", probabilities: {} },
      },
      () => policy,
    )
    expect(verdicts).toEqual({ safe: "FAIL", spam: "PASS" })
    expect(verdict).toBe("FAIL")
  })

  it("returns undefined overall verdict when no boolean questions exist", () => {
    const { verdicts, verdict } = applyVerdicts(
      { topic: { type: "choice", choice: "x", probabilities: {} } },
      () => policy,
    )
    expect(verdicts).toEqual({})
    expect(verdict).toBeUndefined()
  })

  it("honors per-question policies", () => {
    const { verdicts } = applyVerdicts({ a: { type: "noul", pTrue: 0.5 }, b: { type: "noul", pTrue: 0.5 } }, (id) =>
      id === "a" ? { reviewAt: 0.4, failAt: 0.9 } : { reviewAt: 0.6, failAt: 0.9 },
    )
    expect(verdicts).toEqual({ a: "REVIEW", b: "PASS" })
  })
})
