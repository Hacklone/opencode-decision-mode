import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { FsFileSink } from "../../../src/adapters/sinks/fs-file-sink"

describe("FsFileSink", () => {
  it("writes workspace-relative paths, creating parent directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "decision-sink-"))
    const sink = new FsFileSink(root)
    await sink.write("out/nested/results.csv", "a,b\n1,2\n")
    expect(await readFile(join(root, "out/nested/results.csv"), "utf8")).toBe("a,b\n1,2\n")
  })

  it("accepts absolute paths without a workspace root", async () => {
    const root = await mkdtemp(join(tmpdir(), "decision-sink-"))
    const file = join(root, "sub", "x.jsonl")
    await new FsFileSink(null).write(file, "{}\n")
    expect(await readFile(file, "utf8")).toBe("{}\n")
  })

  it("resolves relative paths against the process cwd when no workspace root exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "decision-sink-"))
    const previous = process.cwd()
    process.chdir(root)
    try {
      await new FsFileSink(null).write("rel/out.csv", "a,b\n")
      expect(await readFile(join(root, "rel/out.csv"), "utf8")).toBe("a,b\n")
    } finally {
      process.chdir(previous)
    }
  })

  it("rejects blank paths", async () => {
    await expect(new FsFileSink(tmpdir()).write("   ", "x")).rejects.toThrow(/non-empty string/)
  })

  it("reports directory-creation and write failures clearly", async () => {
    const root = await mkdtemp(join(tmpdir(), "decision-sink-"))
    await writeFile(join(root, "afile"), "x")
    const sink = new FsFileSink(root)
    // Parent exists as a regular file: mkdir fails.
    await expect(sink.write("afile/deeper/out.csv", "y")).rejects.toThrow(/cannot create directory/)
    // Destination is a directory: writeFile fails.
    await mkdir(join(root, "adir"))
    await expect(sink.write("adir", "y")).rejects.toThrow(/cannot write/)
  })
})
