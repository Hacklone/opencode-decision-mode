/**
 * Entry shim for local installs: OpenCode's `.opencode/plugins/<dir>`
 * discovery loads `<dir>/index.ts` directly (the package.json `exports` map
 * is only honored for npm-installed plugins). Re-exporting keeps both paths
 * working from the same checkout.
 */
export { default, ON_INSTRUCTION } from "./src/index.ts"
