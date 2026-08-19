/**
 * Generator output recorded **before** M09.8 moved the code.
 *
 * Every digest below was taken from `apps/simulator/src/deck-search/generate.ts`
 * at commit `808e7e4`, over the whole `{ deck, diagnostics }` result, with
 * `digestOf` — the same function, over the same value, that the equivalence
 * tests now take. That is what makes "the extraction changed nothing" a check
 * rather than a claim: a weighting, an ordering or a stopping rule that moved by
 * one card changes the deck hash, and the deck hash is inside the digest.
 *
 * They are inputs plus an expected digest rather than forty stored card lists
 * because a digest is total over the result — label, ID, origin, construction
 * and diagnostics included — where a stored list quietly stops checking
 * everything the list does not contain. `WAVE_1_SEED_A_CARDS` is kept in full
 * so a failure has something readable beside it.
 *
 * If one of these ever has to move, it moves with `DECK_GENERATOR_VERSION` and
 * with a recorded reason. Re-recording a golden to make a test pass is the one
 * thing this file exists to prevent.
 */

import type { GeneratorConfigInput } from './generate.js';

export interface GoldenCase {
  readonly name: string;
  readonly seed: string;
  readonly config: GeneratorConfigInput;
  readonly commanderId?: string;
  readonly label?: string;
  /** `digestOf({ deck, diagnostics }, 32)` as recorded before the move. */
  readonly digest: string;
}

/** The format both environments resolve to. Real content, not a fixture. */
export const GOLDEN_FORMAT_ID = 'precon_wave_1';

export const WAVE_1_GOLDEN_CASES: readonly GoldenCase[] = Object.freeze([
  {
    name: 'default/seed-a',
    seed: 'seed-a',
    config: {},
    digest: '6670980a3ad5ba93124f43920317e31b',
  },
  {
    name: 'default/seed-b',
    seed: 'seed-b',
    config: {},
    digest: '3b4a8e4abe2de733c1f7a440bf1d4bf2',
  },
  {
    name: 'commander-fixed',
    seed: 'seed-c',
    config: {},
    commanderId: 'grave_matriarch',
    label: 'fixed',
    digest: '981819380fcf116d3cbfa7a55a6701b3',
  },
  {
    name: 'curve-and-roles',
    seed: 'seed-d',
    config: {
      curve: { cheap: 0.5, mid: 0.3, expensive: 0.2 },
      roleWeights: { attacker: 3, support: 0.5 },
      minUnits: 16,
    },
    digest: '5f9addeae2c152d1821f4ea8716b9b46',
  },
  {
    name: 'plan-all',
    seed: 'seed-e',
    config: { planId: 'plan_bastion_guardians', planPackages: 'all' },
    digest: '1a6b89c788d667106a66e5e86003723f',
  },
  {
    name: 'plan-core',
    seed: 'seed-f',
    config: { planId: 'plan_bastion_guardians', planPackages: 'core' },
    digest: '0b029d8be2910d422b30355ca7d1cd9a',
  },
  {
    name: 'required-cards',
    seed: 'seed-g',
    config: { requiredCards: [{ cardId: 'throwing_knife', quantity: 1 }] },
    commanderId: 'chief_containment_scholar',
    digest: '2186d2af9c59668263a4f4ff892544ad',
  },
]);

/** `digestOf({ decks, diagnostics }, 32)` for `generatePopulation(env, 'pop', 4)`. */
export const WAVE_1_POPULATION_GOLDEN = Object.freeze({
  seed: 'pop',
  size: 4,
  digest: '156b2b9ae3f61f135c050bdeec967ea6',
});

/** The exact deck `default/seed-a` produced, so a failure is readable. */
export const WAVE_1_SEED_A_CARDS: readonly string[] = Object.freeze([
  'back_to_the_warrens',
  'call_a_goblin',
  'crude_bomb',
  'dismantle_the_device',
  'empty_the_tunnels',
  'goblin_banner_thief',
  'goblin_bomb_thrower',
  'goblin_breeder',
  'goblin_bruiser',
  'goblin_caller',
  'goblin_chieftain',
  'goblin_drummer',
  'goblin_horde_breaker',
  'goblin_instigator',
  'goblin_lookout',
  'goblin_mob_caller',
  'goblin_piledriver',
  'goblin_powder_runner',
  'goblin_quartermaster',
  'goblin_raid_standard',
  'goblin_recruiter',
  'goblin_scrapmaster',
  'goblin_shieldbearer',
  'goblin_siege_leader',
  'goblin_sneak',
  'goblin_spearman',
  'goblin_tallykeeper',
  'goblin_torchrunner',
  'goblin_war_drum',
  'hired_mercenary',
  'makeshift_weapon',
  'mob_justice',
  'open_the_tunnels',
  'rebuild_the_mob',
  'scatter',
  'search_the_scrapheap',
  'sound_the_warhorn',
  'strength_in_numbers',
  'throwing_knife',
  'veteran_guard',
]);

/**
 * The simulator's own twelve-card fixture environment, recorded the same way.
 *
 * Kept here beside the real-format goldens so both halves of the equivalence
 * claim read from one table; the fixture itself lives in the simulator, so the
 * test that uses these lives there too.
 */
export const TINY_GOLDENS = Object.freeze({
  /** `generateDeck(tiny, 'seed-1')`. */
  seed1Digest: '8180d9e42cdaa0b364970a05675fc230',
  /** `generatePopulation(tiny, 'pop', 6)`. */
  population6Digest: '6925cc4b8bf20f580df7d5ca520022eb',
});
