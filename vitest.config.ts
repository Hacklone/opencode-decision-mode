import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // The TUI entry is JSX rendered by OpenCode's OpenTUI runtime; it is
      // exercised manually against a live TUI, not under vitest.
      // src/ports/storage.ts and src/ports/file-sink.ts are type-only contracts (no runtime statements).
      exclude: ["src/tui.tsx", "src/ports/storage.ts", "src/ports/file-sink.ts"],
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
    },
  },
})
