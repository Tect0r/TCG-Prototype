import { proportion, type ProportionEstimate } from '../analysis/stats.js';
import type { AdaptiveBlockDecision } from './block.js';
import type { AdaptiveCandidateScreening, AdaptiveScreeningTallies } from './evaluate.js';
import type { AdaptiveRevision } from './revision.js';

/**
 * Promotion, rollback and moving opponents (M08.17C).
 *
 * `./block.ts` decides which side lost a mirrored block; `./generate.ts`
 * produces that side's legal candidates; `./evaluate.ts` schedules and
 * tallies each candidate's own screening. This file is where those tallies
 * finally become a decision: which candidate, if any, is promoted to be the
 * lineage's next revision — deterministically, so the same evidence always
 * produces the same decision — and that the incumbent is retained rather
 * than silently replaced when nothing actually beat the opponent. Nothing
 * here schedules or runs a game; it only reads finished evidence.
 *
 * Two things this file is careful never to conflate:
 *
 * - **Series wins versus screening evidence.** `AdaptiveSeriesTally` sums
 *   only `./block.ts`'s own `AdaptiveBlockDecision`s — the mirrored series a
 *   lineage actually plays, generation over generation. `tallyAdaptiveSeries`
 *   never reads an `AdaptiveCandidateScreening`, and `decideAdaptivePromotion`
 *   never reads a series entry: the two evidence streams stay on separate
 *   types so a promotion decision can never be justified by cumulative
 *   series wins, and a series report can never be padded with one
 *   generation's candidate-screening evidence.
 * - **A moving opponent.** Either side of a block can be the one that loses
 *   and adapts (`AdaptiveBlockSide` in `./block.ts`), so the "current
 *   opponent" a lineage's candidates were screened against can itself have
 *   moved on to a new revision by the time a promotion decision is made.
 *   `decideAdaptivePromotion` checks every candidate's recorded
 *   `opponentDeckHash` (`AdaptiveScreeningMatch`, M08.17B) against the
 *   opponent revision handed in now, and refuses to promote *anything* this
 *   round when even one candidate's evidence was collected against a
 *   different deck — that candidate has to be re-screened against the
 *   current opponent, never promoted on stale evidence. A candidate with zero
 *   `opponentMatches` (reachable when `referenceFieldShare` leaves no budget
 *   for opponent games this round, `./evaluate.ts`) is treated the same way:
 *   it has no evidence describing the current opponent at all, so it is
 *   named stale rather than silently qualifying on reference-field wins
 *   alone.
 */

export interface AdaptiveSeriesEntry {
  readonly generation: number;
  readonly block: number;
  readonly incumbentRevisionId: string;
  readonly opponentRevisionId: string;
  readonly decision: AdaptiveBlockDecision;
}

/** Cumulative decisive-block wins across a run's whole series. Never derived from candidate screening. */
export interface AdaptiveSeriesTally {
  readonly incumbentWins: number;
  readonly opponentWins: number;
  readonly ties: number;
  readonly noDecisions: number;
}

/** Sums a run's recorded block decisions. Order-independent; a replay in any order tallies the same. */
export function tallyAdaptiveSeries(entries: readonly AdaptiveSeriesEntry[]): AdaptiveSeriesTally {
  let incumbentWins = 0;
  let opponentWins = 0;
  let ties = 0;
  let noDecisions = 0;
  for (const entry of entries) {
    const decision = entry.decision;
    if (decision.kind === 'tie') ties += 1;
    else if (decision.kind === 'no_decision') noDecisions += 1;
    // The block's loser is the side that did *not* win, so a loser of
    // "incumbent" means the opponent side took this block, and vice versa.
    else if (decision.loser === 'incumbent') opponentWins += 1;
    else incumbentWins += 1;
  }
  return { incumbentWins, opponentWins, ties, noDecisions };
}

/** One candidate's finished screening and its tally, bundled for a promotion decision. */
export interface AdaptiveCandidateEvidence {
  readonly candidate: AdaptiveRevision;
  readonly screening: AdaptiveCandidateScreening;
  readonly tallies: AdaptiveScreeningTallies;
}

/**
 * One candidate's promotion score: the Wilson-interval win rate over the
 * decisive games its own objective actually counts. `pure_counter` (and any
 * `meta_aware` screening that fell back to opponent-only play because its
 * reference field was empty, `./evaluate.ts`) reads the opponent group alone;
 * `meta_aware` with field games combines both groups into one pool, matching
 * how `scheduleAdaptiveCandidateScreening` already spent one shared game
 * budget across them rather than treating the field as a bonus. Ranked on the
 * lower bound rather than the point estimate for the same reason
 * `deck-search/evolve.ts` scores that way: a confident result should outrank
 * a lucky one at small sample sizes.
 */
export function adaptivePromotionScore(evidence: AdaptiveCandidateEvidence): ProportionEstimate {
  const { tallies, screening } = evidence;
  const groups =
    screening.objective === 'pure_counter' || !tallies.field
      ? [tallies.opponent]
      : [tallies.opponent, tallies.field];
  const wins = groups.reduce((sum, group) => sum + group.candidateWins, 0);
  const losses = groups.reduce((sum, group) => sum + group.opponentWins, 0);
  return proportion(wins, wins + losses);
}

export type AdaptivePromotionDecision =
  | {
      readonly kind: 'promoted';
      readonly revision: AdaptiveRevision;
      readonly score: ProportionEstimate;
    }
  | { readonly kind: 'retained'; readonly reason: string }
  | {
      readonly kind: 'stale';
      readonly staleRevisionIds: readonly string[];
      readonly reason: string;
    };

export interface DecideAdaptivePromotionInput {
  readonly incumbent: AdaptiveRevision;
  /** The opponent revision to evaluate against *now* — may differ from the one a stale candidate was screened against. */
  readonly opponentRevision: AdaptiveRevision;
  readonly candidates: readonly AdaptiveCandidateEvidence[];
}

/**
 * Selects and promotes a candidate deterministically, or retains the
 * incumbent when nothing qualifies.
 *
 * A candidate qualifies only by decisively beating the opponent — strictly
 * more decisive wins than losses across the groups its objective counts,
 * `noResult` games excluded — the same "tie is not a win" rule
 * `decideAdaptiveBlock` applies to a whole block, restated here for one
 * candidate's screening. Among qualifying candidates the highest promotion
 * score wins; an exact tie breaks on `revisionId` so the choice never depends
 * on array order. Zero qualifying candidates — including zero candidates at
 * all — retains the incumbent with an explained reason, never an empty or
 * arbitrary promotion.
 *
 * Before any of that, every candidate's screening is checked against the
 * opponent revision handed in now: if it was screened against a different
 * deck (`opponentDeckHash`, M08.17B), the opponent has moved since, and this
 * function refuses to decide at all — returning every stale revision id so
 * the caller can re-screen exactly those candidates — rather than promoting
 * from evidence that no longer describes the opponent it would be promoted
 * over.
 */
export function decideAdaptivePromotion(
  input: DecideAdaptivePromotionInput,
): AdaptivePromotionDecision {
  const { incumbent, opponentRevision, candidates } = input;

  const staleRevisionIds = candidates
    .filter(
      (evidence) =>
        evidence.screening.opponentMatches.length === 0 ||
        evidence.screening.opponentMatches.some(
          (match) => match.opponentDeckHash !== opponentRevision.deck.hash,
        ),
    )
    .map((evidence) => evidence.candidate.revisionId)
    .sort();
  if (staleRevisionIds.length > 0) {
    return {
      kind: 'stale',
      staleRevisionIds,
      reason:
        `${String(staleRevisionIds.length)} candidate(s) have no screening evidence against the ` +
        `current opponent ${opponentRevision.revisionId} (screened against a different opponent ` +
        'revision, or scheduled zero opponent games this round); re-screen ' +
        `${staleRevisionIds.length === 1 ? 'it' : 'them'} against the current opponent before ` +
        'promotion can be decided.',
    };
  }

  const qualified = candidates
    .map((evidence) => ({ evidence, score: adaptivePromotionScore(evidence) }))
    .filter(({ score }) => score.successes > score.total - score.successes)
    .sort((left, right) => {
      if (right.score.low !== left.score.low) return right.score.low - left.score.low;
      return left.evidence.candidate.revisionId.localeCompare(right.evidence.candidate.revisionId);
    });

  const winner = qualified[0];
  if (!winner) {
    return {
      kind: 'retained',
      reason:
        candidates.length === 0
          ? `no candidate was available to evaluate against opponent ${opponentRevision.revisionId}; ` +
            `incumbent ${incumbent.revisionId} is retained.`
          : `none of the ${String(candidates.length)} screened candidate(s) decisively beat ` +
            `opponent ${opponentRevision.revisionId}; incumbent ${incumbent.revisionId} is retained.`,
    };
  }

  return { kind: 'promoted', revision: winner.evidence.candidate, score: winner.score };
}
