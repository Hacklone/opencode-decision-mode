import { mkdtemp, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { FsSourceReader } from "../../../src/adapters/sources/fs-source-reader"
import { MAX_SOURCE_BYTES } from "../../../src/ports/source-reader"

describe("FsSourceReader", () => {
  it("resolves workspace-relative paths and dispatches by format", async () => {
    const root = await mkdtemp(join(tmpdir(), "decision-src-"))
    await writeFile(join(root, "data.csv"), "id,text\n1,hi\n")
    await writeFile(join(root, "data.jsonl"), '{"id":"2","text":"yo"}\n')
    const reader = new FsSourceReader(root)

    const csv = await reader.read("data.csv", "csv")
    expect(csv).toHaveLength(1)
    expect(csv[0]!.fields["text"]).toBe("hi")

    const jsonl = await reader.read("data.jsonl", "jsonl")
    expect(jsonl[0]!.fields["text"]).toBe("yo")
  })

  it("accepts absolute paths without a workspace root", async () => {
    const root = await mkdtemp(join(tmpdir(), "decision-src-"))
    const file = join(root, "x.csv")
    await writeFile(file, "a\n1\n")
    const reader = new FsSourceReader(null)
    expect(await reader.read(file, "csv")).toHaveLength(1)
  })

  it("resolves relative paths against the process cwd when no workspace root exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "decision-src-"))
    await writeFile(join(root, "rel.csv"), "a\n1\n")
    const previous = process.cwd()
    process.chdir(root)
    try {
      const reader = new FsSourceReader(null)
      expect(await reader.read("rel.csv", "csv")).toHaveLength(1)
    } finally {
      process.chdir(previous)
    }
  })

  it("reports missing files clearly", async () => {
    const reader = new FsSourceReader(tmpdir())
    await expect(reader.read("does-not-exist.csv", "csv")).rejects.toThrow(/cannot read source/)
  })

  it("rejects directories and oversized files", async () => {
    const root = await mkdtemp(join(tmpdir(), "decision-src-"))
    const reader = new FsSourceReader(root)
    await expect(reader.read(".", "csv")).rejects.toThrow(/not a regular file/)

    const big = join(root, "big.csv")
    await writeFile(big, "x".repeat(MAX_SOURCE_BYTES + 1))
    await expect(reader.read(big, "csv")).rejects.toThrow(/the cap is/)
  })
})
