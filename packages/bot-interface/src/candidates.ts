import type { CardDatabase, CardDefinition } from '@tcg/card-data';
import type { CardInstanceView, PendingChoice, PlayerView } from '@tcg/rules-engine';
import type { ActionCandidate, BotObservation } from './types.js';
import {
  boardValueOf,
  cardValue,
  greedyBlocks,
  opponentPriority,
  opponentSummaries,
  remainingHealthOf,
  selfSummary,
  summaryOf,
  unitBoardValue,
  unitViewsOf,
  type BotWeights,
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
}

const byKey = (a: ActionCandidate, b: ActionCandidate): number => a.key.localeCompare(b.key);

export function candidateActions(
  observation: BotObservation,
  options: CandidateOptions,
): ActionCandidate[] {
  const { legal } = observation;

  if (legal.pendingChoice) return choiceCandidates(observation, legal.pendingChoice, options);
  if (legal.mulligan) return mulliganCandidates(observation);
  if (legal.blocking) return blockCandidates(observation);
  if (legal.attacking) return attackCandidates(observation, options);

  const candidates: ActionCandidate[] = [];
  const playerId = legal.playerId;

  for (const card of legal.playableCards) {
    candidates.push({
      action: {
        type: 'play_card',
        playerId,
        instanceId: card.instanceId,
        // Unit slots carry no positional rules in the current ruleset, so the
        // lowest free slot is a complete and deterministic slot selection.
        slot: card.freeSlots[0] ?? null,
      },
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

/** Named blocking strategies: nothing, value-only, everything, and chump-to-survive. */
function blockCandidates(observation: BotObservation): ActionCandidate[] {
  const blocking = observation.legal.blocking;
  if (!blocking) return [];
  const playerId = observation.legal.playerId;
  const { view } = observation;

  const candidates: ActionCandidate[] = [
    {
      action: { type: 'assign_blockers', playerId, blocks: [] },
      family: 'assign_blockers',
      key: 'block:none',
    },
  ];

  const attackers = blocking.attackerInstanceIds
    .map((id) => view.instances[id])
    .filter((unit): unit is CardInstanceView => unit !== undefined);
  const blockers = blocking.blockerInstanceIds
    .map((id) => view.instances[id])
    .filter((unit): unit is CardInstanceView => unit !== undefined);
  if (attackers.length === 0 || blockers.length === 0) return candidates;

  const plans: { key: string; chumpBlock: boolean; valueOnly: boolean }[] = [
    { key: 'block:value', chumpBlock: false, valueOnly: true },
    { key: 'block:all', chumpBlock: true, valueOnly: false },
  ];

  for (const plan of plans) {
    const blocks = greedyBlocks(attackers, blockers, {
      chumpBlock: plan.chumpBlock,
      valueOnly: plan.valueOnly,
    });
    if (blocks.length === 0) continue;
    candidates.push({
      action: { type: 'assign_blockers', playerId, blocks },
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
  const ranked = rankChoiceOptions(observation, choice, options.weights);

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

export interface RankedOption {
  readonly id: string;
  /** Value *to this pilot* of the entity, whoever controls it. */
  readonly value: number;
  /** True when the entity belongs to another seat. */
  readonly enemy: boolean;
}

/**
 * Values every option of a pending choice, best first.
 *
 * Options can be card instances, unit instances, players or — for reasons the
 * engine does not currently raise — slot indices. Anything unrecognised is
 * valued at zero and ordered by ID, which keeps an unfamiliar choice type
 * deterministic instead of throwing.
 */
export function rankChoiceOptions(
  observation: BotObservation,
  choice: PendingChoice,
  weights: BotWeights,
): RankedOption[] {
  const { view, database } = observation;
  const viewerId = view.viewerId;

  const scored = choice.validEntityIds.map((id): RankedOption => {
    if (choice.type === 'select_players') {
      const summary = summaryOf(view, id);
      if (!summary) return { id, value: 0, enemy: true };
      const enemy = summary.playerId !== viewerId;
      return {
        id,
        value: enemy ? opponentPriority(view, summary, weights, database) : -summary.health,
        enemy,
      };
    }

    const instance = view.instances[id];
    if (!instance) {
      const definition = database.get(id);
      if (definition) return { id, value: cardValue(definition, weights, database), enemy: false };
      return { id, value: 0, enemy: false };
    }

    const enemy = instance.controller !== viewerId;
    const value =
      instance.zone === 'battlefield'
        ? unitBoardValue(instance, weights, database)
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
