import { describe, expect, it } from "vitest"
import { cacheKeyFor, canonicalize, sha256 } from "../../src/application/cache-key"
import { DecisionInputError } from "../../src/domain/decision-types"

describe("canonicalize", () => {
  it("is key-order independent for objects", () => {
    expect(canonicalize({ a: 1, b: [1, 2] })).toBe(canonicalize({ b: [1, 2], a: 1 }))
  })

  it("preserves array order", () => {
    expect(canonicalize([1, 2])).not.toBe(canonicalize([2, 1]))
  })

  it("encodes scalars and null", () => {
    expect(canonicalize("x")).toBe('"x"')
    expect(canonicalize(1.5)).toBe("1.5")
    expect(canonicalize(false)).toBe("false")
    expect(canonicalize(null)).toBe("null")
  })

  it("drops undefined object values but keeps explicit nulls", () => {
    expect(canonicalize({ a: undefined, b: null })).toBe('{"b":null}')
  })

  it("rejects non-finite numbers and non-JSON values", () => {
    expect(() => canonicalize({ a: Number.POSITIVE_INFINITY })).toThrow(DecisionInputError)
    expect(() => canonicalize({ a: () => 1 })).toThrow(DecisionInputError)
    expect(() => canonicalize({ a: 1n })).toThrow(DecisionInputError)
  })

  it("rejects nesting beyond depth 64", () => {
    let deep: unknown = 1
    for (let i = 0; i < 70; i += 1) deep = { v: deep }
    expect(() => canonicalize(deep)).toThrow(/nesting depth/)
  })
})

describe("cacheKeyFor", () => {
  it("is stable and sensitive to every fingerprint field", () => {
    const base = {
      provider: "openrouter" as const,
      model: "m",
      state: { a: 1 },
      questions: [{ id: "q", type: "noul", instructions: "x" }],
      providerOptions: null,
      schemaVersion: 1,
    }
    const key = cacheKeyFor(base)
    expect(cacheKeyFor(base)).toBe(key)
    for (const variant of [
      { ...base, provider: "openai" as const },
      { ...base, model: "other" },
      { ...base, state: { a: 2 } },
      { ...base, questions: [{ id: "q", type: "noul", instructions: "y" }] },
      { ...base, providerOptions: { trace: true } },
      { ...base, schemaVersion: 2 },
    ]) {
      expect(cacheKeyFor(variant)).not.toBe(key)
    }
  })

  it("embeds the schema version prefix and a sha256 digest", () => {
    const key = cacheKeyFor({
      provider: "openai",
      model: "m",
      state: "s",
      questions: [],
      providerOptions: null,
      schemaVersion: 7,
    })
    expect(key).toBe(`v7:${sha256(canonicalize({
      provider: "openai",
      model: "m",
      state: "s",
      questions: [],
      providerOptions: null,
      schemaVersion: 7,
    }))}`)
  })
})
