/**
 * Confidence-bearing noul questions. Provider wire noul answers carry no
 * confidence value (verified on the wire, Oct 2026), but a two-level score
 * question does. A noul question with `withConfidence: true` is desugared
 * into a two-level score question (level 0 = false, level 1 = true) before
 * it reaches the provider, and the raw score answer is mapped back into a
 * noul-shaped answer afterwards — callers see the shape they asked for, plus
 * a real confidence value.
 *
 * Empirical validation (feedback round 5, 120 gate judgments): score-implied
 * pTrue vs plain noul pTrue differs by mean |Δ| 0.067 with 100%
 * same-side-of-0.5 agreement, and the confidence value separates "genuinely
 * torn" (mean 0.19 in the 0.35–0.65 band) from "decisive" (mean 0.89 at the
 * extremes) — the distinction |2p−1| cannot make.
 */
import { type Answer, type Question } from "./decision-types"

/** Map a caller-supplied question to the question the provider actually sees. */
export function desugarQuestion(question: Question): Question {
  if (question.type !== "noul" || question.withConfidence !== true) return question
  return {
    id: question.id,
    type: "score",
    instructions: question.instructions,
    criteria: [
      levelText(question.criteria?.false, "false — the predicate does not hold"),
      levelText(question.criteria?.true, "true — the predicate holds"),
    ],
  }
}

export function desugarQuestions(questions: readonly Question[]): Question[] {
  return questions.map(desugarQuestion)
}

/**
 * Map raw provider answers (keyed by question id, shaped for the DESUGARED
 * questions) back to the caller's question shapes. A two-level score answer
 * becomes `{type: "noul", pTrue, confidence}` — the position of a two-level
 * score IS the probability of its top level.
 */
export function resugarAnswers(
  questions: readonly Question[],
  answers: Record<string, Answer>,
): Record<string, Answer> {
  const out: Record<string, Answer> = {}
  for (const [id, answer] of Object.entries(answers)) {
    const question = questions.find((q) => q.id === id)
    if (question?.type === "noul" && question.withConfidence === true) {
      if (answer.type !== "score") {
        throw new Error(
          `question ${JSON.stringify(id)}: expected a score answer for a confidence-bearing noul question, got ${answer.type}`,
        )
      }
      out[id] = {
        type: "noul",
        pTrue: Math.min(Math.max(answer.score, 0), 1),
        ...(answer.confidence === undefined ? {} : { confidence: answer.confidence }),
      }
    } else {
      out[id] = answer
    }
  }
  return out
}

/** Score criteria are plain strings on the wire; stringify object descriptions. */
function levelText(description: unknown, fallback: string): string {
  if (description === undefined) return fallback
  if (typeof description === "string") return description
  return JSON.stringify(description)
}
