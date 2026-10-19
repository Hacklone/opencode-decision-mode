import { describe, expect, it, vi } from "vitest"
import { BackendError } from "../../../src/ports/decision-backend"
import {
  abortError,
  asNumber,
  asRecord,
  asString,
  clamp01,
  resolveScore,
  toBackendError,
  withSignal,
} from "../../../src/adapters/backends/normalize"
import { errorMessage } from "../../../src/application/errors"

describe("withSignal", () => {
  it("resolves with the promise value and removes the listener", async () => {
    const controller = new AbortController()
    const result = await withSignal(Promise.resolve("ok"), controller.signal)
    expect(result).toBe("ok")
  })

  it("rejects immediately when already aborted", async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(withSignal(Promise.resolve("x"), controller.signal)).rejects.toThrow(/aborted/)
  })

  it("rejects on abort mid-flight", async () => {
    const controller = new AbortController()
    const wrapped = withSignal(new Promise<string>(() => {}), controller.signal)
    controller.abort()
    await expect(wrapped).rejects.toThrow(/aborted/)
  })

  it("converts non-Error rejections to Error", async () => {
    await expect(withSignal(Promise.reject("boom-string"), new AbortController().signal)).rejects.toThrow(
      "boom-string",
    )
  })
})

describe("scalars", () => {
  it("clamp01 clamps to [0,1] and treats non-finite as 0", () => {
    expect(clamp01(1.5)).toBe(1)
    expect(clamp01(-2)).toBe(0)
    expect(clamp01(Number.NaN)).toBe(0)
    expect(clamp01(0.42)).toBe(0.42)
  })

  it("asNumber/asString/asRecord discriminate", () => {
    expect(asNumber(3.2)).toBe(3.2)
    expect(asNumber("3")).toBeNull()
    expect(asString("s")).toBe("s")
    expect(asString(1)).toBeNull()
    expect(asRecord({ a: 1 })).toEqual({ a: 1 })
    expect(asRecord([1])).toBeNull()
    expect(asRecord(null)).toBeNull()
  })
})

describe("resolveScore", () => {
  const criteria = ["low", "mid", "high"]

  it("accepts integer indexes and exact labels", () => {
    expect(resolveScore(2, criteria)).toEqual({ value: 2, index: 2 })
    expect(resolveScore("mid", criteria)).toEqual({ value: 1, index: 1 })
    expect(resolveScore(0, criteria)).toEqual({ value: 0, index: 0 })
  })

  it("accepts fractional positions, rounding to the nearest level", () => {
    expect(resolveScore(1.33, criteria)).toEqual({ value: 1.33, index: 1 })
    expect(resolveScore(1.6, criteria)).toEqual({ value: 1.6, index: 2 })
  })

  it("clamps numbers outside the level range", () => {
    expect(resolveScore(7, criteria)).toEqual({ value: 2, index: 2 })
    expect(resolveScore(-1, criteria)).toEqual({ value: 0, index: 0 })
  })

  it("rejects unknown labels, non-finite numbers and other types", () => {
    expect(() => resolveScore("unknown", criteria)).toThrow(/does not match any criteria level/)
    expect(() => resolveScore(Number.NaN, criteria)).toThrow(BackendError)
    expect(() => resolveScore(Number.POSITIVE_INFINITY, criteria)).toThrow(BackendError)
    expect(() => resolveScore(true, criteria)).toThrow(BackendError)
    expect(() => resolveScore(null, criteria)).toThrow(BackendError)
  })
})

describe("toBackendError", () => {
  it("preserves BackendError, maps status codes, flags retryables", () => {
    const original = new BackendError("keep me")
    expect(toBackendError(original, "p")).toBe(original)
    const mapped = toBackendError(Object.assign(new Error("ratelimited"), { status: 429 }), "openrouter")
    expect(mapped.message).toBe("openrouter: ratelimited")
    expect(mapped.status).toBe(429)
    expect(mapped.retryable).toBe(true)
    expect(toBackendError(Object.assign(new Error("bad"), { status: 400 }), "p").retryable).toBe(false)
    expect(toBackendError("raw string", "p").message).toBe("p: raw string")
  })
})

describe("abortError", () => {
  it("is named AbortError", () => {
    expect(abortError().name).toBe("AbortError")
  })
})

describe("errorMessage", () => {
  it("unwraps Error messages and stringifies other values", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom")
    expect(errorMessage("raw")).toBe("raw")
    expect(errorMessage(42)).toBe("42")
  })
})
