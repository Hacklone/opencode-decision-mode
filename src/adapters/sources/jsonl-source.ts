import type { SourceParser, SourceRecord } from "../../ports/source-reader"
import { recordKey } from "../../application/projection"
import { errorMessage } from "../../application/errors"

/**
 * JSON Lines parser: one JSON object per line. Blank lines are skipped.
 * A malformed line or a non-object value fails the whole read — a corrupt
 * source is a run-level error, not a per-record one.
 */
export class JsonlParser implements SourceParser {
  readonly format = "jsonl" as const

  parse(content: string): SourceRecord[] {
    const text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content
    const records: SourceRecord[] = []
    const lines = text.split("\n")
    for (let lineNo = 0; lineNo < lines.length; lineNo += 1) {
      const line = lines[lineNo]!.trim()
      if (line.length === 0) continue
      let value: unknown
      try {
        value = JSON.parse(line)
      } catch (error) {
        throw new Error(`jsonl line ${lineNo + 1}: invalid JSON — ${errorMessage(error)}`)
      }
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`jsonl line ${lineNo + 1}: expected a JSON object`)
      }
      const fields = value as Record<string, unknown>
      records.push({ index: records.length, key: recordKey(fields), fields })
    }
    return records
  }
}
