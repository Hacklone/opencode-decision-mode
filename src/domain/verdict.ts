import type { Answer, Verdict, VerdictPolicy } from "./decision-types"

/**
 * Deterministic verdict policy for boolean (noul) answers.
 *
 *   p >= failAt   → FAIL
 *   p >= reviewAt → REVIEW
 *   otherwise     → PASS
 *
 * Boundary-inclusive on both thresholds so a policy of {reviewAt: x, failAt: x}
 * is still total: FAIL wins ties.
 */
export function verdictFor(pTrue: number, policy: VerdictPolicy): Verdict {
  if (pTrue >= policy.failAt) return "FAIL"
  if (pTrue >= policy.reviewAt) return "REVIEW"
  return "PASS"
}

/** Worst verdict across a set (FAIL > REVIEW > PASS). */
export function worstVerdict(verdicts: readonly Verdict[]): Verdict | undefined {
  let worst: Verdict | undefined
  for (const v of verdicts) {
    if (worst === undefined || rank(v) > rank(worst)) worst = v
  }
  return worst
}

function rank(verdict: Verdict): number {
  switch (verdict) {
    case "PASS":
      return 0
    case "REVIEW":
      return 1
    case "FAIL":
      return 2
  }
}

/**
 * Compute per-question verdicts for the boolean questions of a run.
 * Non-boolean answers contribute no verdict. Returns a map (possibly empty)
 * plus the worst overall verdict (undefined when nothing was judged).
 */
export function applyVerdicts(
  answers: Record<string, Answer>,
  policyForQuestion: (questionId: string) => VerdictPolicy,
): { verdicts: Record<string, Verdict>; verdict: Verdict | undefined } {
  const verdicts: Record<string, Verdict> = {}
  for (const [id, answer] of Object.entries(answers)) {
    if (answer.type === "noul") {
      verdicts[id] = verdictFor(answer.pTrue, policyForQuestion(id))
    }
  }
  return { verdicts, verdict: worstVerdict(Object.values(verdicts)) }
}
