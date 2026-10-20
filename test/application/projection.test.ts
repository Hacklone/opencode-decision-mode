import { describe, expect, it } from "vitest"
import {
  ProjectionError,
  formatFromPath,
  interpolate,
  lookupPath,
  projectRecord,
  projectState,
  recordKey,
} from "../../src/application/projection"
import type { SourceRecord } from "../../src/ports/source-reader"

function record(fields: Record<string, unknown>, index = 0): SourceRecord {
  return { index, key: recordKey(fields), fields }
}

describe("projectState", () => {
  it("$record yields the whole row", () => {
    const r = record({ a: 1 })
    expect(projectState("$record", r)).toEqual({ a: 1 })
  })

  it("interpolates strings, dot paths and JSON-encodes non-strings", () => {
    const r = record({ name: "ada", meta: { age: 30 }, tags: ["x", "y"], ok: true })
    expect(projectState("Hello {{name}}", r)).toBe("Hello ada")
    expect(projectState("Age {{meta.age}}", r)).toBe("Age 30")
    expect(projectState("Tags {{tags}}", r)).toBe('Tags ["x","y"]')
    expect(projectState("Ok {{ok}}", r)).toBe("Ok true")
    expect(projectState({ text: "{{name}}", n: 5, nested: { deep: "{{meta.age}}" } }, r)).toEqual({
      text: "ada",
      n: 5,
      nested: { deep: "30" },
    })
    expect(projectState(["{{name}}"], r)).toEqual(["ada"])
    expect(projectState(null, r)).toBeNull()
  })

  it("fails loudly on missing or empty placeholders", () => {
    expect(() => projectState("Hi {{missing}}", record({}))).toThrow(ProjectionError)
    expect(() => projectState("Hi {{}}", record({}))).toThrow(/empty placeholder/)
  })

  it("skips undefined template values", () => {
    expect(projectState({ a: undefined, b: 1 }, record({}))).toEqual({ b: 1 })
  })
})

describe("projectRecord", () => {
  it("selects named fields with raw types preserved", () => {
    const r = record({ text: "hi", n: 3, tags: ["a"], flag: false, score: 0.5 }, 4)
    expect(projectRecord(["text", "n", "tags", "flag", "score"], r)).toEqual({
      text: "hi",
      n: 3,
      tags: ["a"],
      flag: false,
      score: 0.5,
    })
  })

  it("fails loudly on a missing field, naming the record and the field", () => {
    expect(() => projectRecord(["text"], record({}, 7))).toThrow(ProjectionError)
    expect(() => projectRecord(["text"], record({}, 7))).toThrow(/record 7: projected field "text" does not exist/)
  })

  it("resolves dot paths but keys the output by the name as given", () => {
    const r = record({ meta: { age: 30 } })
    expect(projectRecord(["meta.age"], r)).toEqual({ "meta.age": 30 })
  })
})

describe("interpolate/lookupPath", () => {
  it("walks dot paths through objects and arrays", () => {
    const fields = { a: { b: [{ c: 7 }] } }
    expect(lookupPath(fields, "a.b[0].c")).toBeUndefined() // no bracket support: deterministic
    expect(lookupPath(fields, "a.b")).toEqual([{ c: 7 }])
    expect(interpolate("{{a.b}}", record(fields))).toBe('[{"c":7}]')
  })
})

describe("recordKey", () => {
  it("uses id/key/_id when present, else null", () => {
    expect(recordKey({ id: "r1" })).toBe("r1")
    expect(recordKey({ key: 42 })).toBe("42")
    expect(recordKey({ _id: "x" })).toBe("x")
    expect(recordKey({ name: "x" })).toBeNull()
    expect(recordKey({ id: "" })).toBeNull()
  })
})

describe("formatFromPath", () => {
  it("maps extensions to formats", () => {
    expect(formatFromPath("a.csv")).toBe("csv")
    expect(formatFromPath("a.TSV")).toBe("csv")
    expect(formatFromPath("a.jsonl")).toBe("jsonl")
    expect(formatFromPath("a.ndjson")).toBe("jsonl")
    expect(formatFromPath("a.txt")).toBeNull()
    expect(formatFromPath("a")).toBeNull()
  })
})
