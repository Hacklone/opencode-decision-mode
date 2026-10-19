/**
 * Seam for writing tool output files into the workspace. Application code
 * never touches the filesystem; it serializes and hands content here.
 */
export interface FileSink {
  /** Resolve a workspace-relative or absolute path and write UTF-8 content. */
  write(path: string, content: string): Promise<void>
}
