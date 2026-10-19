import type { RecordResult, RunSummary } from "../../domain/decision-types"
import type { RunMeta, RunStore, StoredRunPage } from "../../ports/run-store"
import type { KeyValueStore } from "../../ports/storage"

const META_SUFFIX = "/meta"
const PAGE_PREFIX = "/p/"
const RUNS_PREFIX = "runs/"

function pad(page: number): string {
  return page.toString().padStart(6, "0")
}

/**
 * Run store over plugin storage.
 *
 * Layout:
 *   runs/<id>/meta      → RunSummary   (written last; presence = run complete)
 *   runs/<id>/p/000000  → RecordResult page (RUN_PAGE_SIZE records)
 *
 * Chunking keeps any single storage entry small no matter how large the run.
 */
export class StorageRunStore implements RunStore {
  constructor(
    private readonly storage: KeyValueStore,
    private readonly pageSize: number = 100,
  ) {}

  async saveRun(meta: RunMeta, pages: StoredRunPage[]): Promise<void> {
    for (const page of pages) {
      await this.storage.set(`${RUNS_PREFIX}${meta.id}${PAGE_PREFIX}${pad(page.page)}`, {
        page: page.page,
        results: page.results,
      })
    }
    await this.storage.set(`${RUNS_PREFIX}${meta.id}${META_SUFFIX}`, meta.summary)
  }

  async getSummary(runId: string): Promise<RunSummary | null> {
    const value = await this.storage.get(`${RUNS_PREFIX}${runId}${META_SUFFIX}`)
    return isSummary(value) ? value : null
  }

  async getResults(runId: string): Promise<RecordResult[] | null> {
    const summary = await this.getSummary(runId)
    if (summary === null) return null
    const entries = await this.storage.scan(`${RUNS_PREFIX}${runId}${PAGE_PREFIX}`)
    // Storage scan order is unspecified; reassemble pages by their number.
    const pages = entries
      .map(({ value }) => (isPage(value) ? value : null))
      .filter((page): page is { page: number; results: RecordResult[] } => page !== null)
      .sort((a, b) => a.page - b.page)
    const results: RecordResult[] = []
    for (const page of pages) results.push(...page.results)
    return results
  }

  async listSummaries(limit = 20): Promise<RunSummary[]> {
    const entries = await this.storage.scan(RUNS_PREFIX)
    const summaries: RunSummary[] = []
    for (const { key, value } of entries) {
      if (!key.endsWith(META_SUFFIX)) continue
      if (isSummary(value)) summaries.push(value)
    }
    summaries.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
    return summaries.slice(0, Math.max(1, limit))
  }
}

function isSummary(value: unknown): value is RunSummary {
  if (typeof value !== "object" || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v["id"] === "string" && typeof v["total"] === "number" && typeof v["source"] === "object"
}

function isPage(value: unknown): value is { page: number; results: RecordResult[] } {
  if (typeof value !== "object" || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v["page"] === "number" && Array.isArray(v["results"])
}
