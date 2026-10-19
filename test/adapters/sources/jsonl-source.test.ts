import { describe, expect, it } from "vitest"
import { JsonlParser } from "../../../src/adapters/sources/jsonl-source"

describe("JsonlParser", () => {
  it("parses one object per line, skipping blank lines and BOMs", () => {
    const records = new JsonlParser().parse('\uFEFF{"id":"a","n":1}\n\n{"id":"b","n":2}\n')
    expect(records).toHaveLength(2)
    expect(records[0]!.fields).toEqual({ id: "a", n: 1 })
    expect(records[1]!.fields).toEqual({ id: "b", n: 2 })
  })

  it("fails the whole read on malformed JSON with the line number", () => {
    expect(() => new JsonlParser().parse('{"ok":1}\n{oops}\n')).toThrow(/jsonl line 2/)
  })

  it("fails on non-object lines", () => {
    expect(() => new JsonlParser().parse("[1,2]\n")).toThrow(/expected a JSON object/)
    expect(() => new JsonlParser().parse("42\n")).toThrow(/expected a JSON object/)
  })

  it("returns empty for empty content", () => {
    expect(new JsonlParser().parse("")).toEqual([])
  })
})
