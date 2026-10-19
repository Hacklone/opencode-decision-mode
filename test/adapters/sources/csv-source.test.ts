import { describe, expect, it } from "vitest"
import { CsvParser } from "../../../src/adapters/sources/csv-source"

describe("CsvParser", () => {
  it("parses simple rows with a header", () => {
    const records = new CsvParser().parse("id,text\n1,hello\n2,world\n")
    expect(records).toHaveLength(2)
    expect(records[0]).toEqual({ index: 0, key: "1", fields: { id: "1", text: "hello" } })
    expect(records[1]!.fields).toEqual({ id: "2", text: "world" })
  })

  it("handles quoted fields, escaped quotes, embedded commas and newlines", () => {
    const csv = 'id,note\n1,"has, comma"\n2,"has""quote"" and\nnewline"\n'
    const records = new CsvParser().parse(csv)
    expect(records[0]!.fields["note"]).toBe("has, comma")
    expect(records[1]!.fields["note"]).toBe('has"quote" and\nnewline')
  })

  it("strips a UTF-8 BOM and handles CRLF", () => {
    const records = new CsvParser().parse("\uFEFFid,name\r\n1,ada\r\n")
    expect(records[0]!.fields).toEqual({ id: "1", name: "ada" })
  })

  it("tolerates ragged rows and skips blank lines", () => {
    const csv = "a,b\n1\n\n1,2,extra\n"
    const records = new CsvParser().parse(csv)
    expect(records).toHaveLength(2)
    expect(records[0]!.fields).toEqual({ a: "1" })
    expect(records[1]!.fields).toEqual({ a: "1", b: "2" })
  })

  it("supports tab delimiters for TSV", () => {
    const records = new CsvParser("\t").parse("id\tname\n1\tgrace\n")
    expect(records[0]!.fields).toEqual({ id: "1", name: "grace" })
  })

  it("returns empty for empty content and keeps duplicate-header last wins", () => {
    expect(new CsvParser().parse("")).toEqual([])
    const records = new CsvParser().parse("id,id\n1,2\n")
    expect(records[0]!.fields).toEqual({ id: "2" })
  })

  it("rejects multi-character delimiters", () => {
    expect(() => new CsvParser("--")).toThrow(/single character/)
  })

  it("handles a file not ending in a newline", () => {
    const records = new CsvParser().parse("id,x\n9,z")
    expect(records[0]!.fields).toEqual({ id: "9", x: "z" })
  })
})
