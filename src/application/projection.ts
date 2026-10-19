import type { SourceRecord } from "../ports/source-reader"

/**
 * Sentinel: use the whole record as the state value.
 *
 *   state: "$record"                       → state is the record object
 *   state: {text: "Row {{name}}: {{age}}"} → strings interpolate {{path}}
 */
export const RECORD_SENTINEL = "$record"

const PLACEHOLDER = /\{\{([^{}]*)\}\}/g

export class ProjectionError extends Error {
  readonly name = "ProjectionError"
}

/**
 * Project a template into per-record state. String leaves interpolate
 * `{{path}}` placeholders against the record (dot paths, numeric array
 * indices); non-string leaves are JSON-encoded into the string. Unknown
 * placeholders are a hard per-record error so silent data loss is impossible.
 */
export function projectState(template: unknown, record: SourceRecord): unknown {
  if (template === RECORD_SENTINEL) {
    return { ...record.fields }
  }
  if (typeof template === "string") {
    return interpolate(template, record)
  }
  if (Array.isArray(template)) {
    return template.map((item) => projectState(item, record))
  }
  if (typeof template === "object" && template !== null) {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(template)) {
      if (value !== undefined) out[key] = projectState(value, record)
    }
    return out
  }
  return template
}

export function interpolate(template: string, record: SourceRecord): string {
  return template.replace(PLACEHOLDER, (_match, rawPath: string) => {
    const path = rawPath.trim()
    if (path.length === 0) {
      throw new ProjectionError(`empty placeholder in template ${JSON.stringify(template)}`)
    }
    const value = lookupPath(record.fields, path)
    if (value === undefined) {
      throw new ProjectionError(
        `record ${record.index}: placeholder {{${path}}} does not match any field`,
      )
    }
    return stringifyValue(value)
  })
}

export function lookupPath(fields: Record<string, unknown>, path: string): unknown {
  let current: unknown = fields
  for (const segment of path.split(".")) {
    if (typeof current !== "object" || current === null) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

function stringifyValue(value: unknown): string {
  if (typeof value === "string") return value
  // Value is defined here (undefined lookups throw earlier), so stringify always yields a string.
  return JSON.stringify(value) as string
}

/** Record identity: an `id` field when present (stringified), else null. */
export function recordKey(fields: Record<string, unknown>): string | null {
  const id = fields["id"] ?? fields["key"] ?? fields["_id"]
  if (typeof id === "string" && id.length > 0) return id
  if (typeof id === "number" && Number.isFinite(id)) return String(id)
  return null
}

/** Detect the source format from a file path extension. */
export function formatFromPath(path: string): "csv" | "jsonl" | null {
  const lower = path.toLowerCase()
  if (lower.endsWith(".csv") || lower.endsWith(".tsv")) return "csv"
  if (lower.endsWith(".jsonl") || lower.endsWith(".ndjson")) return "jsonl"
  return null
}
