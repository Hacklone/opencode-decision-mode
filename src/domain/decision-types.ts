/**
 * Core vocabulary of the Decision runtime. This module has zero dependencies:
 * everything downstream (application, ports, adapters) builds on these types.
 */

/** Decision providers supported by the plugin. The tuple is the single
 * source of the id list; zod enums and clients derive from it. */
export const PROVIDER_IDS = ["openrouter", "typesafe", "openai"] as const

export type ProviderId = (typeof PROVIDER_IDS)[number]

export const PROVIDERS: readonly ProviderId[] = PROVIDER_IDS

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && (PROVIDER_IDS as readonly string[]).includes(value)
}

/** Short forms used wherever space is scarce (footer, command arguments). */
export const PROVIDER_SHORT: Record<ProviderId, string> = {
  openrouter: "or",
  typesafe: "ts",
  openai: "oai",
}

/** Canonical id or short form -> provider id, for user-facing parsers. */
export const PROVIDER_ALIASES = Object.fromEntries(
  PROVIDERS.flatMap((id) => [[id, id], [PROVIDER_SHORT[id], id]] as [string, ProviderId][]),
) as Record<string, ProviderId>

/** Environment variable each provider's credential comes from. */
export const CREDENTIAL_ENV: Record<ProviderId, string> = {
  openrouter: "OPENROUTER_API_KEY",
  typesafe: "TYPESAFE_API_KEY",
  openai: "OPENAI_API_KEY",
}

/** Default model per provider when the user has not pinned one. */
export const DEFAULT_MODELS: Record<ProviderId, string> = {
  openrouter: "typesafe/jev-1.14",
  typesafe: "jev-latest",
  openai: "gpt-6-luna",
}

// ---------------------------------------------------------------------------
// Questions (control plane → data plane)
// ---------------------------------------------------------------------------

export type QuestionType = "noul" | "choice" | "score"

export const QUESTION_TYPES: readonly QuestionType[] = ["noul", "choice", "score"]

export function isQuestionType(value: unknown): value is QuestionType {
  return typeof value === "string" && (QUESTION_TYPES as readonly string[]).includes(value)
}

/** Instructions may be plain text or a structured object (both providers accept it). */
export type Instructions = string | object

export interface NoulCriteria {
  true?: Instructions
  false?: Instructions
}

export interface NoulQuestion {
  id: string
  type: "noul"
  instructions: Instructions
  criteria?: NoulCriteria
  /**
   * Ask through a two-level score question internally so the answer carries a
   * real confidence value (plain noul answers never do on the provider wire).
   * The answer still comes back noul-shaped: pTrue plus confidence. See
   * domain/noul-confidence.ts.
   */
  withConfidence?: boolean
}

/** Map of option value → description (null means the value is self-describing). */
export type ChoiceCriteria = Record<string, string | null>

export interface ChoiceQuestion {
  id: string
  type: "choice"
  instructions: Instructions
  criteria: ChoiceCriteria
}

export interface ScoreQuestion {
  id: string
  type: "score"
  instructions: Instructions
  /** Ordered level descriptions, lowest → highest. 2–10 levels. */
  criteria: string[]
}

export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion

export const MAX_CHOICE_OPTIONS = 255
export const MIN_SCORE_LEVELS = 2
export const MAX_SCORE_LEVELS = 10

/** Validate and normalize a question as supplied by a tool caller. Throws on shape errors. */
export function parseQuestion(input: unknown): Question {
  if (typeof input !== "object" || input === null) {
    throw new DecisionInputError("question must be an object")
  }
  const raw = input as Record<string, unknown>
  const id = raw.id
  if (typeof id !== "string" || id.length === 0) {
    throw new DecisionInputError("question.id must be a non-empty string")
  }
  if (!isQuestionType(raw.type)) {
    throw new DecisionInputError(
      `question ${id}: type must be one of ${QUESTION_TYPES.join(", ")}`,
    )
  }
  const instructions = raw.instructions
  if (
    typeof instructions !== "string" &&
    (typeof instructions !== "object" || instructions === null)
  ) {
    throw new DecisionInputError(`question ${id}: instructions must be a string or object`)
  }
  if (raw.type === "noul") {
    const question: NoulQuestion = { id, type: "noul", instructions }
    if (raw.withConfidence !== undefined) {
      if (typeof raw.withConfidence !== "boolean") {
        throw new DecisionInputError(`question ${id}: withConfidence must be a boolean`)
      }
      if (raw.withConfidence) question.withConfidence = true
    }
    if (raw.criteria !== undefined) {
      if (typeof raw.criteria !== "object" || raw.criteria === null) {
        throw new DecisionInputError(`question ${id}: noul criteria must be an object`)
      }
      const c = raw.criteria as Record<string, unknown>
      question.criteria = {
        ...(c.true === undefined ? {} : { true: c.true as Instructions }),
        ...(c.false === undefined ? {} : { false: c.false as Instructions }),
      }
    }
    return question
  }
  if (raw.type === "choice") {
    if (typeof raw.criteria !== "object" || raw.criteria === null || Array.isArray(raw.criteria)) {
      throw new DecisionInputError(
        `question ${id}: choice criteria must be an object of option → description`,
      )
    }
    const entries = Object.entries(raw.criteria as Record<string, unknown>)
    if (entries.length === 0) {
      throw new DecisionInputError(`question ${id}: choice criteria must define at least one option`)
    }
    if (entries.length > MAX_CHOICE_OPTIONS) {
      throw new DecisionInputError(
        `question ${id}: choice criteria exceeds ${MAX_CHOICE_OPTIONS} options`,
      )
    }
    const criteria: ChoiceCriteria = {}
    for (const [value, description] of entries) {
      if (description !== null && typeof description !== "string") {
        throw new DecisionInputError(
          `question ${id}: choice option ${JSON.stringify(value)} description must be a string or null`,
        )
      }
      criteria[value] = description
    }
    return { id, type: "choice", instructions, criteria }
  }
  // score
  if (
    !Array.isArray(raw.criteria) ||
    raw.criteria.some((level) => typeof level !== "string" || level.length === 0)
  ) {
    throw new DecisionInputError(
      `question ${id}: score criteria must be an array of non-empty level descriptions`,
    )
  }
  if (raw.criteria.length < MIN_SCORE_LEVELS || raw.criteria.length > MAX_SCORE_LEVELS) {
    throw new DecisionInputError(
      `question ${id}: score criteria needs ${MIN_SCORE_LEVELS}–${MAX_SCORE_LEVELS} levels, got ${raw.criteria.length}`,
    )
  }
  return { id, type: "score", instructions, criteria: [...raw.criteria] as string[] }
}

export function parseQuestions(input: unknown): Question[] {
  if (!Array.isArray(input)) {
    throw new DecisionInputError("questions must be an array")
  }
  if (input.length === 0) {
    throw new DecisionInputError("questions must contain at least one question")
  }
  const seen = new Set<string>()
  return input.map((q) => {
    const question = parseQuestion(q)
    if (seen.has(question.id)) {
      throw new DecisionInputError(`duplicate question id ${JSON.stringify(question.id)}`)
    }
    seen.add(question.id)
    return question
  })
}

export class DecisionInputError extends Error {
  readonly name = "DecisionInputError"
}

// ---------------------------------------------------------------------------
// Answers (data plane → control plane), provider-normalized
// ---------------------------------------------------------------------------

export interface NoulAnswer {
  type: "noul"
  /** Probability that the predicate holds (true). */
  pTrue: number
  /**
   * Real confidence, present only when the question was asked with
   * `withConfidence` (desugared to a two-level score internally); the
   * provider wire format for plain noul carries no confidence value.
   */
  confidence?: number
}

export interface ChoiceAnswer {
  type: "choice"
  choice: string
  /** Distribution over option values; compact result views omit it. */
  probabilities?: Record<string, number>
  confidence?: number
}

export interface ScoreAnswer {
  type: "score"
  /**
   * Probability-weighted position along the levels (0-based, may be
   * fractional; clamped into the criteria range by the backend).
   */
  score: number
  /**
   * Nearest level label. Populated on single-call responses; stored run rows
   * omit it (null) — the run summary's `levels` table holds each label once
   * and readers reconstruct it via `legendFor`. Null also survives on legacy
   * stored runs whose summary predates the levels table.
   */
  legend: string | null
  /** Distribution over level labels; compact result views omit it. */
  probabilities?: Record<string, number>
  confidence?: number
}

export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

export type CostSource = "provider" | "estimated"

export interface Usage {
  inputTokens: number | null
  outputTokens: number | null
  costUsd: number | null
  /** null when no cost is known at all. */
  costSource: CostSource | null
}

export const ZERO_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  costUsd: null,
  costSource: null,
}

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

export type Verdict = "PASS" | "REVIEW" | "FAIL"

export interface VerdictPolicy {
  /** p >= reviewAt ⇒ REVIEW. */
  reviewAt: number
  /** p >= failAt ⇒ FAIL. */
  failAt: number
}

export const DEFAULT_POLICY: VerdictPolicy = { reviewAt: 0.6, failAt: 0.85 }

export function parsePolicy(input: unknown): VerdictPolicy {
  if (typeof input !== "object" || input === null) {
    throw new DecisionInputError("policy must be an object with reviewAt and failAt")
  }
  const raw = input as Record<string, unknown>
  const reviewAt = raw.reviewAt
  const failAt = raw.failAt
  for (const [name, value] of [
    ["reviewAt", reviewAt],
    ["failAt", failAt],
  ] as const) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new DecisionInputError(`policy.${name} must be a number in [0, 1]`)
    }
  }
  const policy: VerdictPolicy = { reviewAt: reviewAt as number, failAt: failAt as number }
  if (policy.failAt < policy.reviewAt) {
    throw new DecisionInputError("policy.failAt must be >= policy.reviewAt")
  }
  return policy
}

/** Per-question policy overrides, keyed by question id. */
export type PolicySpec = VerdictPolicy | { default?: VerdictPolicy; questions?: Record<string, VerdictPolicy> }

export function parsePolicySpec(input: unknown): PolicySpec {
  if (typeof input !== "object" || input === null) {
    throw new DecisionInputError("policy must be an object")
  }
  const raw = input as Record<string, unknown>
  if (raw.questions !== undefined || raw.default !== undefined) {
    const spec: { default?: VerdictPolicy; questions?: Record<string, VerdictPolicy> } = {}
    if (raw.default !== undefined) spec.default = parsePolicy(raw.default)
    if (raw.questions !== undefined) {
      if (typeof raw.questions !== "object" || raw.questions === null) {
        throw new DecisionInputError("policy.questions must be an object keyed by question id")
      }
      spec.questions = {}
      for (const [id, value] of Object.entries(raw.questions)) {
        spec.questions[id] = parsePolicy(value)
      }
    }
    return spec
  }
  return parsePolicy(raw)
}

/** Resolve the effective policy for a question id. */
export function policyFor(spec: PolicySpec | undefined, questionId: string): VerdictPolicy {
  if (spec === undefined) return DEFAULT_POLICY
  if ("reviewAt" in spec) return spec
  return spec.questions?.[questionId] ?? spec.default ?? DEFAULT_POLICY
}

// ---------------------------------------------------------------------------
// Record results
// ---------------------------------------------------------------------------

export type RecordStatus = "ok" | "error"

export interface RecordResult {
  /** 0-based index of the record within the run's source. */
  index: number
  /** Stable identity when the source provides one; null otherwise. */
  key: string | null
  status: RecordStatus
  error?: string
  /** Snapshot of the source record's fields, taken at run time; lets result
   * consumers report record content without re-reading (or re-judging) the file. */
  record?: Record<string, unknown>
  answers?: Record<string, Answer>
  /** Worst verdict across boolean questions with a policy. */
  verdict?: Verdict
  verdicts?: Record<string, Verdict>
  usage?: Usage
  cacheHit?: boolean
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export interface RunSourceInfo {
  path: string
  format: "csv" | "jsonl"
  totalRecords: number
}

export interface RunSummary {
  id: string
  provider: ProviderId
  /** Model as requested (may be an alias such as jev-latest). */
  requestedModel: string
  /** Model as resolved by the provider when reported, else the requested model. */
  resolvedModel: string
  total: number
  ok: number
  error: number
  cached: number
  verdicts: { pass: number; review: number; fail: number }
  usage: Usage
  durationMs: number
  createdAt: string
  source: RunSourceInfo
  /**
   * Fingerprint of the measurement instrument: state composition (template /
   * projected fields / context preamble) plus the questions — provider,
   * policy and per-record state excluded. Diff inputHash across run summaries
   * to detect an accidentally changed preamble or question set before
   * comparing verdicts. Absent on legacy summaries stored before it existed.
   */
  inputHash?: string
  /**
   * Score-question level labels, stored once per run instead of repeated in
   * every row's answers — a 200-character level string otherwise duplicates
   * once per record per question. Stored rows carry `legend: null`; readers
   * reconstruct via `legendFor`. Absent on legacy summaries (rows there keep
   * their inline legends).
   */
  levels?: Record<string, string[]>
}

/** Stored rows may omit the level label; reconstruct it from the run's level table. */
export function legendFor(
  levels: Record<string, string[]> | undefined,
  id: string,
  score: number,
): string | null {
  const table = levels?.[id]
  if (table === undefined || table.length === 0) return null
  const index = Math.min(Math.max(Math.round(score), 0), table.length - 1)
  return table[index] ?? null
}

export interface RunRecord {
  summary: RunSummary
  results: RecordResult[]
}
