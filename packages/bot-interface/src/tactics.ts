import { z } from 'zod';

/**
 * Tactical profiles — the *scoring* half of a difficulty (M09.14).
 *
 * M09.13 defined a difficulty as one thing: which of the scored candidates a bot
 * takes. That was the whole truth while the only difficulties were Normal (take
 * the best) and Easy (take something bounded-worse), because both of them are
 * differences in **selection** over an identical candidate list with identical
 * scores. Hard is not: the M05.6 calibration suite recorded six decisions no
 * pilot in this build makes, and every one of them is a defect in how a
 * candidate is *valued* or in which candidates are enumerated at all. Selecting
 * more carefully from a list that does not contain the right play cannot fix
 * one of them.
 *
 * So a difficulty has two halves from here on, and they are deliberately two
 * things rather than one:
 *
 * - a **tactical profile**, here, which decides how candidates are enumerated
 *   and scored;
 * - a **selection**, in `@tcg/bot-config`, which decides which scored candidate
 *   is taken.
 *
 * Normal and Easy both fly `baseline`, whose every refinement is off, so "Normal
 * is unchanged" stays true by construction — the same guarantee M09.13 got from
 * `{ kind: 'best' }` — and is measured anyway in `tactics.test.ts`.
 *
 * **What this is not.** A profile cannot invent an action: every refinement
 * below either widens the candidate list with a plan the engine has already
 * declared legal, or changes a number attached to a candidate that was on the
 * list either way. Nothing here reads a `MatchState`, an opponent's hand, an
 * opponent's deck or anything else outside the `BotObservation` a networked bot
 * receives — `tactics.test.ts` asserts the signature-level version of that, and
 * the calibration table asserts the behavioural one by running every fixture
 * through the same redacted view.
 *
 * **Hard is not published by this file.** `hard_tactical` is the tactical half
 * of Hard and M09.15 owns the strategic half; `DIFFICULTY_REGISTRY.hard` stays
 * `planned` until both exist, which is why nothing in `@tcg/bot-config` moved in
 * M09.14 and why no lobby can select this yet.
 */

export const TACTICAL_PROFILE_IDS = ['baseline', 'hard_tactical'] as const;
export const tacticalProfileIdSchema = z.enum(TACTICAL_PROFILE_IDS);
export type TacticalProfileId = z.infer<typeof tacticalProfileIdSchema>;

/**
 * Bumped when a **profile is added or retired**, the way
 * `CALIBRATION_SUITE_VERSION` pins an instrument. A refinement changing what it
 * does moves that profile's own `version` instead, because a result citing
 * `hard_tactical` needs to say *which* one it flew.
 *
 * - 1 — M09.14, the first registry: `baseline` and `hard_tactical`.
 */
export const TACTICS_REGISTRY_VERSION = 1;

/**
 * How a profile enumerates and scores candidates.
 *
 * Every field is a named correction to a defect the calibration suite recorded,
 * documented by the defect rather than by the mechanism, because these numbers
 * are read back by somebody deciding whether a Hard result means anything.
 * `baseline` is every field off, and the type is a plain `Record` of switches
 * rather than a union so that "off" and "on" run the *same* code path with
 * different constants — a second path is how two difficulties come to disagree
 * about something neither of them is supposed to be deciding.
 */
export interface TacticalProfile {
  readonly id: TacticalProfileId;
  /** The version of *this* profile's behaviour, for a result that cites it. */
  readonly version: string;
  /** What the profile is, in one sentence a record can print. */
  readonly summary: string;
  /**
   * Prices a removal target by how much of it the instruction actually removes.
   *
   * Closes the M05.6 finding "removal targeting ignores lethality":
   * `rankChoiceOptions` orders by board value alone, so Throwing Knife and Crude
   * Bomb are aimed at the biggest body on the table rather than at the one the
   * damage defeats. With this on, a target the printed damage defeats keeps its
   * whole board value and a target that merely takes damage keeps the fraction
   * of it the damage actually removed — so "two damage into a 2/5" is priced at
   * two fifths of a 2/5 rather than at a whole one.
   *
   * Deliberately not a bonus with a tuned size: a multiplier over board value
   * has no units and would have to be re-tuned against every weight vector,
   * while a fraction of the body removed is the same statement for all of them.
   * It applies only where the amount is a printed number the pilot can read off
   * its own card, and to nothing else — a dynamic amount is left at full value
   * rather than guessed at.
   */
  readonly readsRemovalLethality: boolean;
  /**
   * Offers a block that answers the attacker without losing the blocker.
   *
   * Closes the M05.6 finding "blocking prefers a trade to a block that loses
   * nothing": `greedyBlocks` takes the smallest blocker that kills *or*
   * survives, so a 2/1 is thrown in front of a 3/2 that a 2/5 would have eaten
   * and survived. This adds one more named plan — prefer a blocker that
   * survives, then one that also kills — and leaves the scorer to choose between
   * it and the trade. A widened list, not a rule: the trade is still on offer
   * and still wins where it is genuinely better.
   */
  readonly offersPreservingBlocks: boolean;
  /**
   * Never prices a body given up below the same body taken from an opponent.
   *
   * The baseline scores an exchange with two independent weights — a style's
   * eagerness to trade — applied to board value. On an *even* trade that
   * produces points out of nothing: a defensive vector values taking an enemy
   * 3/2 at 1.3 and losing its own at 0.9, so two identical units annihilating
   * each other reads as a gain. With this on, the loss coefficient is raised to
   * the style's own gain coefficient whenever it is lower, which makes an even
   * trade exactly neutral for every weight vector and leaves a style that was
   * already loss-averse completely untouched. It never lowers a coefficient, so
   * it cannot make a pilot *more* willing to throw bodies away.
   */
  readonly ownLossAversion: boolean;
  /**
   * Models Barrier when predicting who survives a combat.
   *
   * `wouldDefeat` compares Attack against remaining Health and stops there, so a
   * unit whose Barrier is still unspent reads as killable and a pilot trades
   * into it or declines a block it would have won. `barrierSpent` is on the
   * public view for exactly this reason (M06.1), so this reads a board fact
   * rather than a hidden one. Modelled as one prevented damage event per
   * combatant, which is what the engine does.
   */
  readonly modelsBarrier: boolean;
  /**
   * Models Overwhelm's overflow onto the defending player.
   *
   * The hypothetical combat treats every blocked attacker as fully stopped, so
   * chump-blocking a 7/7 Overwhelm attacker reads as preventing seven damage
   * when it prevents the blocker's Health and no more. That mis-prices both
   * sides of the same combat — it makes the block look free and the attack look
   * answerable — and it is the one place the model is not merely coarse but
   * wrong about a shipped keyword.
   */
  readonly modelsOverwhelm: boolean;
}

/**
 * What Normal and Easy fly: the published heuristic, with nothing added.
 *
 * Every switch is off, so the scoring path taken under this profile is
 * arithmetically the path that shipped before M09.14. That is the whole reason
 * the profile exists as a value rather than as `undefined` — a caller that
 * passes no profile and a caller that passes this one must be the same caller.
 */
export const BASELINE_TACTICS: TacticalProfile = Object.freeze({
  id: 'baseline',
  version: '1.0.0',
  summary:
    'The published heuristic, unchanged. Every tactical refinement off, so Normal and Easy score ' +
    'exactly what they scored before difficulty had a scoring half.',
  readsRemovalLethality: false,
  offersPreservingBlocks: false,
  ownLossAversion: false,
  modelsBarrier: false,
  modelsOverwhelm: false,
});

/**
 * Hard's tactical half (M09.14).
 *
 * Five named corrections, all of them about the decision in front of the pilot
 * *now*: which body removal removes, which body blocks, what a trade costs, and
 * what the two combat keywords in the shipped pool actually do. It carries none
 * of the strategic gaps M05.6 also recorded — sequencing, additional-sacrifice
 * payoff, holding Energy for a window — and M09.15 owns those. A record citing
 * this profile is citing a bot that is better at combat and target choice, and
 * nothing more; it is not evidence about balance, which is the agent-class
 * taxonomy's decision and not this file's.
 */
export const HARD_TACTICAL_TACTICS: TacticalProfile = Object.freeze({
  id: 'hard_tactical',
  version: '1.0.0',
  summary:
    'Tactical corrections for immediate combat and target choice: removal is aimed at what it ' +
    'defeats, a block that loses nothing is on the menu, an even trade is worth nothing, and ' +
    'Barrier and Overwhelm are modelled. No sequencing or resource improvement (M09.15).',
  readsRemovalLethality: true,
  offersPreservingBlocks: true,
  ownLossAversion: true,
  modelsBarrier: true,
  modelsOverwhelm: true,
});

export const TACTICAL_PROFILES: Readonly<Record<TacticalProfileId, TacticalProfile>> =
  Object.freeze({
    baseline: BASELINE_TACTICS,
    hard_tactical: HARD_TACTICAL_TACTICS,
  });

export function tacticalProfile(id: TacticalProfileId): TacticalProfile {
  return TACTICAL_PROFILES[id];
}

/** Every refinement switch, so a check can be total without listing them twice. */
export const TACTICAL_REFINEMENTS = [
  'readsRemovalLethality',
  'offersPreservingBlocks',
  'ownLossAversion',
  'modelsBarrier',
  'modelsOverwhelm',
] as const;
export type TacticalRefinement = (typeof TACTICAL_REFINEMENTS)[number];

/**
 * Runtime twin of the type-level totality check, in the shape
 * `difficultyRegistryGaps()` established: the `Record` type already fails a
 * build that forgets an ID, and this catches the other direction — an entry for
 * an ID the vocabulary no longer has — plus the two invariants the type cannot
 * state. `baseline` must have every refinement off, because everything that
 * calls "Normal is unchanged" true rests on it; and a profile that is not
 * `baseline` must turn at least one on, because a second profile that does
 * nothing is a version number pretending to be a behaviour.
 */
export function tacticalProfileGaps(): string[] {
  const problems: string[] = [];
  const known = new Set<string>(TACTICAL_PROFILE_IDS);

  for (const key of Object.keys(TACTICAL_PROFILES)) {
    if (!known.has(key)) problems.push(`tactical profile "${key}" is defined but not in the list.`);
  }
  for (const id of TACTICAL_PROFILE_IDS) {
    const profile = TACTICAL_PROFILES[id];
    if (profile.id !== id) problems.push(`tactical profile "${id}" is filed under the wrong key.`);
    if (profile.version.trim() === '') problems.push(`tactical profile "${id}" has no version.`);
    if (profile.summary.trim() === '') problems.push(`tactical profile "${id}" has no summary.`);

    const on = TACTICAL_REFINEMENTS.filter((refinement) => profile[refinement]);
    if (id === 'baseline' && on.length > 0) {
      problems.push(`the baseline profile turns on ${on.join(', ')}; it must turn on nothing.`);
    }
    if (id !== 'baseline' && on.length === 0) {
      problems.push(`tactical profile "${id}" turns on no refinement, so it is baseline renamed.`);
    }
  }
  return problems;
}

export function assertTacticalProfilesComplete(): void {
  const problems = tacticalProfileGaps();
  if (problems.length > 0) {
    throw new Error(`The tactical profile registry is out of date:\n- ${problems.join('\n- ')}`);
  }
}
