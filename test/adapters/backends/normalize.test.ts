import { describe, expect, it, vi } from "vitest"
import { BackendError } from "../../../src/ports/decision-backend"
import {
  abortError,
  asNumber,
  asRecord,
  asString,
  clamp01,
  scoreIndex,
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

describe("scoreIndex", () => {
  it("accepts a valid integer index or an exact label", () => {
    const criteria = ["low", "mid", "high"]
    expect(scoreIndex(2, criteria)).toBe(2)
    expect(scoreIndex("mid", criteria)).toBe(1)
    expect(() => scoreIndex(3, criteria)).toThrow(BackendError)
    expect(() => scoreIndex(-1, criteria)).toThrow(BackendError)
    expect(() => scoreIndex("unknown", criteria)).toThrow(/does not match any criteria level/)
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
