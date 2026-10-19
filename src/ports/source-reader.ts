/**
 * A flattened source record: either a CSV row (keyed by header) or a JSONL
 * object. Keys keep insertion order for deterministic projection.
 */
export interface SourceRecord {
  index: number
  /** Record identity when the source provides one (e.g. an `id` column); else null. */
  key: string | null
  fields: Record<string, unknown>
}

export type SourceFormat = "csv" | "jsonl"

/** Parses source bytes into records. Implementations must be pure/sync-friendly. */
export interface SourceParser {
  format: SourceFormat
  parse(content: string): SourceRecord[]
}

/** Reads and parses a source file into records. */
export interface SourceReader {
  read(path: string, format: SourceFormat): Promise<SourceRecord[]>
}

/** Hard cap on source file size (mirrors the 32 MiB provider body limits). */
export const MAX_SOURCE_BYTES = 32 * 1024 * 1024
