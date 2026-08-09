import { z } from 'zod';
import { botWeightsSchema, type BotWeights } from './scoring.js';
import { PILOT_BASE_WEIGHTS, pilotSpecSchema, type PilotSpec, type PilotId } from './registry.js';

/**
 * Named heuristic-weight perturbations (PHASE4_HARDENING §10.3).
 *
 * A conclusion that survives only one weight vector is a fact about that weight
 * vector. CLAUDE.md §13.11 asks for robustness across "reasonable heuristic-weight
 * perturbations", and leaving that to whoever remembers to hand-edit a config
 * means it never happens. These profiles make it an executable, versioned,
 * reproducible experiment instead.
 *
 * Three properties are deliberate:
 *
 * - **Named and versioned.** A profile is part of the analysis contract. The
 *   version is recorded in every result, so "stable across pilots" always means
 *   a specific, checkable set of pilots.
 * - **Multiplicative and bounded.** Every profile scales published weights by a
 *   modest factor. A perturbation large enough to make a pilot play a different
 *   game does not test robustness, it tests a different pilot.
 * - **Taste, not sentinels.** `lethalBonus`, `survivalUrgency`, `tieEpsilon` and
 *   `passBaseline` are never perturbed. They are structural — `lethalBonus` says
 *   "take the win", not "prefer aggression by this much" — and scaling them
 *   would produce an incoherent pilot rather than a differently-tuned one.
 */

/** Bump when a profile's multipliers change. Recorded in every robustness result. */
export const PERTURBATION_PROFILE_VERSION = '1.0.0';

/** Weights that describe a structural rule rather than a preference. */
export const UNPERTURBED_WEIGHTS = [
  'lethalBonus',
  'survivalUrgency',
  'tieEpsilon',
  'passBaseline',
  'curveTop',
] as const;

type WeightKey = keyof BotWeights;

const ALL_WEIGHT_KEYS = Object.keys(botWeightsSchema.shape) as WeightKey[];

/** Keys a profile is allowed to scale. */
export const PERTURBABLE_WEIGHTS: readonly WeightKey[] = ALL_WEIGHT_KEYS.filter(
  (key) => !(UNPERTURBED_WEIGHTS as readonly string[]).includes(key),
);

export interface PerturbationProfile {
  readonly id: string;
  readonly description: string;
  /** Per-weight multipliers. Anything unlisted is left at the pilot's own value. */
  readonly multipliers: Readonly<Partial<Record<WeightKey, number>>>;
}

const uniform = (factor: number): Partial<Record<WeightKey, number>> =>
  Object.fromEntries(PERTURBABLE_WEIGHTS.map((key) => [key, factor]));

export const PERTURBATION_PROFILES: readonly PerturbationProfile[] = Object.freeze([
  {
    id: 'published',
    description: 'The pilot exactly as published. The reference arm of every comparison.',
    multipliers: {},
  },
  {
    id: 'all_up_10',
    description: 'Every preference weight scaled by 1.1. Tests sensitivity to overall gain.',
    multipliers: uniform(1.1),
  },
  {
    id: 'all_down_10',
    description: 'Every preference weight scaled by 0.9.',
    multipliers: uniform(0.9),
  },
  {
    id: 'combat_forward',
    description: 'Values pushing damage and trading up; discounts losing its own units.',
    multipliers: {
      attackFaceDamage: 1.3,
      attackTradeGain: 1.25,
      attackTradeLoss: 0.75,
      faceDamage: 1.25,
      attackExhaustCost: 0.7,
    },
  },
  {
    id: 'combat_cautious',
    description: 'The mirror of `combat_forward`: protects its board and blocks more readily.',
    multipliers: {
      attackFaceDamage: 0.75,
      attackTradeGain: 0.8,
      attackTradeLoss: 1.3,
      blockDamagePrevented: 1.25,
      blockTradeLoss: 0.8,
      readyBlockerValue: 1.3,
      ownHealthValue: 1.3,
    },
  },
  {
    id: 'card_advantage',
    description: 'Values drawing, tokens and persistent board over immediate tempo.',
    multipliers: {
      cardDraw: 1.35,
      tokenValue: 1.25,
      ownBoardValue: 1.15,
      energyEfficiency: 1.2,
      faceDamage: 0.85,
    },
  },
  {
    id: 'removal_forward',
    description: 'Values answering threats over developing its own board.',
    multipliers: {
      removalBonus: 1.35,
      unitDamage: 1.25,
      bounceValue: 1.2,
      enemyBoardValue: 1.2,
      ownBoardValue: 0.9,
    },
  },
]);

export const PERTURBATION_PROFILE_IDS = PERTURBATION_PROFILES.map((profile) => profile.id);
export const perturbationProfileIdSchema = z.enum(
  PERTURBATION_PROFILE_IDS as [string, ...string[]],
);

export function perturbationProfile(id: string): PerturbationProfile {
  const found = PERTURBATION_PROFILES.find((profile) => profile.id === id);
  if (!found) {
    throw new Error(
      `Unknown perturbation profile "${id}". Known profiles: ${PERTURBATION_PROFILE_IDS.join(', ')}.`,
    );
  }
  return found;
}

/**
 * Applies a profile to a pilot spec, producing a new spec.
 *
 * The profile scales the pilot's *effective* weights — its published vector with
 * the experiment's own overrides already applied — so a config that hand-tuned a
 * weight has that tuning perturbed too rather than silently discarded.
 *
 * `random_legal` has no weights to perturb and is returned unchanged; a
 * robustness experiment that includes it is measuring the same pilot in every
 * arm, which is a legitimate null control and reported as such rather than
 * treated as an error.
 */
export function perturbPilot(spec: PilotSpec, profileId: string): PilotSpec {
  const profile = perturbationProfile(profileId);
  if (spec.id === 'random_legal' || Object.keys(profile.multipliers).length === 0) {
    return pilotSpecSchema.parse({ ...spec });
  }

  const base = PILOT_BASE_WEIGHTS[spec.id as PilotId];
  // `spec.weights` is a partial override, so under `exactOptionalPropertyTypes`
  // the spread can legitimately produce `undefined` for a key. The loop below
  // skips those rather than multiplying by one.
  const effective: Record<string, number | undefined> = { ...base, ...spec.weights };

  const weights: Record<string, number> = {};
  for (const key of ALL_WEIGHT_KEYS) {
    const factor = profile.multipliers[key];
    const value = effective[key];
    if (factor === undefined || value === undefined) continue;
    weights[key] = roundWeight(value * factor);
  }

  return pilotSpecSchema.parse({ ...spec, weights: { ...spec.weights, ...weights } });
}

/**
 * Rounded so a perturbed weight is a readable number in a manifest, and so two
 * routes to the same weight (a profile, or a hand-written override) hash alike.
 */
function roundWeight(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
