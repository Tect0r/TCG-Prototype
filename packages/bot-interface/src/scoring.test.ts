import { describe, expect, it } from 'vitest';
import {
  ABILITY_COST_TYPES,
  EFFECT_TYPES,
  KEYWORD_IDS,
  STATIC_ABILITY_EFFECT_TYPES,
  abilityCostSchema,
  cardDefinitionSchema,
  delayedAbilityDefinitionSchema,
  effectDefinitionSchema,
  mechanicSupport,
  staticAbilityDefinitionSchema,
  type AbilityCost,
  type AbilityCostType,
  type CardDefinition,
  type DelayedAbilityDefinition,
  type EffectDefinition,
  type EffectType,
  type KeywordId,
  type StaticAbilityDefinition,
  type StaticAbilityEffectType,
} from '@tcg/card-data';
import {
  DEFAULT_WEIGHTS,
  cardValue,
  costValue,
  costsValue,
  effectPricingGaps,
  effectValue,
  keywordIsValued,
} from './scoring.js';
import { botTestDatabase } from './test-driver.js';

/**
 * Focused valuation tests for every Wave 1 primitive (M05.2).
 *
 * The contract tests next door ask what a pilot is *allowed* to see and return.
 * This file asks a narrower question about one function: given a structured
 * instruction, a cost or a continuous ability, does the scorer put a number on
 * it, and is that number pointing the right way. It exists because the failure
 * this tranche repaired was invisible to every other suite — `counter` fell
 * through a `default: 0` for the entire life of the Reaction mechanic, and a
 * silent zero looks exactly like a deliberate "worth nothing".
 *
 * Two tables here are mapped types over the schema's own vocabularies
 * (`EffectType`, `StaticAbilityEffectType`, `AbilityCostType`), so a mechanic
 * added without a valuation test is a **compile error in this file** as well as
 * in `scoring.ts`. That is the "adding an unscored mechanic fails loudly"
 * acceptance criterion, checked from the test side.
 */

const database = botTestDatabase();
const weights = DEFAULT_WEIGHTS;

const effect = (input: unknown): EffectDefinition => effectDefinitionSchema.parse(input);
const cost = (input: unknown): AbilityCost => abilityCostSchema.parse(input);
const staticAbility = (input: unknown): StaticAbilityDefinition =>
  staticAbilityDefinitionSchema.parse(input);
const delayed = (input: unknown): DelayedAbilityDefinition =>
  delayedAbilityDefinitionSchema.parse(input);

/** An entity selector aimed at one unit on the named side of the table. */
const oneUnit = (controller: 'self' | 'opponent', count: number | 'all' = 1) => ({
  kind: 'entity' as const,
  selector: { zone: 'battlefield', controller, count, selection: 'player_choice' },
});

const value = (
  input: unknown,
  delayedAbilities: readonly DelayedAbilityDefinition[] = [],
): number => effectValue(effect(input), weights, database, delayedAbilities);

/* ------------------------------------------------------------------ fixtures */

/**
 * A vanilla 2/2 with no text at all, used as the control every synthetic card is
 * measured against. Parsed through the schema rather than written as a literal,
 * so the defaults a card really carries are the ones under test.
 */
function vanilla(overrides: Record<string, unknown> = {}): CardDefinition {
  return cardDefinitionSchema.parse({
    schemaVersion: 2,
    id: 'scoring_test_unit',
    name: 'Scoring Test Unit',
    type: 'unit',
    colorIdentity: [],
    cost: 2,
    attack: 2,
    health: 2,
    role: 'attacker',
    powerClass: 'standard',
    tags: [],
    displayText: 'A deliberately ordinary body.',
    ...overrides,
  });
}

const VANILLA_VALUE = cardValue(vanilla(), weights, database);

/** What one continuous ability adds to the card printing it. */
function staticValue(input: unknown): number {
  return (
    cardValue(vanilla({ staticAbilities: [staticAbility(input)] }), weights, database) -
    VANILLA_VALUE
  );
}

/* ------------------------------------------------------------------ totality */

describe('the instruction vocabulary is priced exhaustively', () => {
  it('has a pricer for every effect the schema defines, and no others', () => {
    // The runtime twin of the mapped type on `EFFECT_PRICERS`. A `default: 0`
    // switch could pass every other test in this file while quietly pricing an
    // unrecognised instruction at nothing.
    expect(effectPricingGaps()).toEqual([]);
  });

  /**
   * One representative instruction per member of the vocabulary, with the sign
   * the acting player should read it as.
   *
   * A total `Record` over `EffectType`, so adding an instruction to the schema
   * without adding a valuation case here does not compile.
   */
  const CASES: { readonly [K in EffectType]: { effect: unknown; sign: 1 | -1 } } = {
    draw: { effect: { type: 'draw', player: 'self', amount: 2 }, sign: 1 },
    discard: { effect: { type: 'discard', player: 'opponent', amount: 1 }, sign: 1 },
    deal_damage: {
      effect: { type: 'deal_damage', target: oneUnit('opponent'), amount: 3 },
      sign: 1,
    },
    heal: {
      effect: {
        type: 'heal',
        target: { kind: 'player', relation: 'self', selection: 'automatic' },
        amount: 3,
      },
      sign: 1,
    },
    modify_stats: {
      effect: { type: 'modify_stats', target: oneUnit('self'), attack: 2, health: 2 },
      sign: 1,
    },
    grant_keyword: {
      effect: { type: 'grant_keyword', target: oneUnit('self'), keyword: 'guardian' },
      sign: 1,
    },
    remove_keyword: {
      effect: { type: 'remove_keyword', target: oneUnit('opponent'), keyword: 'guardian' },
      sign: 1,
    },
    create_token: {
      effect: { type: 'create_token', tokenCardId: 'goblin_token', amount: 2 },
      sign: 1,
    },
    destroy: { effect: { type: 'destroy', target: oneUnit('opponent') }, sign: 1 },
    sacrifice: { effect: { type: 'sacrifice', target: oneUnit('self') }, sign: -1 },
    return_to_hand: { effect: { type: 'return_to_hand', target: oneUnit('opponent') }, sign: 1 },
    search_zone: { effect: { type: 'search_zone', zone: 'deck', amount: 1 }, sign: 1 },
    reorder_zone: { effect: { type: 'reorder_zone', zone: 'deck', amount: 3 }, sign: 1 },
    modify_cost: { effect: { type: 'modify_cost', player: 'self', delta: -2 }, sign: 1 },
    prevent_damage: {
      effect: {
        type: 'prevent_damage',
        target: { kind: 'player', relation: 'self', selection: 'automatic' },
        amount: 2,
      },
      sign: 1,
    },
    exhaust: { effect: { type: 'exhaust', target: oneUnit('opponent') }, sign: 1 },
    ready: { effect: { type: 'ready', target: oneUnit('self') }, sign: 1 },
    skip_next_ready: { effect: { type: 'skip_next_ready', target: oneUnit('opponent') }, sign: 1 },
    move_card: {
      effect: { type: 'move_card', target: oneUnit('self'), toZone: 'battlefield' },
      sign: 1,
    },
    counter: { effect: { type: 'counter' }, sign: 1 },
    schedule_delayed: { effect: { type: 'schedule_delayed', delayedAbilityId: 'later' }, sign: 1 },
  };

  const LATER = [
    delayed({
      id: 'later',
      boundary: 'end_of_turn',
      effects: [{ type: 'draw', player: 'self', amount: 2 }],
    }),
  ];

  it('covers exactly the schema vocabulary', () => {
    // Belt and braces beside the mapped type, for the same reason
    // `effectPricingGaps` exists: it catches a case left behind for an
    // instruction the schema no longer has.
    expect(Object.keys(CASES).sort()).toEqual([...EFFECT_TYPES].sort());
  });

  for (const [type, entry] of Object.entries(CASES)) {
    it(`prices ${type} as a non-zero number of the right sign`, () => {
      const scored = value(entry.effect, LATER);
      expect(scored).not.toBe(0);
      expect(Math.sign(scored)).toBe(entry.sign);
    });
  }
});

/* ------------------------------------------------------------------ keywords */

describe('a keyword the engine does not execute is worth nothing', () => {
  /**
   * The first bullet of M05.2. `keywordCount` used to pay a flat `keywordBonus`
   * for every printed keyword, which made a card carrying the deliberately inert
   * `resilient` (Q4) read as strictly better than the same card without it — so
   * a pilot mulliganed toward it, protected it in combat, and a balance run
   * reported the difference as a property of the card rather than of the scorer.
   */
  it('reads the valued set off the support registry rather than a second list', () => {
    for (const keyword of KEYWORD_IDS) {
      expect(keywordIsValued(keyword)).toBe(
        mechanicSupport({ kind: 'keyword', id: keyword }).engine === 'full',
      );
    }
  });

  it('names resilient, and only resilient, as the unvalued keyword today', () => {
    const inert = KEYWORD_IDS.filter((keyword) => !keywordIsValued(keyword));
    expect(inert).toEqual(['resilient']);
  });

  it('does not pay for an inert keyword printed on a card', () => {
    const inert: KeywordId = 'resilient';
    expect(cardValue(vanilla({ keywords: [inert] }), weights, database)).toBe(VANILLA_VALUE);
    expect(cardValue(vanilla({ keywords: ['guardian'] }), weights, database)).toBeGreaterThan(
      VANILLA_VALUE,
    );
  });

  it('does not pay for granting one either, however long the grant lasts', () => {
    expect(
      value({
        type: 'grant_keyword',
        target: oneUnit('self'),
        keyword: 'resilient',
        duration: 'permanent',
      }),
    ).toBe(0);
    expect(
      value({ type: 'grant_keyword', target: oneUnit('self'), keyword: 'guardian' }),
    ).toBeGreaterThan(0);
  });

  it('does not pay for a continuous ability that grants one', () => {
    expect(
      staticValue({
        id: 'inert_lord',
        activeZone: 'battlefield',
        affects: { zone: 'battlefield', controller: 'self' },
        effect: { type: 'grant_keyword', keyword: 'resilient' },
      }),
    ).toBe(0);
  });
});

/* --------------------------------------------------------------- instructions */

describe('each instruction is read from the acting player’s side of the table', () => {
  it('draws for us and against them', () => {
    expect(value({ type: 'draw', player: 'self', amount: 1 })).toBeGreaterThan(0);
    expect(value({ type: 'draw', player: 'opponent', amount: 1 })).toBeLessThan(0);
  });

  it('discards from them and not from us', () => {
    expect(value({ type: 'discard', player: 'opponent', amount: 1 })).toBeGreaterThan(0);
    expect(value({ type: 'discard', player: 'self', amount: 1 })).toBeLessThan(0);
  });

  it('scales damage with its amount and reads its target', () => {
    const small = value({ type: 'deal_damage', target: oneUnit('opponent'), amount: 1 });
    const large = value({ type: 'deal_damage', target: oneUnit('opponent'), amount: 4 });
    expect(large).toBeGreaterThan(small);

    expect(value({ type: 'deal_damage', target: oneUnit('self'), amount: 2 })).toBeLessThan(0);
    // `source` and `trigger_subject` both aim at one of our own cards.
    expect(value({ type: 'deal_damage', target: { kind: 'source' }, amount: 2 })).toBeLessThan(0);
    expect(
      value({
        type: 'deal_damage',
        target: { kind: 'player', relation: 'self', selection: 'automatic' },
        amount: 2,
      }),
    ).toBeLessThan(0);
  });

  it('heals us and not them', () => {
    const self = {
      type: 'heal',
      target: { kind: 'player', relation: 'self', selection: 'automatic' },
      amount: 2,
    };
    expect(value(self)).toBeGreaterThan(0);
    expect(
      value({ ...self, target: { kind: 'player', relation: 'opponent', selection: 'automatic' } }),
    ).toBeLessThan(0);
  });

  it('scales a stat modifier with its magnitude, its duration and its side', () => {
    const buff = (extra: Record<string, unknown>) =>
      value({ type: 'modify_stats', target: oneUnit('self'), attack: 1, health: 1, ...extra });
    expect(buff({ attack: 3, health: 3 })).toBeGreaterThan(buff({}));
    expect(buff({ duration: 'end_of_turn' })).toBeLessThan(buff({ duration: 'permanent' }));
    expect(buff({ target: oneUnit('opponent') })).toBeLessThan(0);
  });

  it('treats removing a keyword from our own unit as a drawback', () => {
    // The old pricing returned the same positive number either way, which made
    // "this Unit loses Guardian" read as an upside on the card printing it.
    const strip = (controller: 'self' | 'opponent') =>
      value({ type: 'remove_keyword', target: oneUnit(controller), keyword: 'guardian' });
    expect(strip('opponent')).toBeGreaterThan(0);
    expect(strip('self')).toBeLessThan(0);
    // Half a grant: taking a keyword away is worth less than handing one out.
    expect(strip('opponent')).toBeLessThan(
      value({ type: 'grant_keyword', target: oneUnit('self'), keyword: 'guardian' }),
    );
  });

  it('prices a token by the body it puts on the board, and by how many', () => {
    const one = value({ type: 'create_token', tokenCardId: 'goblin_token', amount: 1 });
    const two = value({ type: 'create_token', tokenCardId: 'goblin_token', amount: 2 });
    expect(two).toBeGreaterThan(one);
    expect(one).toBeGreaterThan(0);
  });

  it('scales removal with how many things it names, and signs it by whose they are', () => {
    const one = value({ type: 'destroy', target: oneUnit('opponent', 1) });
    const two = value({ type: 'destroy', target: oneUnit('opponent', 2) });
    expect(two).toBeGreaterThan(one);
    expect(value({ type: 'destroy', target: { kind: 'source' } })).toBeLessThan(0);
  });

  it('prices bouncing theirs as a gain and ours as a small price', () => {
    expect(value({ type: 'return_to_hand', target: oneUnit('opponent') })).toBeGreaterThan(0);
    expect(value({ type: 'return_to_hand', target: oneUnit('self') })).toBeLessThan(0);
  });

  it('prices a search above a draw of the same size, and scales it', () => {
    const one = value({ type: 'search_zone', zone: 'deck', amount: 1 });
    expect(one).toBeGreaterThan(value({ type: 'draw', player: 'self', amount: 1 }));
    expect(value({ type: 'search_zone', zone: 'deck', amount: 2 })).toBeGreaterThan(one);
  });

  it('prices a reorder as information rather than as a card', () => {
    const reorder = value({ type: 'reorder_zone', zone: 'deck', amount: 3 });
    expect(reorder).toBeGreaterThan(0);
    expect(reorder).toBeLessThan(value({ type: 'draw', player: 'self', amount: 1 }));
  });

  it('prices a discount to us and nothing to a tax we cannot collect', () => {
    expect(value({ type: 'modify_cost', player: 'self', delta: -2 })).toBeGreaterThan(
      value({ type: 'modify_cost', player: 'self', delta: -1 }),
    );
    // Taxing an opponent's cards is real, but `effectValue` has no board to say
    // how many of them there are; it is priced by the callers that do.
    expect(value({ type: 'modify_cost', player: 'opponent', delta: 2 })).toBe(0);
  });

  it('scales prevention with its amount and its duration', () => {
    const shield = (extra: Record<string, unknown>) =>
      value({
        type: 'prevent_damage',
        target: { kind: 'player', relation: 'self', selection: 'automatic' },
        amount: 2,
        ...extra,
      });
    expect(shield({ amount: 4 })).toBeGreaterThan(shield({}));
    expect(shield({ duration: 'permanent' })).toBeGreaterThan(shield({ duration: 'end_of_turn' }));
  });

  it('prices exhausting and readying at the same tempo weight', () => {
    expect(value({ type: 'exhaust', target: oneUnit('opponent') })).toBe(weights.tapValue);
    expect(value({ type: 'ready', target: oneUnit('self') })).toBe(weights.tapValue);
  });

  it('prices a skipped Ready Step above an exhaust, and reads whose it is', () => {
    const theirs = value({ type: 'skip_next_ready', target: oneUnit('opponent') });
    expect(theirs).toBeGreaterThan(weights.tapValue);
    expect(value({ type: 'skip_next_ready', target: oneUnit('self') })).toBeLessThan(0);
    // "Units blocked by **this Unit** do not Ready" always names somebody else's
    // attackers, however the rest of the card reads.
    expect(
      value({ type: 'skip_next_ready', target: { kind: 'blocked_by_source' } }),
    ).toBeGreaterThan(0);
  });

  it('prices a revival above a draw and a removal by whose card it removes', () => {
    const revive = value({ type: 'move_card', target: oneUnit('self'), toZone: 'battlefield' });
    expect(revive).toBeGreaterThan(value({ type: 'draw', player: 'self', amount: 1 }));
    expect(
      value({ type: 'move_card', target: oneUnit('opponent'), toZone: 'removed' }),
    ).toBeGreaterThan(0);
    expect(value({ type: 'move_card', target: oneUnit('self'), toZone: 'removed' })).toBeLessThan(
      0,
    );
  });

  it('discounts a delayed clause against the same clause happening now', () => {
    const body = [{ type: 'draw', player: 'self', amount: 2 }];
    const now = value({ type: 'draw', player: 'self', amount: 2 });
    const boundary = value({ type: 'schedule_delayed', delayedAbilityId: 'end' }, [
      delayed({ id: 'end', boundary: 'end_of_turn', effects: body }),
    ]);
    const watch = value({ type: 'schedule_delayed', delayedAbilityId: 'watch' }, [
      delayed({
        id: 'watch',
        boundary: 'end_of_turn',
        trigger: 'on_defeated',
        subject: 'previous_target',
        effects: body,
      }),
    ]);

    expect(boundary).toBeGreaterThan(0);
    expect(boundary).toBeLessThan(now);
    // A watch may never fire at all, so it is discounted further than a clause
    // that only has to wait.
    expect(watch).toBeLessThan(boundary);
  });

  it('prices a delayed reference it was given no body for at zero rather than inventing one', () => {
    expect(value({ type: 'schedule_delayed', delayedAbilityId: 'missing' })).toBe(0);
  });
});

/* ------------------------------------------------------------------- counters */

describe('a Reaction that counters is not a blank card', () => {
  /**
   * The defect M05.1 recorded and this tranche repaired: `ungatedEffectValue`
   * had no `counter` case, so a Reaction whose whole text is a counter scored
   * zero — a pilot mulliganed it away and every precon carrying one reported
   * `pilot: legal_only`.
   */
  it('prices a hard counter at the counter weight', () => {
    expect(value({ type: 'counter' })).toBe(weights.counterValue);
  });

  it('softens a counter that can be paid off', () => {
    expect(value({ type: 'counter', unlessPays: 2 })).toBeLessThan(value({ type: 'counter' }));
    expect(value({ type: 'counter', unlessPays: 2 })).toBeGreaterThan(0);
  });

  it('never prices a tax above the counter it replaces', () => {
    // The branch is the *opponent's* choice: a controller who would rather lose
    // the card than pay simply lets it be countered. Without the cap, the
    // schema's largest printable tax scored above a hard counter.
    expect(value({ type: 'counter', unlessPays: 20 })).toBeLessThanOrEqual(
      value({ type: 'counter' }),
    );
  });

  it('leaves a shipped Reaction worth holding', () => {
    const reaction = database
      .all()
      .find((card) => card.effects.some((entry) => entry.type === 'counter'));
    expect(reaction).toBeDefined();
    if (!reaction) return;
    expect(cardValue(reaction, weights, database)).toBeGreaterThan(0);
  });
});

/* ---------------------------------------------------------------------- costs */

describe('a cost is charged wherever it is paid', () => {
  /** A total `Record` over the cost vocabulary, for the same reason as above. */
  const COSTS: { readonly [K in AbilityCostType]: unknown } = {
    energy: { type: 'energy', amount: 3 },
    exhaust_source: { type: 'exhaust_source' },
    discard: { type: 'discard', amount: 1 },
    sacrifice: { type: 'sacrifice', amount: 1 },
  };

  it('covers exactly the cost vocabulary', () => {
    expect(Object.keys(COSTS).sort()).toEqual([...ABILITY_COST_TYPES].sort());
  });

  for (const [type, input] of Object.entries(COSTS)) {
    it(`prices ${type} as a real, negative price`, () => {
      const priced = costValue(cost(input), weights);
      expect(priced).toBeLessThan(0);
    });
  }

  it('prices a sacrifice above a discard above the energy that buys either', () => {
    // Energy is discounted hard: a pilot only ever sees an action it can already
    // afford, where a pitched card or a sacrificed Unit is gone whatever happens.
    expect(costValue(cost({ type: 'sacrifice', amount: 1 }), weights)).toBeLessThan(
      costValue(cost({ type: 'discard', amount: 1 }), weights),
    );
    expect(costValue(cost({ type: 'discard', amount: 1 }), weights)).toBeLessThan(
      costValue(cost({ type: 'energy', amount: 1 }), weights),
    );
  });

  it('sums a cost list, and prices a free ability at nothing', () => {
    const costs = [cost({ type: 'energy', amount: 2 }), cost({ type: 'discard', amount: 1 })];
    expect(costsValue(costs, weights)).toBe(
      costs.reduce((sum, entry) => sum + costValue(entry, weights), 0),
    );
    expect(costsValue([], weights)).toBe(0);
  });

  it('charges a played card for its additional costs', () => {
    // The gap this sharing closed: `scoreActivate` had a private copy of the
    // cost switch, so "as an additional cost, sacrifice a Unit" was priced by
    // nobody and a Spell carrying one read to every pilot as though it were free.
    const additionalCosts = [{ type: 'sacrifice', amount: 1 }];
    const taxed = cardValue(vanilla({ additionalCosts }), weights, database);
    expect(taxed).toBeLessThan(VANILLA_VALUE);
    expect(taxed).toBe(
      VANILLA_VALUE + costsValue([cost({ type: 'sacrifice', amount: 1 })], weights),
    );
  });

  it('charges a card in hand for what its activated ability costs to use', () => {
    // The same defect one line up, on the other cost surface: pricing only the
    // upside made "sacrifice a Unit: draw a card" read as "draw a card". The
    // charge is halved along with the ability's own effects, because a card in
    // hand may never get to activate it at all.
    const sacrifice = cost({ type: 'sacrifice', amount: 1 });
    const activated = cardValue(
      vanilla({
        activatedAbilities: [
          {
            id: 'pitch',
            name: 'Pitch',
            costs: [{ type: 'sacrifice', amount: 1 }],
            usageLimit: 'unlimited',
            effects: [{ type: 'draw', player: 'self', amount: 1 }],
          },
        ],
      }),
      weights,
      database,
    );
    const bare = cardValue(
      vanilla({
        activatedAbilities: [
          {
            id: 'pitch',
            name: 'Pitch',
            usageLimit: 'unlimited',
            effects: [{ type: 'draw', player: 'self', amount: 1 }],
          },
        ],
      }),
      weights,
      database,
    );
    expect(activated).toBeLessThan(bare);
    expect(activated - bare).toBeCloseTo(costValue(sacrifice, weights) * 0.5, 10);
  });
});

/* --------------------------------------------------------- continuous effects */

describe('a continuous ability is priced by magnitude, scope, duration and side', () => {
  /**
   * The headline repair of M05.2. Both standing-layer effects used to be priced
   * as a flat `2 × buffValue` per ability — the same number for "+1/+0 to your
   * Goblins" and "+3/+3 to every Unit you control" — so a card's continuous text
   * was valued by the *length* of its `staticAbilities` array.
   */
  const lord = (overrides: Record<string, unknown> = {}, affects: Record<string, unknown> = {}) =>
    staticValue({
      id: 'lord',
      activeZone: 'battlefield',
      affects: { zone: 'battlefield', controller: 'self', ...affects },
      effect: { type: 'modify_stats', attack: 1, health: 1 },
      ...overrides,
    });

  it('is not priced by how many abilities are printed', () => {
    const oneBig = lord({ effect: { type: 'modify_stats', attack: 3, health: 3 } });
    const twoTiny =
      cardValue(
        vanilla({
          staticAbilities: [
            staticAbility({
              id: 'a',
              activeZone: 'battlefield',
              affects: { zone: 'battlefield', controller: 'self' },
              effect: { type: 'modify_stats', attack: 1, health: 0 },
            }),
            staticAbility({
              id: 'b',
              activeZone: 'battlefield',
              affects: { zone: 'battlefield', controller: 'self' },
              effect: { type: 'modify_stats', attack: 0, health: 1 },
            }),
          ],
        }),
        weights,
        database,
      ) - VANILLA_VALUE;

    expect(oneBig).toBeGreaterThan(twoTiny);
  });

  it('scales with printed magnitude', () => {
    expect(lord({ effect: { type: 'modify_stats', attack: 3, health: 3 } })).toBeGreaterThan(
      lord(),
    );
  });

  it('prices a narrower scope below a wider one', () => {
    // "**This card** …" reaches one recipient; a tribal filter reaches fewer
    // cards than an unconditional board buff.
    expect(lord({}, { onlySource: true })).toBeLessThan(lord());
    expect(lord({}, { filter: { tags: ['goblin'] } })).toBeLessThan(lord());
  });

  it('signs a buff by whose cards it lands on', () => {
    expect(lord()).toBeGreaterThan(0);
    expect(lord({}, { controller: 'opponent' })).toBeLessThan(0);
    // A debuff aimed at opponents comes out positive from the same arithmetic.
    expect(
      lord(
        { effect: { type: 'modify_stats', attack: -1, health: -1 } },
        { controller: 'opponent' },
      ),
    ).toBeGreaterThan(0);
  });

  it('discounts an ability gated on the source’s own state', () => {
    expect(lord({ sourceState: 'ready' })).toBeLessThan(lord());
  });

  /**
   * One case per member of the continuous vocabulary, as a total `Record` — the
   * same compile-time guarantee the instruction table above carries.
   */
  const CONTINUOUS: { readonly [K in StaticAbilityEffectType]: { input: unknown; sign: 1 | -1 } } =
    {
      modify_stats: {
        input: {
          id: 'c',
          activeZone: 'battlefield',
          affects: { zone: 'battlefield', controller: 'self' },
          effect: { type: 'modify_stats', attack: 1, health: 1 },
        },
        sign: 1,
      },
      grant_keyword: {
        input: {
          id: 'c',
          activeZone: 'battlefield',
          affects: { zone: 'battlefield', controller: 'self' },
          effect: { type: 'grant_keyword', keyword: 'guardian' },
        },
        sign: 1,
      },
      reaction_discount: {
        input: {
          id: 'c',
          activeZone: 'battlefield',
          affects: { zone: 'battlefield', controller: 'self' },
          effect: { type: 'reaction_discount', amount: 2 },
        },
        sign: 1,
      },
      cost_reduction: {
        input: {
          id: 'c',
          activeZone: 'hand',
          affects: { zone: 'hand', controller: 'self', onlySource: true },
          effect: { type: 'cost_reduction', amount: 2 },
        },
        sign: 1,
      },
      replace_arrival: {
        input: {
          id: 'c',
          activeZone: 'battlefield',
          affects: { zone: 'battlefield', controller: 'opponent' },
          effect: { type: 'replace_arrival', entersExhausted: true },
        },
        sign: 1,
      },
      replace_ready: {
        input: {
          id: 'c',
          activeZone: 'battlefield',
          affects: { zone: 'battlefield', controller: 'opponent' },
          effect: { type: 'replace_ready' },
        },
        sign: 1,
      },
    };

  it('covers exactly the continuous vocabulary', () => {
    expect(Object.keys(CONTINUOUS).sort()).toEqual([...STATIC_ABILITY_EFFECT_TYPES].sort());
  });

  for (const [type, entry] of Object.entries(CONTINUOUS)) {
    it(`prices a ${type} layer as a non-zero number of the right sign`, () => {
      const scored = staticValue(entry.input);
      expect(scored).not.toBe(0);
      expect(Math.sign(scored)).toBe(entry.sign);
    });
  }

  it('prices a Reaction discount as energy, and throttles a once-a-turn one', () => {
    const discount = (extra: Record<string, unknown>) =>
      staticValue({
        id: 'd',
        activeZone: 'battlefield',
        affects: { zone: 'battlefield', controller: 'self' },
        effect: { type: 'reaction_discount', amount: 2, ...extra },
      });
    expect(discount({ limit: 'first_each_turn' })).toBeLessThan(discount({ limit: 'unlimited' }));
    expect(discount({ amount: 4, limit: 'unlimited' })).toBeGreaterThan(
      discount({ limit: 'unlimited' }),
    );
  });

  it('prices a discount on one card below a discount on a whole hand', () => {
    const reduction = (affects: Record<string, unknown>) =>
      staticValue({
        id: 'r',
        activeZone: 'hand',
        affects: { zone: 'hand', controller: 'self', ...affects },
        effect: { type: 'cost_reduction', amount: 2 },
      });
    expect(reduction({ onlySource: true })).toBeLessThan(reduction({}));
  });

  it('reads a rewritten arrival by whose arrival it rewrites', () => {
    const replace = (
      effectInput: Record<string, unknown>,
      controller: 'self' | 'opponent' = 'opponent',
    ) =>
      staticValue({
        id: 'a',
        activeZone: 'battlefield',
        affects: { zone: 'battlefield', controller },
        effect: { type: 'replace_arrival', ...effectInput },
      });

    // Their units arriving Exhausted is tempo denial; ours arriving Exhausted is
    // a drawback the card is paying for something else.
    expect(replace({ entersExhausted: true })).toBeGreaterThan(0);
    expect(replace({ entersExhausted: true }, 'self')).toBeLessThan(0);
    // Handing our own arrivals a keyword is a buff, and it keeps its printed
    // duration because the keyword outlives the arrival that granted it.
    expect(replace({ grantKeyword: 'rush' }, 'self')).toBeGreaterThan(0);
    expect(replace({ grantKeyword: 'rush', grantDuration: 'permanent' }, 'self')).toBeGreaterThan(
      replace({ grantKeyword: 'rush', grantDuration: 'end_of_turn' }, 'self'),
    );
    // "The **first** … each turn" rewrites one arrival rather than all of them.
    expect(replace({ entersExhausted: true, limit: 'first_each_turn' })).toBeLessThan(
      replace({ entersExhausted: true, limit: 'unlimited' }),
    );
  });

  it('prices a denied Ready Step above an exhaust, less what it charges', () => {
    const deny = (effectInput: Record<string, unknown> = {}) =>
      staticValue({
        id: 'y',
        activeZone: 'battlefield',
        affects: { zone: 'battlefield', controller: 'opponent' },
        effect: { type: 'replace_ready', ...effectInput },
      });
    expect(deny()).toBeGreaterThan(weights.tapValue);
    expect(deny({ energyCost: 3 })).toBeLessThan(deny());
    expect(deny({ limit: 'first_each_turn' })).toBeLessThan(deny({ limit: 'unlimited' }));
  });
});
