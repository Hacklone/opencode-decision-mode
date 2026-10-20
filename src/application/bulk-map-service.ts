import {
  type Answer,
  type ProviderId,
  type Question,
  type RecordResult,
  type RunSummary,
  type Usage,
} from "../domain/decision-types"
import type { PolicySpec } from "../domain/decision-types"
import { aggregateUsage } from "../domain/usage"
import { applyVerdicts } from "../domain/verdict"
import { policyFor } from "../domain/decision-types"
import { BackendError, type BackendRegistry } from "../ports/decision-backend"
import { errorMessage } from "./errors"
import { CACHE_SCHEMA_VERSION, type DecisionCache } from "../ports/cache"
import { RUN_PAGE_SIZE, type RunStore, type StoredRunPage } from "../ports/run-store"
import type { SourceReader, SourceRecord } from "../ports/source-reader"
import { newRunId } from "./ids"
import { composeContext, projectRecord, projectState } from "./projection"
import { cacheKeyFor, inputHashFor } from "./cache-key"

export interface MapRequest {
  /** Path to the source file (.csv/.tsv/.jsonl/.ndjson); resolved by the caller. */
  path: string
  format: "csv" | "jsonl"
  /** State template projected per record. Undefined when `project` selects the fields instead. */
  state: unknown
  /** Raw-typed field projection: state becomes {name: value} for the named fields. */
  project?: string[]
  /** Constant framing preamble, composed into every record's state (see composeContext). */
  context?: string
  questions: Question[]
  policy?: PolicySpec
  provider: ProviderId
  model: string
  concurrency: number
  offset?: number
  limit?: number
  /** "bypass" skips the cache read — re-sample identical inputs for variance studies. Writes still refresh the cache. */
  cache?: "bypass"
  /** Preview rows in the outcome (0 = none). Defaults to PREVIEW_SIZE. */
  preview?: number
  /** Called every PROGRESS_INTERVAL completions and once at the end. */
  onProgress?: (done: number, total: number) => void
  signal: AbortSignal
}

export interface MapOutcome {
  summary: RunSummary
  /** First records of the run for immediate inspection (token-efficient preview). */
  preview: RecordResult[]
  /** Set when the run bailed out early on a systematic failure. */
  aborted: { error: string; skipped: number } | null
}

export const MAX_RECORDS = 10_000
export const DEFAULT_CONCURRENCY = 4
export const MAX_CONCURRENCY = 32
export const PREVIEW_SIZE = 10
export const MAX_PREVIEW_SIZE = 50
export const MAX_SAMPLE = 20
/** Identical-signature errors that trigger a bail-out before spending the full input. */
export const SYSTEMATIC_ABORT_AFTER = 6
/** Completions between progress callbacks. */
export const PROGRESS_INTERVAL = 50

/**
 * Bulk map: read a source, project per-record state, decide every record with
 * bounded concurrency, isolate per-record failures, persist the run, and
 * return a summary plus a small preview.
 *
 * One record with all of its questions is one provider request — records are
 * never packed together.
 */
export class BulkMapService {
  constructor(
    private readonly backends: BackendRegistry,
    private readonly cache: DecisionCache,
    private readonly store: RunStore,
    private readonly reader: SourceReader,
    private readonly now: () => number = Date.now,
  ) {}

  async map(request: MapRequest): Promise<MapOutcome> {
    const concurrency = clampConcurrency(request.concurrency)
    const startedAt = this.now()

    const allRecords = await this.reader.read(request.path, request.format)
    if (allRecords.length > MAX_RECORDS) {
      throw new BackendError(
        `source has ${allRecords.length} records; the per-run cap is ${MAX_RECORDS} — slice with offset/limit`,
      )
    }
    const offset = Math.max(0, request.offset ?? 0)
    const records = allRecords.slice(
      offset,
      request.limit === undefined ? undefined : offset + request.limit,
    )

    const backend = this.backends[request.provider]
    if (backend === null || backend === undefined) {
      throw new BackendError(`no backend configured for provider ${request.provider}`)
    }

    const results: RecordResult[] = new Array(records.length)
    const resolvedModels = new Map<number, string>()
    let cursor = 0
    let cachedCount = 0
    let done = 0

    // Systematic-failure bail: identical error signatures (digits masked so
    // per-record values don't split a signature) abort the run early instead
    // of burning the whole input on a broken assumption.
    const errorSignatures = new Map<string, number>()
    let systematicError: string | null = null
    let skipped = 0

    const worker = async (): Promise<void> => {
      for (;;) {
        const slot = cursor
        cursor += 1
        if (slot >= records.length) return
        if (request.signal.aborted) throw abortError()
        const record = records[slot]!
        if (systematicError !== null) {
          results[slot] = {
            index: record.index,
            key: record.key,
            status: "error",
            error: `skipped after systematic failure: ${systematicError}`,
            record: record.fields,
          }
          skipped += 1
        } else {
          const decided = await this.decideRecord(record, request, backend)
          if (decided.resolvedModel !== undefined) {
            resolvedModels.set(record.index, decided.resolvedModel)
          }
          if (decided.result.cacheHit) cachedCount += 1
          results[slot] = decided.result
          if (decided.result.status === "error") {
            // Invariant: decideRecord's only error path always attaches a message.
            const signature = decided.result.error!.replace(/\d+(?:\.\d+)?/g, "#")
            const count = (errorSignatures.get(signature) ?? 0) + 1
            errorSignatures.set(signature, count)
            if (count >= SYSTEMATIC_ABORT_AFTER) systematicError = decided.result.error!
          }
        }
        done += 1
        if (
          request.onProgress !== undefined &&
          (done % PROGRESS_INTERVAL === 0 || done === records.length)
        ) {
          request.onProgress(done, records.length)
        }
      }
    }

    const workers: Promise<void>[] = []
    for (let i = 0; i < Math.min(concurrency, records.length); i += 1) {
      workers.push(worker())
    }
    await Promise.all(workers)

    const okResults = results.filter((r) => r.status === "ok")
    const verdictTally = { pass: 0, review: 0, fail: 0 }
    for (const result of okResults) {
      if (result.verdict === "PASS") verdictTally.pass += 1
      else if (result.verdict === "REVIEW") verdictTally.review += 1
      else if (result.verdict === "FAIL") verdictTally.fail += 1
    }

    const distinctResolved = new Set(resolvedModels.size > 0 ? [...resolvedModels.values()] : [request.model])
    const resolvedModel = distinctResolved.size === 1 ? [...distinctResolved][0]! : request.model

    // Level labels live once per run, not once per row — see RunSummary.levels.
    const levels: Record<string, string[]> = {}
    for (const question of request.questions) {
      if (question.type === "score") levels[question.id] = question.criteria
    }

    const summary: RunSummary = {
      id: newRunId(this.now),
      provider: request.provider,
      requestedModel: request.model,
      resolvedModel,
      total: records.length,
      ok: okResults.length,
      error: records.length - okResults.length,
      cached: cachedCount,
      verdicts: verdictTally,
      usage: aggregateUsage(okResults.map((r) => r.usage!)),
      durationMs: Math.max(0, this.now() - startedAt),
      createdAt: new Date(this.now()).toISOString(),
      source: { path: request.path, format: request.format, totalRecords: allRecords.length },
      inputHash: inputHashFor({
        state: request.state,
        project: request.project,
        context: request.context,
        questions: request.questions,
      }),
      ...(Object.keys(levels).length > 0 ? { levels } : {}),
    }

    await this.store.saveRun({ id: summary.id, summary }, chunkResults(results))

    return {
      summary,
      preview: results.slice(0, previewSize(request.preview)),
      aborted: systematicError === null ? null : { error: systematicError, skipped },
    }
  }

  /**
   * Cheap peek: the first records of a source with no provider calls and no
   * run — lets a controller inspect data shape before phrasing judgments.
   */
  async sample(request: { path: string; format: "csv" | "jsonl"; limit: number }): Promise<SourceRecord[]> {
    const records = await this.reader.read(request.path, request.format)
    return records.slice(0, Math.max(1, Math.min(Math.floor(request.limit), MAX_SAMPLE)))
  }

  private async decideRecord(
    record: SourceRecord,
    request: MapRequest,
    backend: NonNullable<BackendRegistry[ProviderId]>,
  ): Promise<{ result: RecordResult; resolvedModel: string | undefined }> {
    try {
      const projected =
        request.project !== undefined
          ? projectRecord(request.project, record)
          : projectState(request.state, record)
      const state =
        request.context === undefined ? projected : composeContext(request.context, projected)
      const key = cacheKeyFor({
        provider: request.provider,
        model: request.model,
        state,
        questions: request.questions,
        schemaVersion: CACHE_SCHEMA_VERSION,
      })

      const cached = request.cache === "bypass" ? null : await this.cache.get(key)
      if (cached !== null) {
        return {
          result: this.okResult(record, cached.answers, cached.usage, true, request),
          resolvedModel: cached.resolvedModel,
        }
      }

      const response = await backend.decide({
        state: state as string | object | unknown[],
        questions: request.questions,
        model: request.model,
        signal: request.signal,
      })
      await this.cache.set(key, {
        answers: response.answers,
        usage: response.usage,
        resolvedModel: response.resolvedModel,
      })
      return {
        result: this.okResult(record, response.answers, response.usage, false, request),
        resolvedModel: response.resolvedModel,
      }
    } catch (error) {
      if (request.signal.aborted) throw abortError()
      const message = errorMessage(error)
      return {
        result: {
          index: record.index,
          key: record.key,
          status: "error",
          error: message,
          record: record.fields,
        },
        resolvedModel: undefined,
      }
    }
  }

  private okResult(
    record: SourceRecord,
    answers: Record<string, Answer>,
    usage: Usage,
    cacheHit: boolean,
    request: MapRequest,
  ): RecordResult {
    const { verdicts, verdict } = applyVerdicts(answers, (id) => policyFor(request.policy, id))
    return {
      index: record.index,
      key: record.key,
      status: "ok",
      record: record.fields,
      answers: stripLegends(answers),
      verdict,
      verdicts,
      usage,
      cacheHit,
    }
  }
}

/**
 * Stored rows drop the score legend: the level label is derivable from the
 * run summary's `levels` table plus the score position, and repeating it per
 * row multiplied artifact size several-fold (6.6 MB run file for 2,683
 * records). Readers reconstruct via `legendFor`.
 */
function stripLegends(answers: Record<string, Answer>): Record<string, Answer> {
  const stripped: Record<string, Answer> = {}
  let changed = false
  for (const [id, answer] of Object.entries(answers)) {
    if (answer.type === "score" && answer.legend !== null) {
      stripped[id] = { ...answer, legend: null }
      changed = true
    } else {
      stripped[id] = answer
    }
  }
  return changed ? stripped : answers
}

function previewSize(value: number | undefined): number {
  if (value === undefined) return PREVIEW_SIZE
  if (!Number.isFinite(value) || value < 0) return 0
  return Math.min(Math.floor(value), MAX_PREVIEW_SIZE)
}

function clampConcurrency(value: number): number {
  if (!Number.isFinite(value) || value < 1) return DEFAULT_CONCURRENCY
  return Math.min(Math.floor(value), MAX_CONCURRENCY)
}

export function chunkResults(results: readonly RecordResult[]): StoredRunPage[] {
  const pages: StoredRunPage[] = []
  for (let i = 0; i < results.length; i += RUN_PAGE_SIZE) {
    pages.push({ runId: "", page: pages.length, results: results.slice(i, i + RUN_PAGE_SIZE) })
  }
  return pages
}

function abortError(): Error {
  const error = new Error("decision_map aborted")
  error.name = "AbortError"
  return error
}

