import {
  type Answer,
  type PolicySpec,
  type ProviderId,
  type Question,
  type Usage,
  type Verdict,
  policyFor,
} from "../domain/decision-types"
import { applyVerdicts } from "../domain/verdict"
import { BackendError, type BackendRegistry } from "../ports/decision-backend"
import { CACHE_SCHEMA_VERSION, type DecisionCache } from "../ports/cache"
import { cacheKeyFor } from "./cache-key"
import { composeContext } from "./projection"
import { desugarQuestions, resugarAnswers } from "../domain/noul-confidence"

export interface DecisionRequest {
  state: string | object | unknown[]
  /** Constant framing preamble, composed into the state (see composeContext). */
  context?: string
  questions: Question[]
  policy?: PolicySpec
  provider: ProviderId
  model: string
  /** "bypass" skips the cache read — re-sample identical inputs for variance studies. Writes still refresh the cache. */
  cache?: "bypass"
  signal: AbortSignal
}

export interface DecisionOutcome {
  provider: ProviderId
  requestedModel: string
  resolvedModel: string
  answers: Record<string, Answer>
  verdicts: Record<string, Verdict>
  verdict: Verdict | undefined
  usage: Usage
  cacheHit: boolean
}

/**
 * Single-record decision flow: validate → cache probe → backend call →
 * verdict projection. Identical requests (same provider, model, state,
 * questions, options) are served from cache without touching the provider.
 */
export class DecisionService {
  constructor(
    private readonly backends: BackendRegistry,
    private readonly cache: DecisionCache,
  ) {}

  async decide(request: DecisionRequest): Promise<DecisionOutcome> {
    // Confidence-bearing noul questions travel as two-level score questions;
    // the cache keys and stores the provider's raw (desugared-shaped)
    // answers, and every consumer sees the resugared noul shape.
    const questions = desugarQuestions(request.questions)
    const state =
      request.context === undefined ? request.state : composeContext(request.context, request.state)
    const key = cacheKeyFor({
      provider: request.provider,
      model: request.model,
      state,
      questions,
      schemaVersion: CACHE_SCHEMA_VERSION,
    })

    let raw: Record<string, Answer>
    let usage: Usage
    let resolvedModel: string
    let cacheHit: boolean

    const cached = request.cache === "bypass" ? null : await this.cache.get(key)
    if (cached !== null) {
      raw = cached.answers
      usage = cached.usage
      resolvedModel = cached.resolvedModel
      cacheHit = true
    } else {
      const backend = this.backends[request.provider]
      if (backend === null || backend === undefined) {
        throw backendUnavailable(request.provider)
      }
      const response = await backend.decide({
        state: state as string | object | unknown[],
        questions,
        model: request.model,
        signal: request.signal,
      })
      raw = response.answers
      usage = response.usage
      resolvedModel = response.resolvedModel
      await this.cache.set(key, { answers: raw, usage, resolvedModel })
      cacheHit = false
    }
    const answers = resugarAnswers(request.questions, raw)

    const { verdicts, verdict } = applyVerdicts(answers, (id) =>
      policyFor(request.policy, id),
    )

    return {
      provider: request.provider,
      requestedModel: request.model,
      resolvedModel,
      answers,
      verdicts,
      verdict,
      usage,
      cacheHit,
    }
  }
}

export function backendUnavailable(provider: ProviderId): BackendError {
  return new BackendError(`no backend configured for provider ${provider}`)
}
