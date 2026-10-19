import { mkdir, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, resolve } from "node:path"
import { errorMessage } from "../../application/errors"
import type { FileSink } from "../../ports/file-sink"

/**
 * Filesystem sink mirroring FsSourceReader's path convention: workspace-
 * relative paths resolve against the workspace root, absolute paths pass
 * through. Parent directories are created on demand.
 */
export class FsFileSink implements FileSink {
  constructor(private readonly workspaceRoot: string | null) {}

  async write(path: string, content: string): Promise<void> {
    if (path.trim().length === 0) throw new Error("output path must be a non-empty string")
    const absolute = isAbsolute(path) ? path : resolve(this.workspaceRoot ?? process.cwd(), path)
    await mkdir(dirname(absolute), { recursive: true }).catch((error: unknown) => {
      throw new Error(`cannot create directory for ${path}: ${errorMessage(error)}`)
    })
    await writeFile(absolute, content, "utf8").catch((error: unknown) => {
      throw new Error(`cannot write ${path}: ${errorMessage(error)}`)
    })
  }
}
