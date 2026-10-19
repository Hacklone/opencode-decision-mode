import type { RecordResult, RunSummary } from "../domain/decision-types"

/** Discriminator on stored run pages. */
export interface StoredRunPage {
  runId: string
  page: number
  results: RecordResult[]
}

export interface RunMeta {
  id: string
  summary: RunSummary
}

/**
 * Durable store for decision runs. Results are chunked into pages so a large
 * `decision_map` never materializes one giant storage entry; the summary is
 * stored separately for cheap listing.
 */
export interface RunStore {
  saveRun(meta: RunMeta, pages: StoredRunPage[]): Promise<void>
  getSummary(runId: string): Promise<RunSummary | null>
  getResults(runId: string): Promise<RecordResult[] | null>
  listSummaries(limit?: number): Promise<RunSummary[]>
}

/** Suggested page size; storage adapters may pick their own. */
export const RUN_PAGE_SIZE = 100
