import { z } from 'zod';
import { nextInt, type Action, type RngState } from '@tcg/rules-engine';
import type { BotDecision, BotObservation, BotPolicy, DecisionFamily } from './types.js';
import { satisfyGuardianObligation } from './candidates.js';

/**
 * The baseline pilot: a uniform (or explicitly weighted) draw from the legal
 * action families.
 *
 * This is a control, not a player. Its job is to exercise every decision surface
 * the engine can present and to give every other pilot something unarguable to
 * be measured against — not to play well (CLAUDE.md §13.3).
 *
 * Determinism comes from two places: the legal options are always sorted into a
 * stable order before anything is drawn, and every draw uses the seat's own
 * generator stream. Nothing here depends on object key iteration order.
 */

export const randomLegalConfigSchema = z.strictObject({
  /**
   * Relative weight per decision family. A family with weight 0 is only chosen
   * when it is the sole legal family. Weights let an experiment bias the control
   * toward, say, attacking, without making it a heuristic pilot.
   */
  familyWeights: z.record(z.string(), z.number().min(0)).default({}),
  /** Probability, in [0, 1], of returning cards at the mulligan. */
  mulliganRedrawChance: z.number().min(0).max(1).default(0.3),
  /** Whether the pilot may concede. Off unless an experiment turns it on. */
  mayConcede: z.boolean().default(false),
});
export type RandomLegalConfig = z.infer<typeof randomLegalConfigSchema>;
export type RandomLegalConfigInput = z.input<typeof randomLegalConfigSchema>;

export const RANDOM_LEGAL_VERSION = '1.0.0';

export function createRandomLegalPilot(input: RandomLegalConfigInput = {}): BotPolicy {
  const config = randomLegalConfigSchema.parse(input);

  return {
    id: 'random_legal',
    version: RANDOM_LEGAL_VERSION,
    config: Object.freeze({ ...config, familyWeights: { ...config.familyWeights } }),
    decide(observation: BotObservation, rng: RngState): BotDecision {
      const { legal } = observation;
      const playerId = legal.playerId;
      let state = rng;

      const pick = <T>(items: readonly T[]): T => {
        const roll = nextInt(state, items.length);
        state = roll.state;
        return items[roll.value] as T;
      };

      const finish = (action: Action, family: DecisionFamily, key: string): BotDecision => ({
        action,
        rng: state,
        diagnostics: {
          family,
          chosenKey: key,
          candidateCount: 1,
          scores: [],
          brokeTie: true,
          notes: ['uniform draw over the legal option set'],
        },
      });

      if (legal.pendingChoice) {
        const choice = legal.pendingChoice;
        const options = [...choice.validEntityIds].sort((a, b) => a.localeCompare(b));
        if (choice.ordered) {
          const shuffled = shuffleWith(options, pickInt);
          return finish(
            { type: 'submit_choice', playerId, choiceId: choice.id, selectedIds: shuffled },
            'submit_choice',
            'random:order',
          );
        }
        // An allocation is not a selection: `divide_damage` wants one entry per
        // point of damage, repeats included, so the distinct draw below is
        // short — and illegal — the moment there is more damage than there are
        // targets. This is the control pilot *and* the substituted fallback, so
        // an answer it cannot give is a seat that halts (M09.19).
        if (choice.type === 'divide_damage') {
          const points = Array.from(
            { length: choice.minimum },
            () => options[pickInt(options.length)] as string,
          );
          return finish(
            { type: 'submit_choice', playerId, choiceId: choice.id, selectedIds: points },
            'submit_choice',
            `random:divide_${points.length}`,
          );
        }
        const span = Math.max(0, Math.min(choice.maximum, options.length) - choice.minimum);
        const extra = span > 0 ? pickInt(span + 1) : 0;
        const size = Math.min(choice.minimum + extra, options.length);
        const chosen = drawDistinct(options, size);
        return finish(
          { type: 'submit_choice', playerId, choiceId: choice.id, selectedIds: chosen },
          'submit_choice',
          `random:choice_${size}`,
        );
      }

      if (legal.mulligan) {
        const roll = nextInt(state, 1000);
        state = roll.state;
        const redraw = roll.value / 1000 < config.mulliganRedrawChance;
        const hand = [...legal.mulligan.handInstanceIds].sort((a, b) => a.localeCompare(b));
        const count = redraw && hand.length > 0 ? pickInt(hand.length) + 1 : 0;
        return finish(
          { type: 'mulligan', playerId, returnInstanceIds: drawDistinct(hand, count) },
          'mulligan',
          `random:mulligan_${count}`,
        );
      }

      // A Reaction window pre-empts the rest of the turn, so it is answered
      // before anything else — as the engine requires, and before the family
      // weights below, which describe a Main Phase and have nothing to say
      // about priority.
      if (legal.reaction) {
        const playable = [...legal.reaction.playableCards].sort((a, b) =>
          a.instanceId.localeCompare(b.instanceId),
        );
        // Passing is one of the options, always: a window that nobody ever
        // declined would never close.
        const roll = pickInt(playable.length + 1);
        const choice = playable[roll];
        if (choice === undefined) {
          return finish(
            { type: 'pass_reaction', playerId },
            'pass_reaction',
            'random:reaction_pass',
          );
        }
        return finish(
          { type: 'play_reaction', playerId, instanceId: choice.instanceId },
          'play_reaction',
          `random:reaction_play_${choice.definitionId}`,
        );
      }

      if (legal.blocking) {
        const attackers = [...legal.blocking.attackerInstanceIds].sort((a, b) =>
          a.localeCompare(b),
        );
        const available = [...legal.blocking.blockerInstanceIds].sort((a, b) => a.localeCompare(b));
        const blocks: { attackerInstanceId: string; blockerInstanceId: string }[] = [];
        const pool = [...available];
        for (const attackerInstanceId of attackers) {
          if (pool.length === 0) break;
          // Half the time this attacker goes unblocked.
          if (pickInt(2) === 0) continue;
          const index = pickInt(pool.length);
          const [blockerInstanceId] = pool.splice(index, 1);
          if (blockerInstanceId === undefined) break;
          blocks.push({ attackerInstanceId, blockerInstanceId });
        }
        // Guardian is compulsory, so a random plan still has to be topped up
        // to the obligation before it is a legal action at all.
        const legalBlocks = satisfyGuardianObligation(legal.blocking, blocks);
        return finish(
          { type: 'assign_blockers', playerId, blocks: legalBlocks },
          'assign_blockers',
          `random:block_${legalBlocks.length}`,
        );
      }

      if (legal.attacking) {
        const attackers = [...legal.attacking.legalAttackers].sort((a, b) => a.localeCompare(b));
        const defenders = [...legal.attacking.legalDefenders].sort((a, b) => a.localeCompare(b));
        const attacks: { attackerInstanceId: string; defenderPlayerId: string }[] = [];
        if (defenders.length > 0) {
          for (const attackerInstanceId of attackers) {
            if (pickInt(3) === 0) continue;
            attacks.push({ attackerInstanceId, defenderPlayerId: pick(defenders) });
          }
        }
        return finish(
          { type: 'declare_attackers', playerId, attacks },
          'declare_attackers',
          `random:attack_${attacks.length}`,
        );
      }

      const families: { family: DecisionFamily; build: () => Action }[] = [];
      for (const card of [...legal.playableCards].sort((a, b) =>
        a.instanceId.localeCompare(b.instanceId),
      )) {
        families.push({
          family: 'play_card',
          build: () => ({ type: 'play_card', playerId, instanceId: card.instanceId }),
        });
      }
      for (const ability of [...legal.activatableAbilities].sort((a, b) =>
        `${a.sourceInstanceId}:${a.abilityId}`.localeCompare(
          `${b.sourceInstanceId}:${b.abilityId}`,
        ),
      )) {
        families.push({
          family: 'activate_ability',
          build: () => ({
            type: 'activate_ability',
            playerId,
            sourceInstanceId: ability.sourceInstanceId,
            abilityId: ability.abilityId,
          }),
        });
      }
      if (legal.canPassPhase) {
        families.push({ family: 'pass_phase', build: () => ({ type: 'pass_phase', playerId }) });
      }
      if (config.mayConcede && legal.canConcede && families.length === 0) {
        families.push({ family: 'concede', build: () => ({ type: 'concede', playerId }) });
      }

      if (families.length === 0) {
        throw new Error('random_legal was asked to decide with no legal action available.');
      }

      const weighted = weightedPick(families, config.familyWeights, pickInt);
      return finish(weighted.build(), weighted.family, `random:${weighted.family}`);

      function pickInt(bound: number): number {
        const roll = nextInt(state, Math.max(1, bound));
        state = roll.state;
        return roll.value;
      }

      function drawDistinct(pool: readonly string[], count: number): string[] {
        const remaining = [...pool];
        const chosen: string[] = [];
        for (let i = 0; i < count && remaining.length > 0; i += 1) {
          const index = pickInt(remaining.length);
          const [id] = remaining.splice(index, 1);
          if (id !== undefined) chosen.push(id);
        }
        return chosen;
      }
    },
  };
}

function shuffleWith(items: readonly string[], roll: (bound: number) => number): string[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = roll(i + 1);
    const a = out[i] as string;
    const b = out[j] as string;
    out[i] = b;
    out[j] = a;
  }
  return out;
}

function weightedPick<T extends { family: DecisionFamily }>(
  items: readonly T[],
  familyWeights: Readonly<Record<string, number>>,
  pickInt: (bound: number) => number,
): T {
  const weights = items.map((item) => familyWeights[item.family] ?? 1);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (total <= 0) return items[pickInt(items.length)] as T;

  // Integer roulette wheel: no floats, so the draw is bit-for-bit reproducible.
  const scale = 1000;
  const scaled = weights.map((weight) => Math.max(0, Math.round((weight / total) * scale)));
  const scaledTotal = scaled.reduce((sum, weight) => sum + weight, 0);
  if (scaledTotal <= 0) return items[pickInt(items.length)] as T;

  let ticket = pickInt(scaledTotal);
  for (let index = 0; index < items.length; index += 1) {
    ticket -= scaled[index] ?? 0;
    if (ticket < 0) return items[index] as T;
  }
  return items[items.length - 1] as T;
}
