import { describe, expect, it } from "vitest"
import { ENV_VARS } from "../../src/ports/credential-source"
import { OpencodeCredentials, credentialStatus, extractKey } from "../../src/opencode/credentials"

function ctxWith(connection: { active: (id: string) => Promise<unknown>; resolve: (c: unknown) => Promise<unknown> }) {
  return { integration: { connection } }
}

describe("OpencodeCredentials", () => {
  it("prefers environment variables and maps the right names", async () => {
    const env = { OPENROUTER_API_KEY: "or", TYPESAFE_API_KEY: "ts", OPENAI_API_KEY: "oa" }
    const credentials = new OpencodeCredentials(ctxWith({ active: async () => undefined, resolve: async () => null }), env)
    expect(await credentials.resolve("openrouter")).toBe("or")
    expect(await credentials.resolve("typesafe")).toBe("ts")
    expect(await credentials.resolve("openai")).toBe("oa")
    expect(await credentials.available("typesafe")).toBe(true)
    expect(ENV_VARS.typesafe).toBe("TYPESAFE_API_KEY")
  })

  it("falls back to integration connections when env is empty", async () => {
    const ctx = ctxWith({
      active: async (id) => (id === "openrouter" ? { id: 1 } : undefined),
      resolve: async () => ({ type: "api_key", key: "integration-key" }),
    })
    const credentials = new OpencodeCredentials(ctx, {})
    expect(await credentials.resolve("openrouter")).toBe("integration-key")
    expect(await credentials.resolve("openai")).toBeNull()
  })

  it("swallows integration failures and bad credential shapes", async () => {
    const ctx = ctxWith({
      active: async () => {
        throw new Error("no such integration")
      },
      resolve: async () => undefined,
    })
    const credentials = new OpencodeCredentials(ctx, {})
    expect(await credentials.resolve("openrouter")).toBeNull()
  })

  it("returns null immediately without an integration context", async () => {
    const credentials = new OpencodeCredentials(null, {})
    expect(await credentials.resolve("openai")).toBeNull()
    expect(await credentials.available("openai")).toBe(false)
  })

  it("extracts keys from several credential shapes", () => {
    expect(extractKey("raw")).toBe("raw")
    expect(extractKey({ key: "k" })).toBe("k")
    expect(extractKey({ apiKey: "k" })).toBe("k")
    expect(extractKey({ api_key: "k" })).toBe("k")
    expect(extractKey({ value: "k" })).toBe("k")
    expect(extractKey({ secret: "k" })).toBe("k")
    expect(extractKey({ token: "k" })).toBe("k")
    expect(extractKey({ nope: 1 })).toBeNull()
    expect(extractKey(null)).toBeNull()
    expect(extractKey(42)).toBeNull()
    expect(extractKey("")).toBeNull()
  })

  it("reports a full availability snapshot", async () => {
    const ctx = ctxWith({ active: async () => undefined, resolve: async () => undefined })
    const status = await credentialStatus(new OpencodeCredentials(ctx, { OPENAI_API_KEY: "x" }))
    expect(status).toEqual({ openrouter: false, typesafe: false, openai: true })
  })
})
