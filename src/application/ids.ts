import { randomBytes } from "node:crypto"

/** Short, sortable run id: `run_<base36 time>_<random>`. */
export function newRunId(now: () => number = Date.now): string {
  const time = now().toString(36)
  const rand = randomBytes(4).toString("hex")
  return `run_${time}_${rand}`
}
