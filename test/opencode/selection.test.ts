import { describe, expect, it } from "vitest"
import { DEFAULT_MODELS } from "../../src/domain/decision-types"
import { DEFAULT_SELECTION, SelectionStore, normalizeSelection } from "../../src/opencode/selection"
import { kv } from "../fakes"

describe("SelectionStore", () => {
  it("defaults to on/openrouter and the provider default model", async () => {
    const store = new SelectionStore(kv())
    const loaded = await store.load()
    expect(loaded).toEqual(DEFAULT_SELECTION)
    expect(store.model()).toBe(DEFAULT_MODELS.openrouter)
  })

  it("persists and reloads selections across instances", async () => {
    const storage = kv()
    const first = new SelectionStore(storage)
    await first.load()
    await first.set({ mode: "off", provider: "typesafe" })
    expect(first.get()).toEqual({ mode: "off", provider: "typesafe", model: null })

    const second = new SelectionStore(storage)
    await second.load()
    expect(second.get()).toEqual({ mode: "off", provider: "typesafe", model: null })
    expect(second.model()).toBe(DEFAULT_MODELS.typesafe)
  })

  it("honors a pinned model and partial patches", async () => {
    const store = new SelectionStore(kv())
    await store.load()
    await store.set({ model: "typesafe/jev-1.13" })
    expect(store.model()).toBe("typesafe/jev-1.13")
    await store.set({ provider: "openai" })
    // A pin made for one provider is invalid elsewhere: switching clears it.
    expect(store.get()).toEqual({ mode: "on", provider: "openai", model: null })
    expect(store.model()).toBe(DEFAULT_MODELS.openai)
    await store.set({ provider: "typesafe", model: "jev-preview" })
    expect(store.get()).toEqual({ mode: "on", provider: "typesafe", model: "jev-preview" })
    // Same-provider patches keep the pin.
    await store.set({ mode: "off" })
    expect(store.get()).toEqual({ mode: "off", provider: "typesafe", model: "jev-preview" })
  })
})

describe("normalizeSelection", () => {
  it("coerces junk to defaults", () => {
    expect(normalizeSelection(undefined)).toEqual(DEFAULT_SELECTION)
    expect(normalizeSelection("junk")).toEqual(DEFAULT_SELECTION)
    expect(normalizeSelection({ mode: "weird", provider: 42, model: 5 })).toEqual(DEFAULT_SELECTION)
    expect(normalizeSelection({ mode: "off", provider: "openai", model: "" })).toEqual({
      mode: "off",
      provider: "openai",
      model: null,
    })
  })
})
