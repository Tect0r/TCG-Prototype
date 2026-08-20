import type { CardDatabase, CardDefinition } from '@tcg/card-data';
import type {
  BlockAssignment,
  CardInstanceView,
  LegalActions,
  PendingChoice,
  PlayerView,
} from '@tcg/rules-engine';
import type { ActionCandidate, BotObservation } from './types.js';
import { BASELINE_TACTICS, type TacticalProfile } from './tactics.js';
import {
  boardValueOf,
  cardValue,
  damageRemovalFraction,
  greedyBlocks,
  opponentPriority,
  opponentSummaries,
  remainingHealthOf,
  selfSummary,
  summaryOf,
  unitBoardValue,
  unitViewsOf,
  type BotWeights,
  type CombatModel,
} from './scoring.js';

/**
 * Turns the engine's structured legality description into a bounded, ordered
 * list of concrete candidate actions.
 *
 * Two of the families are combinatorially explosive — every assignment of
 * attackers to defenders, every pairing of blockers to attackers — so they are
 * enumerated as a small set of named *strategies* rather than exhaustively. Each
 * strategy is a plan a human would recognise ("all in on the weakest player",
 * "block only where I come out ahead"), so a pilot's choice stays inspectable.
 *
 * Candidate order is fully determined by the observation, never by object key
 * iteration order, so two runs enumerate identically.
 */

export interface CandidateOptions {
  readonly weights: BotWeights;
  /** Enabled only by experiment policy; a pilot never concedes on its own. */
  readonly mayConcede: boolean;
  /**
   * The tactical half of the difficulty flying this pilot (M09.14).
   *
   * Defaults to `BASELINE_TACTICS`, so a caller that passes none enumerates
   * exactly the list that shipped. A profile can only ever *widen* this list
   * with a plan the engine has already declared legal; it cannot remove one, and
   * it cannot invent an action.
   */
  readonly tactics?: TacticalProfile;
}

/** What a profile asks the combat model to reproduce. */
export function combatModelOf(tactics: TacticalProfile): CombatModel {
  return { barrier: tactics.modelsBarrier, overwhelm: tactics.modelsOverwhelm };
}

const byKey = (a: ActionCandidate, b: ActionCandidate): number => a.key.localeCompare(b.key);

export function candidateActions(
  observation: BotObservation,
  options: CandidateOptions,
): ActionCandidate[] {
  const { legal } = observation;

  if (legal.pendingChoice) return choiceCandidates(observation, legal.pendingChoice, options);
  if (legal.mulligan) return mulliganCandidates(observation);
  // A Reaction window pre-empts everything else, exactly as it does in the
  // engine: while one is open the only legal moves are answering it or handing
  // priority back (rule adjustment §5).
  if (legal.reaction) return reactionCandidates(observation);
  if (legal.blocking) return blockCandidates(observation, options);
  if (legal.attacking) return attackCandidates(observation, options);

  const candidates: ActionCandidate[] = [];
  const playerId = legal.playerId;

  for (const card of legal.playableCards) {
    candidates.push({
      // No slot to choose: the battlefield is unbounded and a unit simply joins
      // the controller's list (ruleset update §7).
      action: { type: 'play_card', playerId, instanceId: card.instanceId },
      family: 'play_card',
      key: `play:${card.definitionId}:${card.instanceId}`,
    });
  }

  for (const ability of legal.activatableAbilities) {
    candidates.push({
      action: {
        type: 'activate_ability',
        playerId,
        sourceInstanceId: ability.sourceInstanceId,
        abilityId: ability.abilityId,
      },
      family: 'activate_ability',
      key: `activate:${ability.sourceInstanceId}:${ability.abilityId}`,
    });
  }

  if (legal.canPassPhase) {
    candidates.push({
      action: { type: 'pass_phase', playerId },
      family: 'pass_phase',
      key: 'pass',
    });
  }

  if (options.mayConcede && legal.canConcede && candidates.length === 0) {
    candidates.push({ action: { type: 'concede', playerId }, family: 'concede', key: 'concede' });
  }

  return candidates.sort(byKey);
}

/* ------------------------------------------------------------- reactions */

/**
 * Answering an open Reaction window.
 *
 * Passing is always offered, and offered *first*, because it is the only answer
 * that is legal in every window and the only one that can close one. A pilot
 * that could never decline would hold a window open until it ran out of cards.
 *
 * Each playable Reaction is one candidate. There is nothing to enumerate beyond
 * that: the engine has already applied the timing window, the subject filter and
 * the per-turn discount, so every entry here is a move the engine will accept.
 */
function reactionCandidates(observation: BotObservation): ActionCandidate[] {
  const reaction = observation.legal.reaction;
  if (!reaction) return [];
  const playerId = observation.legal.playerId;

  const candidates: ActionCandidate[] = [
    { action: { type: 'pass_reaction', playerId }, family: 'pass_reaction', key: 'reaction:pass' },
  ];

  for (const card of reaction.playableCards) {
    candidates.push({
      action: { type: 'play_reaction', playerId, instanceId: card.instanceId },
      family: 'play_reaction',
      key: `reaction:play:${card.definitionId}:${card.instanceId}`,
    });
  }
  return candidates.sort(byKey);
}

/* ------------------------------------------------------------- mulligan */

/**
 * Keep, or return the `k` most expensive cards for `k` up to the whole hand.
 *
 * The redraw is random, so there is nothing to gain from enumerating arbitrary
 * subsets: what a pilot is really deciding is *how many* cards it is unhappy
 * with, and the cards it is unhappy with are the ones it cannot cast early.
 */
function mulliganCandidates(observation: BotObservation): ActionCandidate[] {
  const mulligan = observation.legal.mulligan;
  if (!mulligan) return [];
  const playerId = observation.legal.playerId;

  const ordered = [...mulligan.handInstanceIds].sort((left, right) => {
    const a = definitionFor(observation, left);
    const b = definitionFor(observation, right);
    const costDelta = (b?.cost ?? 0) - (a?.cost ?? 0);
    if (costDelta !== 0) return costDelta;
    return left.localeCompare(right);
  });

  const candidates: ActionCandidate[] = [];
  for (let count = 0; count <= Math.min(mulligan.maxReturn, ordered.length); count += 1) {
    candidates.push({
      action: { type: 'mulligan', playerId, returnInstanceIds: ordered.slice(0, count) },
      family: 'mulligan',
      key: `mulligan:return_${String(count).padStart(2, '0')}`,
    });
  }
  return candidates;
}

/* --------------------------------------------------------------- attacks */

/**
 * Named attack strategies. Bounded by `2 × opponents + 2`, and every one of them
 * is a plan rather than an arbitrary subset.
 */
function attackCandidates(
  observation: BotObservation,
  options: CandidateOptions,
): ActionCandidate[] {
  const attacking = observation.legal.attacking;
  if (!attacking) return [];
  const playerId = observation.legal.playerId;
  const { view, database } = observation;
  const { weights } = options;

  const candidates: ActionCandidate[] = [
    {
      action: { type: 'declare_attackers', playerId, attacks: [] },
      family: 'declare_attackers',
      key: 'attack:none',
    },
  ];

  const attackers = attacking.legalAttackers
    .map((id) => view.instances[id])
    .filter((unit): unit is CardInstanceView => unit !== undefined);
  if (attackers.length === 0) return candidates;

  const defenders = [...attacking.legalDefenders].sort((a, b) => a.localeCompare(b));

  for (const defenderPlayerId of defenders) {
    candidates.push({
      action: {
        type: 'declare_attackers',
        playerId,
        attacks: attackers.map((unit) => ({
          attackerInstanceId: unit.instanceId,
          defenderPlayerId,
        })),
      },
      family: 'declare_attackers',
      key: `attack:all:${defenderPlayerId}`,
    });

    // Only the attackers no ready blocker on that seat can profitably answer.
    const blockers = readyBlockersOf(view, defenderPlayerId);
    const safe = attackers.filter((attacker) => {
      if (attacker.keywords.includes('evasive')) return true;
      return !blockers.some(
        (blocker) =>
          blocker.attack >= remainingHealthOf(attacker) || blocker.keywords.includes('venom'),
      );
    });
    if (safe.length > 0 && safe.length < attackers.length) {
      candidates.push({
        action: {
          type: 'declare_attackers',
          playerId,
          attacks: safe.map((unit) => ({ attackerInstanceId: unit.instanceId, defenderPlayerId })),
        },
        family: 'declare_attackers',
        key: `attack:safe:${defenderPlayerId}`,
      });
    }
  }

  // A spread: every attacker independently points at the seat this pilot's
  // focus weights find most attractive. With two seats it collapses onto
  // `attack:all`, which the scorer then de-duplicates by score.
  if (defenders.length > 1) {
    const priorities = new Map(
      opponentSummaries(view)
        .filter((summary) => defenders.includes(summary.playerId))
        .map(
          (summary) =>
            [summary.playerId, opponentPriority(view, summary, weights, database)] as const,
        ),
    );
    const best = [...priorities.entries()].sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    })[0];
    if (best) {
      candidates.push({
        action: {
          type: 'declare_attackers',
          playerId,
          attacks: attackers.map((unit) => ({
            attackerInstanceId: unit.instanceId,
            defenderPlayerId: best[0],
          })),
        },
        family: 'declare_attackers',
        key: `attack:focus:${best[0]}`,
      });
    }
  }

  return dedupe(candidates).sort(byKey);
}

/** Units a seat could still put in front of an attacker. */
function readyBlockersOf(view: PlayerView, playerId: string): CardInstanceView[] {
  return unitViewsOf(view, playerId);
}

/* ---------------------------------------------------------------- blocks */

/**
 * Tops a block plan up until it satisfies the Guardian obligation.
 *
 * Guardian is compulsory: a defender controlling ready Guardians must block at
 * least `mustBlockCount` attackers (ruleset update §9). A pilot is free to
 * choose *which* attackers those are, but "block nothing" simply is not a legal
 * action while a ready Guardian is on the board, so every plan a pilot proposes
 * has to be repaired rather than offered and rejected.
 *
 * Deterministic by construction: unblocked attackers and spare Guardians are
 * both consumed in the order the engine listed them.
 */
export function satisfyGuardianObligation(
  blocking: NonNullable<LegalActions['blocking']>,
  blocks: readonly BlockAssignment[],
): BlockAssignment[] {
  const result: BlockAssignment[] = [...blocks];
  const blockedAttackers = new Set(result.map((block) => block.attackerInstanceId));
  if (blockedAttackers.size >= blocking.mustBlockCount) return result;

  const usedBlockers = new Set(result.map((block) => block.blockerInstanceId));
  const spareGuardians = blocking.guardianInstanceIds.filter((id) => !usedBlockers.has(id));
  const openAttackers = blocking.attackerInstanceIds.filter((id) => !blockedAttackers.has(id));

  for (const attackerInstanceId of openAttackers) {
    if (blockedAttackers.size >= blocking.mustBlockCount) break;
    const blockerInstanceId = spareGuardians.shift();
    if (blockerInstanceId === undefined) break;
    result.push({ attackerInstanceId, blockerInstanceId });
    blockedAttackers.add(attackerInstanceId);
  }
  return result;
}

/**
 * Named blocking strategies: nothing, value-only, everything, and — under a
 * tactical profile that asks for it — the block that keeps the blocker.
 */
function blockCandidates(
  observation: BotObservation,
  options: CandidateOptions,
): ActionCandidate[] {
  const blocking = observation.legal.blocking;
  if (!blocking) return [];
  const playerId = observation.legal.playerId;
  const { view } = observation;
  const tactics = options.tactics ?? BASELINE_TACTICS;
  const model = combatModelOf(tactics);

  // "Block nothing" is only on the table when no ready Guardian obliges a
  // block; otherwise the minimum legal plan is the Guardian obligation itself.
  const candidates: ActionCandidate[] = [
    {
      action: {
        type: 'assign_blockers',
        playerId,
        blocks: satisfyGuardianObligation(blocking, []),
      },
      family: 'assign_blockers',
      key: blocking.mustBlockCount > 0 ? 'block:guardian_minimum' : 'block:none',
    },
  ];

  const attackers = blocking.attackerInstanceIds
    .map((id) => view.instances[id])
    .filter((unit): unit is CardInstanceView => unit !== undefined);
  const blockers = blocking.blockerInstanceIds
    .map((id) => view.instances[id])
    .filter((unit): unit is CardInstanceView => unit !== undefined);
  if (attackers.length === 0 || blockers.length === 0) return candidates;

  const plans: { key: string; chumpBlock: boolean; valueOnly: boolean; preserve?: boolean }[] = [
    { key: 'block:value', chumpBlock: false, valueOnly: true },
    { key: 'block:all', chumpBlock: true, valueOnly: false },
  ];
  // One extra named plan rather than a change to the three that were already
  // here: `block:value` still means what it meant, and a build with the
  // refinement off enumerates an identical list (M09.14).
  if (tactics.offersPreservingBlocks) {
    plans.push({ key: 'block:preserve', chumpBlock: false, valueOnly: true, preserve: true });
  }

  for (const plan of plans) {
    const blocks = greedyBlocks(attackers, blockers, {
      chumpBlock: plan.chumpBlock,
      valueOnly: plan.valueOnly,
      ...(plan.preserve === undefined ? {} : { preserve: plan.preserve }),
      model,
    });
    if (blocks.length === 0) continue;
    candidates.push({
      action: {
        type: 'assign_blockers',
        playerId,
        blocks: satisfyGuardianObligation(blocking, blocks),
      },
      family: 'assign_blockers',
      key: plan.key,
    });
  }

  return dedupe(candidates).sort(byKey);
}

/* --------------------------------------------------------------- choices */

/**
 * A pending choice resolves to a single considered selection per "direction".
 *
 * Unlike attacks and blocks there is a defensible best answer once the pilot
 * knows whether the selection is good for it (a search, a target for removal) or
 * bad for it (a discard, a sacrifice), so the enumerator emits the best and the
 * worst selection and lets the scorer decide which the situation calls for. That
 * keeps every choice reason on the same scored path as every other decision.
 */
function choiceCandidates(
  observation: BotObservation,
  choice: PendingChoice,
  options: CandidateOptions,
): ActionCandidate[] {
  const playerId = observation.legal.playerId;
  const ranked = rankChoiceOptions(observation, choice, options.weights, options.tactics);

  if (choice.type === 'divide_damage') {
    return divideDamageCandidates(observation, choice, ranked);
  }

  if (choice.ordered) {
    return [
      {
        action: {
          type: 'submit_choice',
          playerId,
          choiceId: choice.id,
          selectedIds: ranked.map((entry) => entry.id),
        },
        family: 'submit_choice',
        key: 'choice:order_best_first',
      },
      {
        action: {
          type: 'submit_choice',
          playerId,
          choiceId: choice.id,
          selectedIds: [...ranked].reverse().map((entry) => entry.id),
        },
        family: 'submit_choice',
        key: 'choice:order_worst_first',
      },
    ];
  }

  const available = ranked.length;
  const minimum = Math.min(choice.minimum, available);
  const maximum = Math.min(choice.maximum, available);
  const sizes = new Set<number>([minimum, maximum]);

  const candidates: ActionCandidate[] = [];
  for (const size of [...sizes].sort((a, b) => a - b)) {
    const best = ranked.slice(0, size).map((entry) => entry.id);
    const worst = [...ranked]
      .reverse()
      .slice(0, size)
      .map((entry) => entry.id);
    candidates.push({
      action: { type: 'submit_choice', playerId, choiceId: choice.id, selectedIds: best },
      family: 'submit_choice',
      key: `choice:best_${size}`,
    });
    if (size > 0 && best.join() !== worst.join()) {
      candidates.push({
        action: { type: 'submit_choice', playerId, choiceId: choice.id, selectedIds: worst },
        family: 'submit_choice',
        key: `choice:worst_${size}`,
      });
    }
  }

  return dedupe(candidates).sort(byKey);
}

/**
 * Splitting a fixed total of damage across targets (M02.5).
 *
 * Its own enumerator because the answer is a multiset — one entry per point —
 * and the generic path builds sets of distinct options, which for a total larger
 * than the option count would produce an answer the engine rejects outright.
 *
 * Three plans, each one a human would recognise, and no attempt to search the
 * space: pile it all on the best target, spread it evenly, or spend just enough
 * on each target to defeat it and dump the remainder on the best one. The scorer
 * decides between them on the same summed-value basis as every other choice, so
 * a repeated target genuinely counts twice.
 */
function divideDamageCandidates(
  observation: BotObservation,
  choice: PendingChoice,
  ranked: readonly RankedOption[],
): ActionCandidate[] {
  const playerId = observation.legal.playerId;
  // Minimum and maximum are the same number on this choice type: the total.
  const total = choice.minimum;
  const options = ranked.map((entry) => entry.id);
  if (total <= 0 || options.length === 0) return [];

  const submit = (selectedIds: string[], key: string): ActionCandidate => ({
    action: { type: 'submit_choice', playerId, choiceId: choice.id, selectedIds },
    family: 'submit_choice',
    key,
  });

  const best = options[0] as string;
  const concentrated = Array.from({ length: total }, () => best);

  const spread = Array.from(
    { length: total },
    (_, index) => options[index % options.length] as string,
  );

  // "Just enough to kill it, then the rest where it counts most." A target whose
  // remaining health is unknown — anything not on the battlefield — is treated
  // as needing one point, which is the only non-guessing assumption available.
  const lethal: string[] = [];
  for (const id of options) {
    if (lethal.length >= total) break;
    const unit = observation.view.instances[id];
    const needed = unit ? Math.max(1, unit.health - unit.markedDamage) : 1;
    if (lethal.length + needed > total) continue;
    for (let i = 0; i < needed; i += 1) lethal.push(id);
  }
  while (lethal.length < total) lethal.push(best);

  return dedupe([
    submit(concentrated, 'divide:concentrate'),
    submit(spread, 'divide:spread'),
    submit(lethal, 'divide:finish_off'),
  ]).sort(byKey);
}

export interface RankedOption {
  readonly id: string;
  /** Value *to this pilot* of the entity, whoever controls it. */
  readonly value: number;
  /** True when the entity belongs to another seat. */
  readonly enemy: boolean;
}

/**
 * The card an instance ID names, when the seat has actually been shown it.
 *
 * Two sources, and neither of them is a disclosure. A permanent on a battlefield,
 * a relic, a Commander or a card in the viewer's own hand is already in
 * `view.instances`. A **Spell in the middle of resolving** is in neither the
 * battlefield nor anybody's hand array, so it is not in `view.instances` at all —
 * but playing a card is public, and `card_played` is an unredacted event in the
 * seat's own log carrying the definition. Reading it back tells the pilot exactly
 * what every seat at the table watched happen.
 *
 * `null` when neither source has it, which is the honest answer for a card this
 * seat has never been shown. `PendingChoice.provenance` deliberately carries no
 * card identity (M05.3) and nothing here reintroduces one: this resolves an
 * instance the viewer can already see, and returns nothing for one it cannot.
 */
function shownDefinitionOf(
  observation: BotObservation,
  instanceId: string,
): CardDefinition | undefined {
  const instance = observation.view.instances[instanceId];
  if (instance) return observation.database.get(instance.definitionId);

  for (let index = observation.history.length - 1; index >= 0; index -= 1) {
    const event = observation.history[index];
    if (event?.type === 'card_played' && event.instanceId === instanceId) {
      return observation.database.get(event.definitionId);
    }
  }
  return undefined;
}

/**
 * How much damage the instruction that asked this question is about to deal, or
 * `null` when the pilot cannot read it off a card it has been shown (M09.14).
 *
 * The provenance names the asking instruction and its index, `sourceInstanceId`
 * names the instance, and the definition behind that instance is the same
 * authored card data every valuation in this package already reads. Nothing here
 * reaches for a `MatchState`.
 *
 * Deliberately narrow, and the narrowness is the honesty:
 *
 * - only an `instruction` origin, because nothing else has an effect index;
 * - only when `effects[effectIndex]` is itself a `deal_damage`, because the
 *   index is into "the list it was printed in" and a card's abilities are other
 *   lists — a mismatch reads as "cannot tell" instead of as another number;
 * - only a **printed** amount, because a derived one ("damage equal to its ATK")
 *   is a board question this function is not entitled to answer;
 * - never a `divided` total, which is an allocation `divideDamageCandidates`
 *   already enumerates and not a per-target amount.
 */
function choiceDamageAmount(observation: BotObservation, choice: PendingChoice): number | null {
  const { provenance, sourceInstanceId } = choice;
  if (provenance.origin !== 'instruction') return null;
  if (provenance.effectType !== 'deal_damage') return null;
  if (provenance.effectIndex === null || sourceInstanceId === null) return null;

  const definition = shownDefinitionOf(observation, sourceInstanceId);
  const effect = definition?.effects[provenance.effectIndex];
  if (!effect || effect.type !== 'deal_damage' || effect.divided === true) return null;
  return typeof effect.amount === 'number' ? effect.amount : null;
}

/**
 * Values every option of a pending choice, best first.
 *
 * Options can be card instances, unit instances or players. Anything
 * unrecognised is valued at zero and ordered by ID, which keeps an unfamiliar
 * choice type deterministic instead of throwing.
 *
 * Under a profile that reads removal lethality, a battlefield unit being asked
 * about by a damage instruction is worth the fraction of it that damage actually
 * removes — which is the whole of it when the damage defeats it, and none of it
 * when an unspent Barrier eats the event. Every other option type, and every
 * other question, is valued exactly as before.
 */
export function rankChoiceOptions(
  observation: BotObservation,
  choice: PendingChoice,
  weights: BotWeights,
  tactics: TacticalProfile = BASELINE_TACTICS,
): RankedOption[] {
  const { view, database } = observation;
  const viewerId = view.viewerId;
  const damage = tactics.readsRemovalLethality ? choiceDamageAmount(observation, choice) : null;
  const model = combatModelOf(tactics);

  /** A seat option, valued the way `select_players` values one. */
  const rankSeat = (id: string): RankedOption | null => {
    const summary = summaryOf(view, id);
    if (!summary) return null;
    const enemy = summary.playerId !== viewerId;
    return {
      id,
      value: enemy ? opponentPriority(view, summary, weights, database) : -summary.health,
      enemy,
    };
  };

  const scored = choice.validEntityIds.map((id): RankedOption => {
    if (choice.type === 'select_players') {
      return rankSeat(id) ?? { id, value: 0, enemy: true };
    }

    const instance = view.instances[id];
    if (!instance) {
      // A `divide_damage` pool may hold seats as well as instances — "divide it
      // among enemy Units and opponents" (M07.8). Valued as a seat rather than
      // left at the unrecognised-option zero, which would have ranked hitting a
      // player below every unit on the board and marked it friendly.
      const seat = rankSeat(id);
      if (seat) return seat;
      const definition = database.get(id);
      if (definition) return { id, value: cardValue(definition, weights, database), enemy: false };
      return { id, value: 0, enemy: false };
    }

    const enemy = instance.controller !== viewerId;
    const value =
      instance.zone === 'battlefield'
        ? unitBoardValue(instance, weights, database) *
          (damage === null ? 1 : damageRemovalFraction(instance, damage, model))
        : (() => {
            const definition = database.get(instance.definitionId);
            return definition ? cardValue(definition, weights, database) : 0;
          })();
    return { id, value, enemy };
  });

  return scored.sort((a, b) => {
    if (b.value !== a.value) return b.value - a.value;
    return a.id.localeCompare(b.id);
  });
}

/* ----------------------------------------------------------------- shared */

export function definitionFor(
  observation: BotObservation,
  instanceId: string,
): CardDefinition | undefined {
  const instance = observation.view.instances[instanceId];
  if (!instance) return undefined;
  return observation.database.get(instance.definitionId);
}

/** Board strength of the pilot's own seat, used by several scorers. */
export function ownBoard(
  observation: BotObservation,
  weights: BotWeights,
  database: CardDatabase,
): number {
  return boardValueOf(observation.view, selfSummary(observation.view).playerId, weights, database);
}

function dedupe(candidates: readonly ActionCandidate[]): ActionCandidate[] {
  const seen = new Set<string>();
  const out: ActionCandidate[] = [];
  for (const candidate of candidates) {
    const fingerprint = JSON.stringify(candidate.action);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    out.push(candidate);
  }
  return out;
}
