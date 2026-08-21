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
 * **Hard is not published by this file**, and was not published by the tranche
 * that finished its behaviour. `hard_tactical` carried only the tactical half in
 * M09.14; M09.15 added the two short-horizon refinements — `sequencesEnablers`
 * and `reservesReactionEnergy`; M09.20 added `pricesCardsInHand` and closed the
 * last strategic gap. Publication is a decision made in `@tcg/bot-config`, whose
 * `DIFFICULTY_REGISTRY.hard` names this profile as of M09.20: what a profile
 * does and whether a difficulty ships stay two questions, and this file only
 * ever answers the first.
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
  /**
   * Leads with the play that improves the play it is about to make anyway.
   *
   * Closes the M05.6 finding "sequencing is ignored": `scorePlayCard` prices
   * each card on its own, so a Relic whose whole job is to improve the next Unit
   * deployed is worth its own small board presence and nothing else — and a
   * pilot with exactly enough Energy for both deploys the Unit first and the
   * Relic into an empty turn.
   *
   * A **depth-two** examination of the plays the engine has already declared
   * legal, and nothing deeper: for each pair of playable cards it asks whether
   * one of them, once in play, would improve the arrival of the other, and
   * whether the other is still affordable once the first is paid for. Both
   * halves are required. An enabler that leaves nothing to enable it for is not
   * a lead, it is a wasted turn.
   *
   * The correction is deliberately **bounded above**: the enabler is raised to
   * the beneficiary's own score plus what it adds to it, and never higher. So a
   * pair cannot climb over a candidate that already beat the beneficiary — where
   * that candidate wins, it still wins — and where the beneficiary would have
   * been played, the enabler goes first and the beneficiary follows. What is
   * being corrected is the *order* of two plays that both happen, which is what
   * makes the ceiling the right shape rather than a tuned number.
   */
  readonly sequencesEnablers: boolean;
  /**
   * Does not spend the Energy a Reaction it is holding would need.
   *
   * Closes the M05.6 finding "Energy is never held for a window": the only thing
   * pulling Energy out of a pilot is `unspentEnergyPenalty` on `pass_phase`, and
   * it is charged on every point of it — including the points that are the whole
   * reason the seat is holding a counter. Energy carries until a seat's own next
   * turn, and the rulebook says so in as many words: whatever is unspent "is what
   * pays for a Reaction on another player's turn".
   *
   * Two arithmetic changes, both narrow. The reserved points stop being charged
   * the unspent-Energy penalty, because they are not idle; and a play that would
   * take the seat below the reserve is charged the Reaction it strands.
   *
   * A reserve is only ever raised for a Reaction the pilot **actually holds**,
   * that it can **already afford**, and whose named window a living opponent
   * could still open — a spell window needs an opponent with cards in hand, a
   * combat window needs one with a body that could attack. A deck full of
   * Reactions with none in hand reserves nothing, a Reaction that is unaffordable
   * anyway reserves nothing, and no fixed number of points is ever held back.
   */
  readonly reservesReactionEnergy: boolean;
  /**
   * Prices the card a play gives up out of its own hand.
   *
   * Closes the last of the three strategic gaps M05.6 recorded and M09.15 left
   * open, `containment_control/hold_energy_for_the_counter`. M09.15 made the
   * Energy a held Reaction needs stop being idle, and the body still won,
   * because the scorer prices a card played at its whole value and a card kept
   * in hand at nothing — so holding for a window that has not opened can never
   * win against playing something. It is a valuation defect in *every* decision
   * the pilot makes, not a resource rule, and this is where it is corrected.
   *
   * With this on, a play is charged `heldCardValue` — a uniform share of what
   * the card would still have been worth in hand. What is corrected is the
   * reading of a body as a permanent gain rather than as one turn of tempo over
   * playing the same card next turn.
   *
   * Charged inside the play's own base score, so the pair search sees the same
   * price the scorer does and a sequence cannot be valued against a card the
   * scorer priced differently.
   *
   * **What it costs is measured, and it is not free.** `hard_tactical` `1.1.0`
   * beat the baseline head to head; with this on, that advantage is gone. The
   * refinement buys the last named calibration gap and pays for it in match
   * strength, which is a product trade the M09.20 record states in full and
   * hands to the owner rather than tuning away.
   */
  readonly pricesCardsInHand: boolean;
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
  sequencesEnablers: false,
  reservesReactionEnergy: false,
  pricesCardsInHand: false,
});

/**
 * Hard's tactical half (M09.14).
 *
 * Five named corrections in M09.14, all of them about the decision in front of
 * the pilot *now*: which body removal removes, which body blocks, what a trade
 * costs, and what the two combat keywords in the shipped pool actually do.
 * M09.15 added the two short-horizon ones and M09.20 the last strategic one, so
 * the profile now answers every board in the calibration suite for every style.
 *
 * That last sentence is a statement about the **instrument**, not about the
 * player. Twenty-four hand-authored boards are twenty-four decisions somebody
 * thought to write down; a profile that answers all of them has stopped being
 * measured by them, which is a reason to widen the suite in a later tranche
 * rather than a claim that play is solved. A record citing this profile is
 * citing a bot that is better at combat, target choice, sequencing and
 * patience, and nothing more; it is not evidence about balance, which is the
 * agent-class taxonomy's decision and not this file's.
 */
export const HARD_TACTICAL_TACTICS: TacticalProfile = Object.freeze({
  id: 'hard_tactical',
  version: '1.2.0',
  summary:
    'Tactical corrections for immediate combat and target choice: removal is aimed at what it ' +
    'defeats, a block that loses nothing is on the menu, an even trade is worth nothing, and ' +
    'Barrier and Overwhelm are modelled. Plus two short-horizon corrections (M09.15): the play ' +
    'that improves the next play leads, and the Energy a held Reaction needs is not spent. Plus ' +
    'the card a play gives up out of its own hand (M09.20), so a body is one turn of tempo ' +
    'rather than a permanent gain.',
  readsRemovalLethality: true,
  offersPreservingBlocks: true,
  ownLossAversion: true,
  modelsBarrier: true,
  modelsOverwhelm: true,
  sequencesEnablers: true,
  reservesReactionEnergy: true,
  pricesCardsInHand: true,
});

export const TACTICAL_PROFILES: Readonly<Record<TacticalProfileId, TacticalProfile>> =
  Object.freeze({
    baseline: BASELINE_TACTICS,
    hard_tactical: HARD_TACTICAL_TACTICS,
  });

export function tacticalProfile(id: TacticalProfileId): TacticalProfile {
  return TACTICAL_PROFILES[id];
}

/**
 * The profile a difficulty names, resolved from a plain string (M09.20).
 *
 * `DifficultyDefinition.tactics` is a `string` because `@tcg/bot-config` sits
 * *below* this package and cannot import the union — the same arrangement
 * `BotStyleDefinition.pilotId` has. This is the one place that string becomes a
 * profile, and it parses rather than indexes: an ID this build does not have is
 * a named refusal, because the alternative is a bot that quietly flies the
 * baseline while a lobby, a seat label and a match record all say it did not.
 */
export function resolveTacticalProfile(id: string): TacticalProfile {
  const parsed = tacticalProfileIdSchema.safeParse(id);
  if (!parsed.success) {
    throw new Error(
      `Tactical profile "${id}" is not one this build has: ${TACTICAL_PROFILE_IDS.join(', ')}.`,
    );
  }
  return TACTICAL_PROFILES[parsed.data];
}

/** Every refinement switch, so a check can be total without listing them twice. */
export const TACTICAL_REFINEMENTS = [
  'readsRemovalLethality',
  'offersPreservingBlocks',
  'ownLossAversion',
  'modelsBarrier',
  'modelsOverwhelm',
  'sequencesEnablers',
  'reservesReactionEnergy',
  'pricesCardsInHand',
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
