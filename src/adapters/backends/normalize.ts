import { BackendError } from "../../ports/decision-backend"

/** Abort-aware wrapper: rejects promptly when the signal fires, with no unhandled rejections. */
export function withSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError())
      return
    }
    const onAbort = () => reject(abortError())
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

export function abortError(): Error {
  const error = new Error("decision request aborted")
  error.name = "AbortError"
  return error
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/** Read a numeric field defensively from an untyped provider response. */
export function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

export function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** Resolve a score answer (index or label) into a 0-based criteria index. */
export function scoreIndex(score: unknown, criteria: readonly string[]): number {
  if (typeof score === "number" && Number.isInteger(score) && score >= 0 && score < criteria.length) {
    return score
  }
  if (typeof score === "string") {
    const index = criteria.indexOf(score)
    if (index >= 0) return index
  }
  throw new BackendError(`score answer ${JSON.stringify(score)} does not match any criteria level`)
}

import { errorMessage } from "../../application/errors"

/** Provider SDKs and HTTP errors mapped to BackendError with retryability. */
export function toBackendError(error: unknown, provider: string): BackendError {
  if (error instanceof BackendError) return error
  const status = asNumber((error as { status?: unknown } | null)?.["status"] ?? null) ?? undefined
  const message = errorMessage(error)
  const retryable = status === 429 || status === 529 || status === 502 || status === 503
  return new BackendError(`${provider}: ${message}`, { status, retryable })
}
