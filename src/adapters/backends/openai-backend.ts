import OpenAI from "openai"
import type { Answer, Question, Usage } from "../../domain/decision-types"
import { ESTIMATED_PRICING, estimateCost } from "../../domain/usage"
import { BackendError, type BackendRequest, type BackendResponse, type DecisionBackend } from "../../ports/decision-backend"
import { asNumber, asRecord, asString, clamp01, scoreIndex, toBackendError, withSignal } from "./normalize"

/**
 * OpenAI native Decisions backend (`POST /v1/decisions`, model gpt-6-luna).
 * Booleans map to predicates; decisions-endpoint pricing is $0.10 per 1M
 * input tokens with no output charge, so cost is estimated from input only.
 */
export class OpenAIBackend implements DecisionBackend {
  readonly provider = "openai" as const
  private readonly client: OpenAI

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey })
  }

  async decide(request: BackendRequest): Promise<BackendResponse> {
    const questions = request.questions.map(toOpenAiQuestion)
    const input = typeof request.state === "string" ? request.state : JSON.stringify(request.state)

    let raw: unknown
    try {
      const response = await withSignal(
        this.client.decisions.create({
          model: request.model,
          input,
          questions: questions as never,
        }),
        request.signal,
      )
      raw = response
    } catch (error) {
      throw toBackendError(error, "openai")
    }

    const body = asRecord(raw)
    if (body === null) throw new BackendError("openai: response was not an object")

    const answers = normalizeOpenAiAnswers(body["answers"], request.questions)
    const usage = estimateOpenAiUsage(body["usage"])
    const resolvedModel = asString(body["model"]) ?? request.model
    return { provider: this.provider, requestedModel: request.model, resolvedModel, answers, usage }
  }
}

function toOpenAiQuestion(question: Question): unknown {
  switch (question.type) {
    case "noul":
      return { type: "predicate", name: question.id, instructions: question.instructions }
    case "choice": {
      const choices = Object.entries(question.criteria).map(([value, description]) =>
        description === null ? { value } : { value, description },
      )
      return { type: "choice", name: question.id, instructions: question.instructions, choices }
    }
    case "score": {
      const levels = question.criteria.map((label) => ({ label }))
      return { type: "score", name: question.id, instructions: question.instructions, levels }
    }
  }
}

export function normalizeOpenAiAnswers(raw: unknown, questions: readonly Question[]): Record<string, Answer> {
  const list = Array.isArray(raw) ? raw : []
  const byName = new Map<string, Record<string, unknown>>()
  for (const entry of list) {
    const record = asRecord(entry)
    const name = record === null ? null : asString(record["name"])
    if (record !== null && name !== null) byName.set(name, record)
  }

  const answers: Record<string, Answer> = {}
  for (const question of questions) {
    const record = byName.get(question.id)
    if (record === undefined) {
      throw new BackendError(`openai: missing answer for question ${JSON.stringify(question.id)}`)
    }
    const type = asString(record["type"])
    if (type === "refusal") {
      throw new BackendError(`openai: question ${JSON.stringify(question.id)} was refused`)
    }
    answers[question.id] = normalizeOpenAiAnswer(record, question)
  }
  return answers
}

function normalizeOpenAiAnswer(record: Record<string, unknown>, question: Question): Answer {
  const type = asString(record["type"])
  if (type === "predicate") {
    const probability = asNumber(record["probability"])
    if (probability === null) throw new BackendError("openai: predicate answer missing probability")
    return { type: "noul", pTrue: clamp01(probability) }
  }
  if (type === "choice") {
    const choice = asString(record["choice"])
    if (choice === null) throw new BackendError("openai: choice answer missing selection")
    const answer: Answer = {
      type: "choice",
      choice,
      probabilities: listToMap(record["probabilities"], "value"),
    }
    const confidence = asNumber(record["confidence"])
    if (confidence !== null) return { ...answer, confidence: clamp01(confidence) }
    return answer
  }
  if (type === "score") {
    if (question.type !== "score") {
      throw new BackendError(`openai: score answer for ${question.type} question ${question.id}`)
    }
    const score = scoreIndex(record["score"], question.criteria)
    const answer: Answer = {
      type: "score",
      score,
      // scoreIndex guarantees a valid index, so criteria[score] is always defined.
      legend: question.criteria[score]!,
      probabilities: listToMap(record["probabilities"], "label"),
    }
    const confidence = asNumber(record["confidence"])
    if (confidence !== null) return { ...answer, confidence: clamp01(confidence) }
    return answer
  }
  throw new BackendError(`openai: unrecognized answer type ${JSON.stringify(type)}`)
}

/** OpenAI returns probabilities as arrays of {value|label, probability}; normalize to a map. */
function listToMap(raw: unknown, keyField: "value" | "label"): Record<string, number> {
  if (!Array.isArray(raw)) return {}
  const out: Record<string, number> = {}
  for (const entry of raw) {
    const record = asRecord(entry)
    if (record === null) continue
    const key = asString(record[keyField])
    const probability = asNumber(record["probability"])
    if (key !== null && probability !== null) out[key] = probability
  }
  return out
}

export function estimateOpenAiUsage(raw: unknown): Usage {
  const record = asRecord(raw)
  const inputTokens = record === null ? null : asNumber(record["input_tokens"])
  const outputTokens = record === null ? null : asNumber(record["output_tokens"])
  const input = inputTokens === null ? null : Math.max(0, Math.round(inputTokens))
  const output = outputTokens === null ? null : Math.max(0, Math.round(outputTokens))
  const cost = estimateCost(input, ESTIMATED_PRICING.openai)
  return { inputTokens: input, outputTokens: output, costUsd: cost, costSource: cost === null ? null : "estimated" }
}
