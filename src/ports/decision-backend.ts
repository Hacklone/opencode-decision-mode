import type { Answer, ProviderId, Question, Usage } from "../domain/decision-types"

/** Error raised by a decision backend for a request-level failure. */
export class BackendError extends Error {
  readonly status?: number
  readonly retryable: boolean

  constructor(message: string, options?: { status?: number; retryable?: boolean }) {
    super(message)
    this.status = options?.status
    this.retryable = options?.retryable ?? false
  }
}

/** Options a caller may pin for one request (selection overrides). */
export interface BackendRequest {
  state: string | object | unknown[]
  questions: Question[]
  model: string
  /** Abort when the caller (tool invocation) is cancelled. */
  signal: AbortSignal
}

export interface BackendResponse {
  provider: ProviderId
  /** Model as requested (alias preserved). */
  requestedModel: string
  /** Model as resolved by the provider when reported, else the requested model. */
  resolvedModel: string
  answers: Record<string, Answer>
  usage: Usage
}

/**
 * A single-record decision backend. One record with all of its questions is
 * one provider request — no multi-record packing, per the token-efficiency
 * invariants.
 */
export interface DecisionBackend {
  readonly provider: ProviderId
  decide(request: BackendRequest): Promise<BackendResponse>
}

export type BackendRegistry = Record<ProviderId, DecisionBackend | null>
