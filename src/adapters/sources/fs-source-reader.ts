import { readFile, stat } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
import type { SourceFormat, SourceReader, SourceRecord } from "../../ports/source-reader"
import { MAX_SOURCE_BYTES } from "../../ports/source-reader"
import { errorMessage } from "../../application/errors"
import { CsvParser } from "./csv-source"
import { JsonlParser } from "./jsonl-source"

/**
 * Filesystem source reader: resolves workspace-relative paths, enforces the
 * byte cap, and dispatches to the format parser.
 */
export class FsSourceReader implements SourceReader {
  private readonly csv = new CsvParser(",")
  private readonly tsv = new CsvParser("\t")
  private readonly jsonl = new JsonlParser()

  constructor(
    private readonly workspaceRoot: string | null,
    private readonly readFileFn: typeof readFile = readFile,
    private readonly statFn: typeof stat = stat,
  ) {}

  async read(path: string, format: SourceFormat): Promise<SourceRecord[]> {
    const absolute = isAbsolute(path) ? path : resolve(this.workspaceRoot ?? process.cwd(), path)
    const info = await this.statFn(absolute).catch((error: unknown) => {
      throw new Error(`cannot read source ${path}: ${errorMessage(error)}`)
    })
    if (!info.isFile()) {
      throw new Error(`source ${path} is not a regular file`)
    }
    if (info.size > MAX_SOURCE_BYTES) {
      throw new Error(
        `source ${path} is ${(info.size / 1024 / 1024).toFixed(1)} MiB; the cap is ${MAX_SOURCE_BYTES / 1024 / 1024} MiB`,
      )
    }
    const content = await this.readFileFn(absolute, "utf8")
    return this.parserFor(format, absolute).parse(content)
  }

  /** Delimiter follows the file extension: .tsv is tab-separated even though its format is "csv". */
  private parserFor(format: SourceFormat, path: string) {
    switch (format) {
      case "csv":
        return path.toLowerCase().endsWith(".tsv") ? this.tsv : this.csv
      case "jsonl":
        return this.jsonl
    }
  }
}
