import type { SourceParser, SourceRecord } from "../../ports/source-reader"
import { recordKey } from "../../application/projection"

/**
 * Hand-rolled RFC 4180-style CSV parser (also used for TSV with "\t").
 *
 * Supports: quoted fields, escaped quotes (`""`), embedded commas, newlines
 * and CRLF; a leading UTF-8 BOM; header row naming fields (last duplicate
 * header wins). Ragged rows tolerate silently: missing trailing cells are
 * simply absent, extra cells are ignored.
 */
export class CsvParser implements SourceParser {
  readonly format = "csv" as const

  constructor(private readonly delimiter: string = ",") {
    if (delimiter.length !== 1) {
      throw new Error("CSV delimiter must be a single character")
    }
  }

  parse(content: string): SourceRecord[] {
    const text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content
    const rows = parseRows(text, this.delimiter)
    if (rows.length === 0) return []

    const headers = rows[0]!.map((h) => h.trim())
    const records: SourceRecord[] = []
    for (let i = 1; i < rows.length; i += 1) {
      const cells = rows[i]!
      if (cells.length === 1 && cells[0] === "") continue // blank line
      const fields: Record<string, unknown> = {}
      for (let c = 0; c < headers.length && c < cells.length; c += 1) {
        fields[headers[c]!] = cells[c]
      }
      records.push({ index: records.length, key: recordKey(fields), fields })
    }
    return records
  }
}

function parseRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let inQuotes = false
  let i = 0

  const pushField = () => {
    row.push(field)
    field = ""
  }
  const pushRow = () => {
    pushField()
    rows.push(row)
    row = []
  }

  while (i < text.length) {
    const char = text[i]!
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i += 1
        continue
      }
      field += char
      i += 1
      continue
    }
    if (char === '"' && field.length === 0) {
      inQuotes = true
      i += 1
      continue
    }
    if (char === delimiter) {
      pushField()
      i += 1
      continue
    }
    if (char === "\r") {
      if (text[i + 1] === "\n") i += 1
      pushRow()
      i += 1
      continue
    }
    if (char === "\n") {
      pushRow()
      i += 1
      continue
    }
    field += char
    i += 1
  }

  // Final field/row: only when the file does not end with a newline, or when
  // a trailing quoted section left content pending.
  if (field.length > 0 || row.length > 0) {
    pushRow()
  }
  return rows
}
