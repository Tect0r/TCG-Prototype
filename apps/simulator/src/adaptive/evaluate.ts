import { z } from 'zod';
import type { PilotSpec } from '@tcg/bot-interface';
import type { Environment } from '../environment.js';
import { buildSchedule, type ScheduleDeck, type ScheduledMatch } from '../schedule.js';
import { seededIndex } from '../seed.js';
import type { AdaptiveConfig } from './config.js';
import type { AdaptiveRevision } from './revision.js';

/**
 * Candidate and reference-field evaluation (M08.17B).
 *
 * `./block.ts` schedules and decides a mirrored block in the abstract, without
 * ever naming which revision plays which games. This file is what actually
 * evaluates one candidate: it schedules that candidate's own games — against
 * the current opponent revision, and (only when `referenceFieldShare` calls
 * for it) against a deterministically selected slice of a caller-supplied
 * reference field — and attributes every resulting `ScheduledMatch` to the
 * candidate's `revisionId` and a seed path derived from the candidate's own
 * `seedPath`.
 *
 * Two things this file deliberately does not do:
 *
 * - It never runs a game. Like `./block.ts`, it only builds schedules; feeding
 *   them to `runBatch` and collecting `MatchRecord`s is an orchestrator's job,
 *   not named by any slice yet.
 * - It never blends opponent and reference-field evidence into one number.
 *   `AdaptiveCandidateScreening` keeps `opponentMatches` and `fieldMatches` —
 *   and `tallyAdaptiveScreening` keeps `opponent` and `field` — as separate
 *   fields, with `field` explicitly `null` (not zero) whenever there is no
 *   reference-field evidence to report. A "meta-aware" objective that mixes
 *   the two into a single promotion score, and a "pure-counter" objective
 *   that acts on the opponent tally alone, are both M08.17C's job to define;
 *   this file only labels which one a given config asks for.
 */

export const ADAPTIVE_OBJECTIVES = ['meta_aware', 'pure_counter'] as const;
export const adaptiveObjectiveSchema = z.enum(ADAPTIVE_OBJECTIVES);
export type AdaptiveObjective = (typeof ADAPTIVE_OBJECTIVES)[number];

/**
 * Which objective a config asks for, derived rather than stored: a run with
 * no reference-field share configured (`referenceFieldShare` 0, the schema
 * default) has nothing but opponent evidence to evaluate on and is
 * `pure_counter`; any positive share means some of the block's games are
 * deliberately spent against the wider field instead, which is `meta_aware`.
 */
export function adaptiveObjectiveOf(
  config: Pick<AdaptiveConfig, 'referenceFieldShare'>,
): AdaptiveObjective {
  return config.referenceFieldShare > 0 ? 'meta_aware' : 'pure_counter';
}

export const ADAPTIVE_SCREENING_OPPONENT_KINDS = ['opponent_revision', 'reference_field'] as const;
export type AdaptiveScreeningOpponentKind = (typeof ADAPTIVE_SCREENING_OPPONENT_KINDS)[number];

/** One screening game, attributed to the candidate revision that produced it. */
export interface AdaptiveScreeningMatch {
  readonly revisionId: string;
  readonly seedPath: string;
  readonly opponentKind: AdaptiveScreeningOpponentKind;
  readonly opponentDeckHash: string;
  readonly match: ScheduledMatch;
}

export interface AdaptiveCandidateScreeningInput {
  readonly environment: Environment;
  readonly config: Pick<AdaptiveConfig, 'id' | 'blockSize' | 'mirrorSeats' | 'referenceFieldShare'>;
  readonly candidate: AdaptiveRevision;
  /** The block this screening belongs to; folded into every match's identity. */
  readonly block: number;
  readonly opponentDeck: ScheduleDeck;
  /**
   * The reference field's decks, supplied by the caller rather than resolved
   * from config (M08.16's closed scope names a `referenceFieldShare` *split*
   * of the block's games, never a reference-field deck source of its own).
   * Empty when the caller has no reference field available; a config asking
   * for `meta_aware` evaluation against an empty field falls back to
   * `pure_counter` behaviour rather than failing.
   */
  readonly referenceField: readonly ScheduleDeck[];
  readonly pilots: readonly PilotSpec[];
}

export interface AdaptiveCandidateScreening {
  readonly revisionId: string;
  readonly objective: AdaptiveObjective;
  readonly opponentMatches: readonly AdaptiveScreeningMatch[];
  readonly fieldMatches: readonly AdaptiveScreeningMatch[];
}

/** Extends the candidate's own seed path, the same way `generate.ts`'s `candidateSeedPath` extends a block's. */
function screeningSeedPath(
  candidate: AdaptiveRevision,
  opponentKind: AdaptiveScreeningOpponentKind,
  index: number,
): string {
  const tag = opponentKind === 'opponent_revision' ? 'opp' : 'field';
  return `${candidate.seedPath}|screen:${tag}:${String(index).padStart(4, '0')}`;
}

function scheduleAgainst(
  input: AdaptiveCandidateScreeningInput,
  opponentDeck: ScheduleDeck,
  opponentKind: AdaptiveScreeningOpponentKind,
  gamesPerOrientation: number,
  groupIndex: number,
): AdaptiveScreeningMatch[] {
  const seedPath = screeningSeedPath(input.candidate, opponentKind, groupIndex);
  const matches = buildSchedule({
    experimentId:
      `${input.config.id}:screen:${String(input.block).padStart(4, '0')}` +
      `:${opponentKind}:${String(groupIndex).padStart(4, '0')}`,
    experimentSeed: seedPath,
    environmentId: input.environment.id,
    decks: [input.candidate.deck, opponentDeck],
    pilots: input.pilots,
    pilotPairing: 'mirror',
    playerCount: 2,
    gamesPerPairing: gamesPerOrientation,
    mirrorSeats: input.config.mirrorSeats,
    schedule: 'round_robin',
    sampledPairings: 1,
  });
  return matches.map((match) => ({
    revisionId: input.candidate.revisionId,
    seedPath,
    opponentKind,
    opponentDeckHash: opponentDeck.hash,
    match,
  }));
}

function dedupeByHash(decks: readonly ScheduleDeck[]): ScheduleDeck[] {
  const byHash = new Map<string, ScheduleDeck>();
  for (const deck of decks) if (!byHash.has(deck.hash)) byHash.set(deck.hash, deck);
  return [...byHash.values()].sort((left, right) => left.hash.localeCompare(right.hash));
}

/**
 * Deterministic rotating selection of up to `wanted` distinct reference-field
 * decks, modeled on `deck-search/evolve.ts`'s `selectOpponents`: derived from
 * the candidate's own seed path rather than a clock or counter, so the same
 * candidate always screens against the same slice of a given field.
 */
function selectReferenceField(
  candidate: AdaptiveRevision,
  pool: readonly ScheduleDeck[],
  wanted: number,
): ScheduleDeck[] {
  const deduped = dedupeByHash(pool);
  const capped = Math.min(wanted, deduped.length);
  const chosen: ScheduleDeck[] = [];
  const used = new Set<string>();
  for (let index = 0; chosen.length < capped && index < deduped.length * 4; index += 1) {
    const pickIndex = seededIndex(`${candidate.seedPath}|field:${String(index)}`, deduped.length);
    const deck = deduped[pickIndex];
    if (!deck || used.has(deck.hash)) continue;
    used.add(deck.hash);
    chosen.push(deck);
  }
  return chosen;
}

/**
 * Schedules one candidate's screening games for one block: always against the
 * current opponent revision, and — only under a `meta_aware` objective with a
 * non-empty reference field — against a deterministically selected slice of
 * that field, one game per selected deck. The two groups split the same fixed
 * `blockSize`-per-orientation budget `./block.ts` uses rather than adding to
 * it, matching `config.ts`'s own doc comment: reference-field games are drawn
 * "rather than" from the current opponent, not in addition to it.
 */
export function scheduleAdaptiveCandidateScreening(
  input: AdaptiveCandidateScreeningInput,
): AdaptiveCandidateScreening {
  const objective = adaptiveObjectiveOf(input.config);
  const fieldPerOrientation =
    objective === 'pure_counter' || input.referenceField.length === 0
      ? 0
      : Math.round(input.config.blockSize * input.config.referenceFieldShare);
  const opponentPerOrientation = input.config.blockSize - fieldPerOrientation;

  const opponentMatches = scheduleAgainst(
    input,
    input.opponentDeck,
    'opponent_revision',
    opponentPerOrientation,
    0,
  );

  const fieldDecks =
    fieldPerOrientation > 0
      ? selectReferenceField(input.candidate, input.referenceField, fieldPerOrientation)
      : [];
  const fieldMatches = fieldDecks.flatMap((deck, index) =>
    scheduleAgainst(input, deck, 'reference_field', 1, index + 1),
  );

  return {
    revisionId: input.candidate.revisionId,
    objective,
    opponentMatches,
    fieldMatches,
  };
}

/** One screened game's outcome. `winnerDeckHash` is `null` for an abnormal or otherwise uncounted result. */
export interface AdaptiveScreeningResult {
  readonly matchId: string;
  readonly winnerDeckHash: string | null;
}

/** A win tally over one group of screening matches. `noResult` covers abnormal terminations and missing results alike. */
export interface AdaptiveScreeningTally {
  readonly candidateWins: number;
  readonly opponentWins: number;
  readonly noResult: number;
}

/** Mirrors `AdaptiveScreeningTally` for persistence (M08.18D). */
export const adaptiveScreeningTallySchema = z.strictObject({
  candidateWins: z.number().int().min(0),
  opponentWins: z.number().int().min(0),
  noResult: z.number().int().min(0),
});

function tallyGroup(
  matches: readonly AdaptiveScreeningMatch[],
  candidateDeckHash: string,
  resultsByMatchId: ReadonlyMap<string, string | null>,
): AdaptiveScreeningTally {
  let candidateWins = 0;
  let opponentWins = 0;
  let noResult = 0;
  for (const entry of matches) {
    const winnerDeckHash = resultsByMatchId.get(entry.match.matchId);
    if (winnerDeckHash === undefined || winnerDeckHash === null) noResult += 1;
    else if (winnerDeckHash === candidateDeckHash) candidateWins += 1;
    else opponentWins += 1;
  }
  return { candidateWins, opponentWins, noResult };
}

export interface AdaptiveScreeningTallies {
  readonly opponent: AdaptiveScreeningTally;
  /** `null` — not a zero tally — whenever this screening scheduled no reference-field games. */
  readonly field: AdaptiveScreeningTally | null;
}

/**
 * Tallies a completed screening's results, keeping the opponent and
 * reference-field groups separate exactly as `AdaptiveCandidateScreening`
 * does. Deciding *from* these tallies — a single promotion verdict, whatever
 * a `meta_aware` config does to combine them — is M08.17C's job.
 */
export function tallyAdaptiveScreening(
  screening: AdaptiveCandidateScreening,
  candidateDeckHash: string,
  results: readonly AdaptiveScreeningResult[],
): AdaptiveScreeningTallies {
  const resultsByMatchId = new Map(
    results.map((result) => [result.matchId, result.winnerDeckHash]),
  );
  return {
    opponent: tallyGroup(screening.opponentMatches, candidateDeckHash, resultsByMatchId),
    field:
      screening.fieldMatches.length === 0
        ? null
        : tallyGroup(screening.fieldMatches, candidateDeckHash, resultsByMatchId),
  };
}
