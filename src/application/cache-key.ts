import { createHash } from "node:crypto"
import { DecisionInputError } from "../domain/decision-types"
import type { CacheFingerprint } from "../ports/cache"

/**
 * Canonical JSON: object keys sorted, arrays in order, no whitespace.
 * Two structurally equal fingerprints always serialize identically, so the
 * content hash is stable across processes and tool invocations.
 */
export function canonicalize(value: unknown): string {
  return canonical(value, 0)
}

const MAX_DEPTH = 64

function canonical(value: unknown, depth: number): string {
  if (depth > MAX_DEPTH) {
    throw new DecisionInputError("state or questions exceed the maximum nesting depth of 64")
  }
  switch (typeof value) {
    case "string":
      return JSON.stringify(value)
    case "number":
      if (!Number.isFinite(value)) {
        throw new DecisionInputError("state must contain only finite numbers")
      }
      return JSON.stringify(value)
    case "boolean":
      return value ? "true" : "false"
    case "object": {
      if (value === null) return "null"
      if (Array.isArray(value)) {
        return `[${value.map((item) => canonical(item, depth + 1)).join(",")}]`
      }
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        // Keys are unique within an object, so a two-way comparator is total.
        .sort(([a], [b]) => (a < b ? -1 : 1))
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v, depth + 1)}`).join(",")}}`
    }
    default:
      throw new DecisionInputError(
        `state must be JSON-serializable (got ${typeof value})`,
      )
  }
}

export function cacheKeyFor(fingerprint: CacheFingerprint): string {
  const canonical = canonicalize(fingerprint)
  return `v${fingerprint.schemaVersion}:${sha256(canonical)}`
}

export function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex")
}
