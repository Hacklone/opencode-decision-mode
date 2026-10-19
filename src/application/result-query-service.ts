import type { Answer, RecordResult, RunSummary, Verdict } from "../domain/decision-types"
import type { RecordStatus } from "../domain/decision-types"
import type { RunStore } from "../ports/run-store"

export interface ResultQuery {
  run: string
  status?: RecordStatus
  verdict?: Verdict
  /** "compact" trims probabilities/legend/usage for token efficiency; "full" keeps everything. */
  detail?: "compact" | "full"
  offset?: number
  limit?: number
}

export interface ResultPage {
  summary: RunSummary
  /** Total records matching the filter, independent of pagination. */
  matched: number
  offset: number
  results: RecordResult[]
}

export const DEFAULT_PAGE_LIMIT = 20
export const MAX_PAGE_LIMIT = 200

/**
 * Read-side for runs: filter by status/verdict, paginate, and trim payloads
 * so a controller model inspects results without paying for full payloads
 * unless it asks.
 */
export class ResultQueryService {
  constructor(private readonly store: RunStore) {}

  async listRuns(limit = 20): Promise<RunSummary[]> {
    return this.store.listSummaries(limit)
  }

  async query(request: ResultQuery): Promise<ResultPage> {
    const summary = await this.store.getSummary(request.run)
    if (summary === null) {
      throw new Error(`unknown run ${JSON.stringify(request.run)}`)
    }
    const all = await this.store.getResults(request.run)
    if (all === null) {
      throw new Error(`run ${JSON.stringify(request.run)} is missing its results`)
    }

    const filtered = all.filter((record) => {
      if (request.status !== undefined && record.status !== request.status) return false
      if (request.verdict !== undefined && record.verdict !== request.verdict) return false
      return true
    })

    const offset = Math.max(0, request.offset ?? 0)
    const limit = clampLimit(request.limit)
    const page = filtered.slice(offset, offset + limit).map((record) =>
      request.detail === "full" ? record : compact(record),
    )

    return { summary, matched: filtered.length, offset, results: page }
  }
}

function clampLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) return DEFAULT_PAGE_LIMIT
  return Math.min(Math.floor(value), MAX_PAGE_LIMIT)
}

/** Compact view: keep the decision, drop the distribution details. */
function compact(record: RecordResult): RecordResult {
  const trimmed: RecordResult = {
    index: record.index,
    key: record.key,
    status: record.status,
  }
  if (record.error !== undefined) trimmed.error = record.error
  if (record.verdict !== undefined) trimmed.verdict = record.verdict
  if (record.verdicts !== undefined) trimmed.verdicts = record.verdicts
  if (record.cacheHit) trimmed.cacheHit = true
  if (record.answers !== undefined) {
    const answers: Record<string, Answer> = {}
    for (const [id, answer] of Object.entries(record.answers)) {
      switch (answer.type) {
        case "noul":
          answers[id] = { type: "noul", pTrue: answer.pTrue }
          break
        case "choice":
          answers[id] = { type: "choice", choice: answer.choice }
          break
        case "score":
          answers[id] = { type: "score", score: answer.score, legend: answer.legend }
          break
      }
    }
    trimmed.answers = answers
  }
  return trimmed
}
