import { sha256 } from "./cache-key"
import type { Answer, PolicySpec, RecordResult, RecordStatus, Verdict } from "../domain/decision-types"
import { policyFor } from "../domain/decision-types"
import { rederiveVerdicts } from "../domain/verdict"
import type { RunStore } from "../ports/run-store"
import type { FileSink } from "../ports/file-sink"

export interface ExportRequest {
  run: string
  path: string
  format: "jsonl" | "csv"
  status?: RecordStatus
  verdict?: Verdict
  /** Re-derive verdicts from the stored answers under this policy before filtering/writing. */
  policy?: PolicySpec
}

export interface ExportMeta {
  run: string
  path: string
  format: "jsonl" | "csv"
  /** Rows written (after the filter). */
  records: number
  /** Records in the run. */
  total: number
  bytes: number
  /** SHA-256 of the written bytes — lets a controller verify its derived files against the run. */
  sha256: string
}

/**
 * Authoritative file export of a run's result set: the controller writes the
 * full per-record outcome to disk in one call and keeps only the metadata
 * (count + checksum) in context, instead of paging every row through the
 * conversation.
 */
export class ResultsExportService {
  constructor(
    private readonly store: RunStore,
    private readonly sink: FileSink,
  ) {}

  async export(request: ExportRequest): Promise<ExportMeta> {
    const summary = await this.store.getSummary(request.run)
    if (summary === null) {
      throw new Error(`unknown run ${JSON.stringify(request.run)}`)
    }
    const stored = await this.store.getResults(request.run)
    if (stored === null) {
      throw new Error(`run ${JSON.stringify(request.run)} is missing its results`)
    }
    const all =
      request.policy !== undefined
        ? rederiveVerdicts(stored, (id) => policyFor(request.policy, id))
        : stored

    const filtered = all.filter((record) => {
      if (request.status !== undefined && record.status !== request.status) return false
      if (request.verdict !== undefined && record.verdict !== request.verdict) return false
      return true
    })

    const content = request.format === "jsonl" ? toJsonl(filtered) : toCsv(filtered)
    await this.sink.write(request.path, content)

    return {
      run: summary.id,
      path: request.path,
      format: request.format,
      records: filtered.length,
      total: all.length,
      bytes: new TextEncoder().encode(content).length,
      sha256: sha256(content),
    }
  }
}

function toJsonl(records: readonly RecordResult[]): string {
  if (records.length === 0) return ""
  return records.map((record) => JSON.stringify(record)).join("\n") + "\n"
}

/** Flattened answer value for a CSV cell. */
function answerCell(answer: Answer): string | number {
  switch (answer.type) {
    case "noul":
      return answer.pTrue
    case "choice":
      return answer.choice
    case "score":
      return answer.legend ?? String(answer.score)
  }
}

const VERDICT_SUFFIX = "_verdict"

function toCsv(records: readonly RecordResult[]): string {
  const meta = ["_index", "_key", "_status", "_error"]
  const answerIds: string[] = []
  const verdictIds = new Set<string>()
  const sourceFields: string[] = []
  for (const record of records) {
    for (const id of Object.keys(record.answers ?? {})) {
      if (!answerIds.includes(id)) answerIds.push(id)
    }
    for (const id of Object.keys(record.verdicts ?? {})) verdictIds.add(id)
    for (const name of Object.keys(record.record ?? {})) {
      if (!sourceFields.includes(name)) sourceFields.push(name)
    }
  }

  // Columns: answer per question id, verdict column when any row carries one,
  // then source fields that do not shadow a reserved or question column.
  const dataColumns: string[] = []
  const seen = new Set(meta)
  for (const id of answerIds) {
    if (!seen.has(id)) dataColumns.push((seen.add(id), id))
    const verdictColumn = id + VERDICT_SUFFIX
    if (verdictIds.has(id) && !seen.has(verdictColumn)) dataColumns.push((seen.add(verdictColumn), verdictColumn))
  }
  for (const name of sourceFields) {
    if (!seen.has(name)) dataColumns.push(name)
  }

  const lines = [[...meta, ...dataColumns].map(csvCell).join(",")]
  for (const record of records) {
    const row: unknown[] = [record.index, record.key, record.status, record.error ?? null]
    for (const column of dataColumns) {
      if (column.endsWith(VERDICT_SUFFIX) && verdictIds.has(column.slice(0, -VERDICT_SUFFIX.length))) {
        row.push(record.verdicts?.[column.slice(0, -VERDICT_SUFFIX.length)] ?? null)
      } else if (record.answers && column in record.answers) {
        // Invariant: `column in record.answers` guarantees the key exists.
        row.push(answerCell(record.answers[column]!))
      } else {
        row.push(record.record?.[column] ?? null)
      }
    }
    lines.push(row.map(csvCell).join(","))
  }
  return lines.join("\n") + "\n"
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ""
  const text = typeof value === "string" ? value : typeof value === "object" ? JSON.stringify(value) : String(value)
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}
