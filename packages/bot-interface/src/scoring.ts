import { z } from 'zod';
import { EFFECT_TYPES, isDistributedSelection, mechanicSupport } from '@tcg/card-data';
import type {
  AbilityCost,
  CardDatabase,
  CardDefinition,
  ContinuousScope,
  Controller,
  DelayedAbilityDefinition,
  Duration,
  EffectDefinition,
  EffectType,
  KeywordId,
  SignedValueExpression,
  StaticAbilityDefinition,
  ValueExpression,
  ZoneId,
} from '@tcg/card-data';
import type { CardInstanceView, PlayerView, PlayerViewSummary } from '@tcg/rules-engine';

/**
 * Shared, transparent scoring.
 *
 * Every heuristic pilot is the *same* decision procedure driven by a different
 * weight vector, so the difference between "aggressive" and "defensive" is a set
 * of named numbers a reader can inspect rather than four divergent code paths
 * (CLAUDE.md §13.3). No rule here keys off a card ID: valuation is derived from
 * the statline, the structured effects, the keywords, the role and the power
 * class, all of which are authored data.
 */

/**
 * Named, serializable heuristic weights.
 *
 * Every field is documented in terms of what one unit of it buys, because these
 * numbers are exported into result metadata and read back by someone who did not
 * write them.
 */
export const botWeightsSchema = z.strictObject({
  /* --------------------------------------------------------- card valuation */
  /** Value of one point of printed Attack on a unit. */
  unitAttack: z.number().default(1),
  /** Value of one point of printed Health on a unit. */
  unitHealth: z.number().default(0.8),
  /** Value of one active keyword on a unit. */
  keywordBonus: z.number().default(0.6),
  /** Flat value of controlling a relic, before its effects are counted. */
  relicBase: z.number().default(1.5),
  /** Value of one point of energy actually converted into board or effect. */
  energyEfficiency: z.number().default(0.35),
  /** Penalty per point of energy left unspent at the end of a Main Phase. */
  unspentEnergyPenalty: z.number().default(0.3),

  /* ------------------------------------------------------- effect valuation */
  /** Value of one card drawn. */
  cardDraw: z.number().default(1.6),
  /** Value (to us) of one card the opponent discards; negative when it is ours. */
  discardCard: z.number().default(1.2),
  /** Value of one point of damage aimed at an opposing player's Health. */
  faceDamage: z.number().default(1.0),
  /** Value of one point of damage aimed at an opposing unit. */
  unitDamage: z.number().default(0.7),
  /** Value of one point of Health restored to us. */
  healing: z.number().default(0.6),
  /** Value of destroying one opposing unit outright, on top of its board value. */
  removalBonus: z.number().default(1.5),
  /** Value of one token created, multiplied by the token's own board value. */
  tokenValue: z.number().default(0.9),
  /** Value of one point of stat buff granted. */
  buffValue: z.number().default(0.5),
  /** Value of bouncing an opposing unit back to hand. */
  bounceValue: z.number().default(1.2),
  /** Value of one point of damage prevention. */
  preventionValue: z.number().default(0.5),
  /** Value of exhausting an opposing unit / readying one of ours. */
  tapValue: z.number().default(0.6),
  /**
   * Value of countering the card a Reaction window named, before that card is
   * known (M05.2).
   *
   * A card-shaped estimate rather than a board reading, because `effectValue`
   * ranks a card in the abstract and the thing a counter answers has not been
   * played yet. Roughly a mid-cost Wave 1 card: enough that a Reaction whose
   * whole text is a counter is worth keeping in an opening hand, not so much
   * that a pilot holds one over a board it needs to answer. `scoreReaction`
   * replaces this estimate with the value of the card actually on the stack
   * once the window exists, so this number only ever decides *holding* a
   * counter, never spending one.
   */
  counterValue: z.number().default(3),

  /* ------------------------------------------------------------ board state */
  /** Multiplier on the value of a unit we already control. */
  ownBoardValue: z.number().default(1),
  /** Multiplier on the value of an opposing unit, as a threat to answer. */
  enemyBoardValue: z.number().default(1),
  /** Extra value of a unit that is ready and can therefore block. */
  readyBlockerValue: z.number().default(0.8),

  /* ---------------------------------------------------------------- combat */
  /** Multiplier on damage we expect to push through to a player this combat. */
  attackFaceDamage: z.number().default(1.4),
  /** Multiplier on the board value of opposing units our attack kills. */
  attackTradeGain: z.number().default(1),
  /** Multiplier on the board value of our own units an attack loses. */
  attackTradeLoss: z.number().default(1.3),
  /** One-off bonus for an attack that can reduce an opponent to zero Health. */
  lethalBonus: z.number().default(1000),
  /**
   * Cost of exhausting one attacker. Only applied when the rules configuration
   * says exhausted units may *not* block — otherwise attacking costs no defence.
   */
  attackExhaustCost: z.number().default(0.4),
  /** Multiplier on damage prevented by blocking. */
  blockDamagePrevented: z.number().default(1),
  /** Multiplier on the board value of attackers our blocks kill. */
  blockTradeGain: z.number().default(1),
  /** Multiplier on the board value of our own blockers that die. */
  blockTradeLoss: z.number().default(1.2),
  /**
   * How urgently incoming lethal must be answered. Multiplies prevented damage
   * when the unblocked total would otherwise kill us.
   */
  survivalUrgency: z.number().default(50),
  /** Extra weight on our own remaining Health, as a resource worth protecting. */
  ownHealthValue: z.number().default(0.5),

  /* ------------------------------------------------------------- targeting */
  /** Bias toward hitting the opponent with the least remaining Health. */
  focusLowestHealth: z.number().default(1),
  /** Bias toward hitting the opponent with the strongest board. */
  focusBiggestBoard: z.number().default(0),

  /* --------------------------------------------------------------- choices */
  /**
   * Value of answering "yes" to a `confirm` choice.
   *
   * A confirm has no entity behind it, so the intent/ownership reasoning every
   * other choice uses has nothing to read. Both confirms the engine asks are
   * upside for the player being asked — carrying out a step of your own card,
   * or paying to save one an opponent is countering — and the engine never asks
   * when the answer could not be paid, so the default leans yes. It is a weight
   * rather than a constant because "how eager is a pilot to take an optional
   * line" is exactly the kind of dial a perturbation run should be able to move.
   */
  confirmYes: z.number().default(1.2),

  /* -------------------------------------------------------------- mulligan */
  /** Value of one card kept in the opening hand that costs at most `curveTop`. */
  openingCheapCard: z.number().default(1),
  /** Penalty per opening card costing more than `curveTop`. */
  openingExpensiveCard: z.number().default(0.9),
  /** Highest cost still considered "castable early" for mulligan purposes. */
  curveTop: z.number().default(3),
  /** Flat penalty for using the redraw at all, per card returned. */
  redrawPenalty: z.number().default(0.15),

  /* ------------------------------------------------------------ tie-breaks */
  /**
   * Scores within this distance count as equal, and the pilot's own RNG picks
   * between them. Keeps a pilot from being decided by float noise.
   */
  tieEpsilon: z.number().min(0).default(1e-9),
  /** Score assigned to `pass_phase`; every other action is measured against it. */
  passBaseline: z.number().default(0),
});

export type BotWeights = z.infer<typeof botWeightsSchema>;
export type BotWeightsInput = z.input<typeof botWeightsSchema>;

export const DEFAULT_WEIGHTS: BotWeights = Object.freeze(botWeightsSchema.parse({}));

export function parseWeights(input: unknown): BotWeights {
  return botWeightsSchema.parse(input ?? {});
}

/* ------------------------------------------------------------ view helpers */

export function summaryOf(view: PlayerView, playerId: string): PlayerViewSummary | undefined {
  return view.players.find((player) => player.playerId === playerId);
}

export function selfSummary(view: PlayerView): PlayerViewSummary {
  const summary = summaryOf(view, view.viewerId);
  if (!summary) throw new Error(`Player view for "${view.viewerId}" has no own summary.`);
  return summary;
}

/** Living opponents, in stable seat order. */
export function opponentSummaries(view: PlayerView): PlayerViewSummary[] {
  return view.players.filter((player) => player.playerId !== view.viewerId && !player.lost);
}

export function unitViewsOf(view: PlayerView, playerId: string): CardInstanceView[] {
  const summary = summaryOf(view, playerId);
  if (!summary) return [];
  const units: CardInstanceView[] = [];
  for (const instanceId of summary.units) {
    if (instanceId === null) continue;
    const instance = view.instances[instanceId];
    if (instance) units.push(instance);
  }
  return units;
}

/** Health a unit has left before it is defeated. */
export function remainingHealthOf(unit: CardInstanceView): number {
  return unit.health - unit.markedDamage;
}

/* ------------------------------------------------------- keyword valuation */

/**
 * Whether a pilot may pay for this keyword at all, read off the mechanic support
 * registry (M05.2).
 *
 * A keyword classified `engine: 'none'` is authored, filterable, printed and
 * deliberately inert — it changes nothing about how the game plays. Paying the
 * flat `keywordBonus` for one is not a rounding error but a false claim: it
 * makes a card carrying it look strictly better than the same card without one,
 * so a pilot mulligans toward it and protects it in combat, and a balance run
 * then reports the difference as a property of the card rather than of the
 * scorer. `resilient` is the only current member and the reason this exists
 * (Q4).
 *
 * Derived rather than listed, so implementing a keyword switches its valuation
 * on in the same change that switches its behaviour on, and this module and the
 * registry cannot drift apart.
 */
export function keywordIsValued(keyword: KeywordId): boolean {
  return mechanicSupport({ kind: 'keyword', id: keyword }).engine === 'full';
}

/** What one keyword is worth, or zero when the engine does not execute it. */
function keywordValue(keyword: KeywordId, weights: BotWeights): number {
  return keywordIsValued(keyword) ? weights.keywordBonus : 0;
}

/** What a keyword list is worth, inert members excluded. */
function keywordsValue(keywords: readonly KeywordId[], weights: BotWeights): number {
  return keywords.reduce((sum, keyword) => sum + keywordValue(keyword, weights), 0);
}

/* --------------------------------------------------------- card valuation */

/**
 * Rough value of one effect instruction, from the acting player's point of view.
 *
 * Deliberately coarse: it exists so a pilot prefers "draw two" to "draw one" and
 * prefers removal to a small buff, not to predict resolution exactly. Effects
 * whose value genuinely depends on board state are handled by the callers that
 * have that state.
 */
/**
 * How much of a modifier's value survives its duration.
 *
 * `permanent` is the yardstick. `end_of_turn` is worth roughly half, because it
 * buys one turn of tempo and nothing after it. `while_source_present` sits
 * between the two: it lasts indefinitely, but only while the granting card is
 * on the battlefield, so an opponent holding removal can end it — which is a
 * real discount now that the duration actually expires rather than quietly
 * behaving as `permanent` (readiness gate B1).
 *
 * Coarse on purpose, and hard-coded for the same reason the rest of
 * `effectValue` is: these are shape factors, not tunable balance. The named
 * `BotWeights` remain the tunable surface.
 */
function durationScale(duration: Duration): number {
  switch (duration) {
    case 'permanent':
      return 1;
    case 'while_source_present':
      return 0.8;
    case 'until_your_next_turn':
      // Above `end_of_turn` because it covers the opponents' turns in between,
      // which is when a defensive buff actually has to hold; below `permanent`
      // for the same reason `end_of_turn` is — it buys a round, not a board.
      return 0.65;
    case 'end_of_turn':
      return 0.5;
    case 'end_of_combat':
      // The narrowest boundary in the vocabulary: one combat, and usually only
      // the half of it the granting card was played into. Priced below
      // `end_of_turn`, which at least survives to the second Main Phase.
      return 0.35;
  }
}

/**
 * What a dynamic amount is worth to a pilot deciding whether to play a card.
 *
 * `effectValue` prices a card *in the abstract* — it is used to rank a hand
 * before anything is on the board — so it cannot ask the board how many Goblins
 * are out. It has to assume something, and the honest assumption is a small
 * number rather than zero or a fantasy: zero would make "deal damage equal to
 * the number of Goblins you control" look like a blank card and get it
 * mulliganed away, and a large guess would make it look unconditionally strong.
 *
 * Two boards' worth of matches, capped by whatever ceiling the card prints, is
 * the estimate. Callers that *do* have the board — the ones scoring a specific
 * decision — should evaluate the count for real instead.
 */
const ASSUMED_MATCH_COUNT = 2;

/**
 * The statline a derived value is assumed to read, for the same reason.
 *
 * "Gains Health equal to its ATK" is worth whatever the unit it lands on has,
 * and a pilot ranking a hand does not know which unit that will be. Three is a
 * middling Wave 1 ATK — enough that a card built around the clause does not read
 * as blank, not so much that it reads as a finisher (M02.3).
 */
const ASSUMED_STAT = 3;

function estimateValue(value: ValueExpression | SignedValueExpression): number {
  if (typeof value === 'number') return value;
  const sign = 'sign' in value ? value.sign : 1;
  const raw =
    value.kind === 'stat'
      ? sign * ASSUMED_STAT + value.plus
      : value.kind === 'previous_targets'
        ? // How many things the step before it will act on is exactly the sort of
          // board question `effectValue` cannot ask, so it takes the same
          // middling assumption every other unknown count takes (M02.5).
          sign * ASSUMED_MATCH_COUNT + value.plus
        : sign * Math.floor(ASSUMED_MATCH_COUNT / value.per) + value.plus;
  const capped = value.maximum === undefined ? raw : Math.min(raw, value.maximum);
  return Math.max(value.minimum, capped);
}

/**
 * How much a condition discounts an instruction.
 *
 * A gated instruction may simply not happen, and a pilot that priced it as
 * certain would overpay for every "if" card in the pool. Flat rather than
 * clever: predicting whether a board condition will hold is exactly the kind of
 * guess this scorer is documented not to make.
 */
const CONDITION_DISCOUNT = 0.6;

/**
 * How much of a delayed effect's value survives the delay.
 *
 * A `schedule_delayed` is worth what its body is worth, discounted twice over:
 * the instructions land later in the turn, and — when the entry is a watch — may
 * never land at all, because the card it is about has to be defeated first. A
 * pilot that priced a delayed clause as an immediate one would over-pay for
 * every card carrying one; pricing it at zero would make the delayed half
 * invisible and mulligan the card away.
 *
 * Coarse and hard-coded, exactly like `durationScale` beside it: these are
 * shape factors, not tunable balance.
 */
const DELAYED_BOUNDARY_SCALE = 0.5;
const DELAYED_WATCH_SCALE = 0.35;

/**
 * What is left of a symmetrical effect once both sides have paid it.
 *
 * An "each player sacrifices one" costs us the same thing it costs an opponent,
 * so most of its value cancels. The remainder is real but small — we pick the
 * moment, and we are the one holding the card — and it is a coarse shape factor
 * exactly like the two scales above, not a tunable balance number.
 */
const SYMMETRIC_EFFECT_EDGE = 0.25;

export function effectValue(
  effect: EffectDefinition,
  weights: BotWeights,
  database: CardDatabase,
  /** The card's delayed bodies, so `schedule_delayed` can be priced honestly. */
  delayedAbilities: readonly DelayedAbilityDefinition[] = [],
): number {
  const gross = ungatedEffectValue(effect, weights, database, delayedAbilities);
  // An optional instruction is *not* discounted, and the asymmetry with
  // `condition` is deliberate. A condition may fail against the player; a "you
  // may" cannot, because the player is the one answering it and will say no
  // whenever the step would hurt them. Discounting it would make every card
  // carrying an upside clause look worse than the same card without one.
  return effect.condition ? gross * CONDITION_DISCOUNT : gross;
}

/**
 * How many members a plural selector is assumed to reach.
 *
 * `count: 'all'` names whatever is on the battlefield when the instruction
 * resolves, and `effectValue` prices a card before there is a board to look at.
 * The same middling assumption every other unknown count takes.
 */
const ASSUMED_TARGET_COUNT = 2;

function targetCount(count: number | 'all'): number {
  return count === 'all' ? ASSUMED_TARGET_COUNT : count;
}

/**
 * How often a "unless its controller pays N" counter is assumed to resolve as a
 * counter rather than as a tax. An even split: predicting whether an opponent
 * can afford the tax is exactly the board reading this scorer does not do.
 */
const SOFT_COUNTER_ODDS = 0.5;

/** Everything a pricer needs beyond the instruction it is pricing. */
interface PricingContext {
  readonly weights: BotWeights;
  readonly database: CardDatabase;
  /** The card's delayed bodies, so `schedule_delayed` can price its own body. */
  readonly delayedAbilities: readonly DelayedAbilityDefinition[];
}

/** Prices one named member of the instruction vocabulary. */
type EffectPricer<K extends EffectType> = (
  effect: Extract<EffectDefinition, { type: K }>,
  ctx: PricingContext,
) => number;

/**
 * The instruction pricing table (M05.2).
 *
 * A total `Record` over `EffectType` rather than a `switch` with a `default: 0`,
 * and the difference is the point of this tranche. The old switch answered "how
 * much is this worth" with zero for anything nobody had thought about, and a
 * zero there is indistinguishable from a deliberate "this is worth nothing" —
 * which is how `counter` came to be priced as a blank card for the entire life
 * of the Reaction mechanic without a single test noticing. Here a new
 * instruction type is a **compile error** until somebody prices it, and
 * `effectPricingGaps` makes the same check at runtime for the JSON-driven paths
 * that never see the type.
 *
 * Deliberately shaped like `@tcg/card-data`'s support registry: same totality
 * guarantee, read off the same schema-derived vocabulary.
 */
const EFFECT_PRICERS: { readonly [K in EffectType]: EffectPricer<K> } = {
  draw: (effect, { weights }) =>
    (effect.player === 'self' ? 1 : -1) * weights.cardDraw * estimateValue(effect.amount),

  discard: (effect, { weights }) =>
    (effect.player === 'self' ? -1 : 1) * weights.discardCard * estimateValue(effect.amount),

  deal_damage: (effect, { weights }) => {
    if (effect.target.kind === 'player') {
      return (
        (effect.target.relation === 'self' ? -1 : 1) *
        weights.faceDamage *
        estimateValue(effect.amount)
      );
    }
    if (effect.target.kind === 'players') {
      return weights.faceDamage * estimateValue(effect.amount);
    }
    if (effect.target.kind !== 'entity' && effect.target.kind !== 'entity_or_player') {
      // `source` and `trigger_subject` both aim at a card on our own side.
      return -weights.unitDamage * estimateValue(effect.amount);
    }
    const selector = effect.target.selector;
    // A pool that includes players is priced off the entity half's controller
    // like any other. Falling through to the "aims at our own card" branch above
    // would have priced "divide it among enemy Units and opponents" as a
    // drawback, which is the wrong sign rather than the wrong magnitude.
    const sign = selector.controller === 'self' ? -1 : 1;
    // A divided amount is a *total* split across the set, not an amount each
    // member takes, so it must not be multiplied by the size of the set — that
    // would price "divide five damage" as five damage to every target (M02.5).
    const reach = effect.divided === true ? 1 : targetCount(selector.count);
    return sign * weights.unitDamage * estimateValue(effect.amount) * reach;
  },

  heal: (effect, { weights }) => {
    if (effect.target.kind === 'player') {
      return (
        (effect.target.relation === 'self' ? 1 : -1) *
        weights.healing *
        estimateValue(effect.amount)
      );
    }
    if (effect.target.kind === 'players') return 0;
    return weights.healing * estimateValue(effect.amount);
  },

  modify_stats: (effect, { weights }) => {
    const magnitude = estimateValue(effect.attack) + estimateValue(effect.health);
    const sign =
      effect.target.kind === 'entity' && effect.target.selector.controller === 'opponent' ? -1 : 1;
    return sign * weights.buffValue * magnitude * durationScale(effect.duration);
  },

  // Granting a keyword the engine never reads changes nothing about the game, so
  // it is worth nothing however long it lasts (M05.2).
  grant_keyword: (effect, { weights }) =>
    keywordValue(effect.keyword, weights) * durationScale(effect.duration),

  remove_keyword: (effect, { weights }) => {
    // Taking a keyword *off* one of our own units is a drawback, not a gain. The
    // old pricing returned the same positive number either way, which made "this
    // Unit loses Guardian" read as an upside on the card that prints it.
    const ours =
      effect.target.kind !== 'entity' || effect.target.selector.controller !== 'opponent';
    return (
      (ours ? -1 : 1) * keywordValue(effect.keyword, weights) * 0.5 * durationScale(effect.duration)
    );
  },

  create_token: (effect, { weights, database }) => {
    const token = database.get(effect.tokenCardId);
    const body = token
      ? (token.attack ?? 0) * weights.unitAttack +
        (token.health ?? 0) * weights.unitHealth +
        keywordsValue(token.keywords, weights)
      : 1;
    return weights.tokenValue * body * estimateValue(effect.amount);
  },

  destroy: (effect, { weights }) => {
    const selector = effect.target.kind === 'entity' ? effect.target.selector : null;
    // `source` and `trigger_subject` both point at one of our own cards, so
    // destroying through either is a cost, not a gain.
    const sign = selector === null || selector.controller === 'self' ? -1 : 1;
    const count = selector === null ? 1 : targetCount(selector.count);
    return sign * weights.removalBonus * count;
  },

  sacrifice: (effect, { weights }) => {
    const selector = effect.target.kind === 'entity' ? effect.target.selector : null;
    // "Each player sacrifices one" is not a self-cost: we give one up and so
    // does every opponent, and everybody gives up their worst. What is left over
    // is the tempo of choosing when it happens, which is small but real —
    // pricing it as a pure cost would make the pilot mulligan a symmetrical
    // removal spell away (M02.5).
    if (selector !== null && isDistributedSelection(selector)) {
      return weights.removalBonus * 0.6 * SYMMETRIC_EFFECT_EDGE;
    }
    return -weights.removalBonus * 0.6;
  },

  return_to_hand: (effect, { weights }) => {
    const ours = effect.target.kind !== 'entity' || effect.target.selector.controller === 'self';
    return (ours ? -0.2 : 1) * weights.bounceValue;
  },

  search_zone: (effect, { weights }) => weights.cardDraw * effect.amount * 1.1,

  reorder_zone: (_effect, { weights }) => weights.cardDraw * 0.25,

  modify_cost: (effect, { weights }) =>
    effect.player === 'self'
      ? -effect.delta * weights.energyEfficiency * durationScale(effect.duration)
      : 0,

  prevent_damage: (effect, { weights }) =>
    weights.preventionValue * estimateValue(effect.amount) * durationScale(effect.duration),

  exhaust: (_effect, { weights }) => weights.tapValue,

  ready: (_effect, { weights }) => weights.tapValue,

  skip_next_ready: (effect, { weights }) => {
    // Costing a unit its next Ready Step is worth more than exhausting it now:
    // the exhaustion it enforces lasts a whole turn cycle rather than until the
    // owner's next untap. Aimed at one of our own cards it is a drawback.
    const ours =
      // `blocked_by_source` names the attackers we blocked, so it is always
      // aimed at somebody else's units however the rest of the card reads.
      effect.target.kind !== 'blocked_by_source' &&
      (effect.target.kind !== 'entity' || effect.target.selector.controller === 'self');
    const count = effect.target.kind === 'entity' ? targetCount(effect.target.selector.count) : 1;
    return (ours ? -1 : 1) * weights.tapValue * 1.5 * count;
  },

  move_card: (effect, { weights }) => {
    const selector = effect.target.kind === 'entity' ? effect.target.selector : null;
    const count = selector === null ? 1 : targetCount(selector.count);
    // Putting a card onto the battlefield is worth more than moving one: the
    // card arrives in play without being paid for. *Which* card cannot be known
    // from the definition — it is whatever is in the pile at the time — so it is
    // priced as a card gained, a little above a draw, and a pilot that cannot
    // see anything to bring back is corrected where it can see the board rather
    // than here (see `emptySourceZonePenalty`).
    if (effect.toZone === 'battlefield') return weights.cardDraw * count * 1.2;
    // Removing a card from the game. One of ours is a small price paid for
    // whatever else the instruction list does; one of theirs denies them the
    // card outright, which is worth about what making them discard it is.
    if (effect.toZone === 'removed') {
      const ours = selector === null || selector.controller === 'self';
      return ours ? -weights.cardDraw * 0.2 * count : weights.discardCard * count;
    }
    return weights.cardDraw * 0.3;
  },

  schedule_delayed: (effect, ctx) => {
    const ability = ctx.delayedAbilities.find((entry) => entry.id === effect.delayedAbilityId);
    // An unresolvable reference cannot happen on validated card data, and a
    // caller that did not pass the card's delayed list gets zero rather than an
    // invented number.
    if (!ability) return 0;
    const scale = ability.trigger === undefined ? DELAYED_BOUNDARY_SCALE : DELAYED_WATCH_SCALE;
    // Nested one level only — the schema forbids a delayed body scheduling
    // another — so this cannot recur.
    return effectsValue(ability.effects, ctx.weights, ctx.database) * scale;
  },

  /**
   * Countering the card the window named (M05.2).
   *
   * Priced in the abstract, because `effectValue` ranks a card before any window
   * exists: the thing this answers has not been played yet. `scoreReaction` is
   * where the estimate is swapped for the value of the card actually on the
   * stack, so this number decides whether a pilot *keeps* a counter and never
   * whether it spends one.
   *
   * `unlessPays` softens it. Either the controller declines and the card is
   * countered outright, or they pay and we bought that much Energy off their
   * turn instead — so it is priced as an even split between the two outcomes
   * rather than as a hard counter. The paid branch is capped at the value of the
   * counter itself, because the branch is *their* choice: a controller who would
   * rather lose the card than pay the tax simply lets it be countered, so a tax
   * can never be worth more to us than countering outright however large the
   * schema lets it be printed. Coarse and hard-coded like `durationScale` above
   * it; `counterValue` is the tunable surface.
   */
  counter: (effect, { weights }) => {
    if (effect.unlessPays === 0) return weights.counterValue;
    const taxed = Math.min(weights.energyEfficiency * effect.unlessPays, weights.counterValue);
    return SOFT_COUNTER_ODDS * weights.counterValue + (1 - SOFT_COUNTER_ODDS) * taxed;
  },
};

/**
 * Runtime twin of the type-level totality check on `EFFECT_PRICERS`.
 *
 * The mapped type already fails a build that adds an instruction without pricing
 * it. This catches the other direction — a pricer for an instruction the schema
 * no longer has — and gives the JSON-driven paths, which never see the type, the
 * same guarantee. Returns the problems rather than throwing so a caller can
 * report all of them at once, exactly like `supportRegistryGaps` beside it.
 */
export function effectPricingGaps(): string[] {
  const problems: string[] = [];
  const priced = new Set<string>(Object.keys(EFFECT_PRICERS));
  for (const type of EFFECT_TYPES) {
    if (!priced.has(type)) problems.push(`effect:${type} is in the schema but is not priced.`);
  }
  for (const type of priced) {
    if (!(EFFECT_TYPES as readonly string[]).includes(type)) {
      problems.push(`effect:${type} is priced but is not in the schema.`);
    }
  }
  return problems;
}

function ungatedEffectValue(
  effect: EffectDefinition,
  weights: BotWeights,
  database: CardDatabase,
  delayedAbilities: readonly DelayedAbilityDefinition[],
): number {
  // The one cast in the module. Indexing a mapped type with a union key yields a
  // union of function types, which TypeScript will not call even though every
  // member accepts exactly the variant its own key selects; the mapped type is
  // what makes that safe.
  const pricer = EFFECT_PRICERS[effect.type] as EffectPricer<EffectType>;
  return pricer(effect, { weights, database, delayedAbilities });
}

export function effectsValue(
  effects: readonly EffectDefinition[],
  weights: BotWeights,
  database: CardDatabase,
  delayedAbilities: readonly DelayedAbilityDefinition[] = [],
): number {
  return effects.reduce(
    (sum, effect) => sum + effectValue(effect, weights, database, delayedAbilities),
    0,
  );
}

/* ---------------------------------------------------- continuous abilities */

/**
 * How many recipients a board-wide continuous scope is assumed to reach.
 *
 * A lord's aura is worth what it buffs, and how much that is depends on a board
 * `cardValue` has not been shown — it ranks a card in the abstract, for a
 * mulligan or a discard, before anything is in play. Two units is the same
 * middling assumption `ASSUMED_MATCH_COUNT` and `ASSUMED_TARGET_COUNT` make, and
 * for the same reason: zero would read a lord as a vanilla body, and a large
 * guess would read every lord as a finisher.
 */
const ASSUMED_SCOPE_UNITS = 2;

/**
 * What is left of a scope once a filter narrows it.
 *
 * "Your Goblins get +1/+1" reaches fewer cards than "your Units get +1/+1", and
 * how many fewer is a deck question this module cannot answer. A flat discount
 * is enough to keep the tribal lord below the unconditional one, which is the
 * ordering that has to hold.
 */
const FILTERED_SCOPE_SCALE = 0.6;

/**
 * How many cards a continuous ability is assumed to apply to.
 *
 * The "scope" and "affected board" half of M05.2: an ability that reaches only
 * the card it is printed on is worth a fraction of one that reaches a board, and
 * the old `staticAbilities.length × buffValue × 2` proxy could not tell the two
 * apart.
 */
function scopeReach(scope: ContinuousScope): number {
  // "**This card** costs 1 less …" — one recipient, known exactly.
  if (scope.onlySource === true) return 1;
  const base = ASSUMED_SCOPE_UNITS;
  return scope.filter === undefined ? base : base * FILTERED_SCOPE_SCALE;
}

/**
 * Which side of the table a continuous ability lands on.
 *
 * `self` is ours and `opponent` is theirs, so a *negative* modifier aimed at
 * opponents comes out positive and a buff handed to opponents comes out
 * negative — the sign falls out of the arithmetic rather than being special-
 * cased per effect. `any` is symmetrical: it applies to everybody's cards, most
 * of its value cancels, and what is left is the edge of having chosen the moment
 * — the same reading `sacrifice` already gives a distributed selector.
 */
function scopeSign(controller: Controller): number {
  switch (controller) {
    case 'self':
      return 1;
    case 'opponent':
      return -1;
    case 'any':
      return SYMMETRIC_EFFECT_EDGE;
  }
}

/**
 * What one continuous ability is worth.
 *
 * Every branch reads magnitude, scope, duration and the side of the board it
 * lands on (M05.2). The two standing-layer effects used to be priced as a flat
 * `2 × buffValue` each — the same number for "+1/+0 to your Goblins" and
 * "+3/+3 to every Unit you control" — which is the array-length proxy this
 * tranche exists to remove.
 *
 * The duration is the same for every continuous ability and it is not
 * `permanent`: a derived layer lasts exactly as long as its source stays where
 * its `activeZone` says, so it is priced as `while_source_present`, which is the
 * discount `effectValue` already applies to a source-bound instruction.
 * `replace_arrival`'s granted keyword is the exception — what it hands out
 * carries its own printed duration and outlives the arrival it rewrote.
 */
function staticAbilityValue(ability: StaticAbilityDefinition, weights: BotWeights): number {
  const sign = scopeSign(ability.affects.controller);
  const reach = scopeReach(ability.affects);
  const standing = durationScale('while_source_present');
  // "**While this Unit is Ready**, …". A gate that can be false is worth less
  // than one that cannot, for the same reason a gated instruction is.
  const gate = ability.sourceState === undefined ? 1 : CONDITION_DISCOUNT;

  const effect = ability.effect;
  switch (effect.type) {
    case 'modify_stats':
      return sign * weights.buffValue * (effect.attack + effect.health) * reach * standing * gate;

    case 'grant_keyword':
      return sign * keywordValue(effect.keyword, weights) * reach * standing * gate;

    case 'reaction_discount':
      // Energy, not board presence. `first_each_turn` is the printed default and
      // reaches one Reaction a turn where `unlimited` reaches every one of them.
      return (
        weights.energyEfficiency *
        effect.amount *
        (effect.limit === 'first_each_turn' ? 0.5 : 1) *
        gate
      );

    case 'cost_reduction':
      // Also energy. `scopeReach` is what separates "**this card** costs 1 less"
      // from a discount on everything in hand.
      return weights.energyEfficiency * estimateValue(effect.amount) * reach * gate;

    case 'replace_arrival': {
      // Two different cards wear this shape and they are worth opposite things.
      // Rewriting an *opponent's* arrival to be Exhausted is tempo denial, worth
      // about what exhausting a unit is; handing your own arrivals a keyword is
      // a buff, and it keeps its own printed duration because the keyword
      // outlives the arrival that granted it.
      const denial = effect.entersExhausted === true ? -sign * weights.tapValue : 0;
      const granted =
        effect.grantKeyword === undefined
          ? 0
          : sign * keywordValue(effect.grantKeyword, weights) * durationScale(effect.grantDuration);
      // "The **first** … each turn" rewrites one arrival rather than all of them.
      const throttle = effect.limit === 'first_each_turn' ? 0.5 : 1;
      return (denial + granted) * reach * throttle * gate;
    }

    case 'replace_ready':
      // Keeping an enemy unit Exhausted through its Ready Step is worth more than
      // exhausting one during a turn — it costs the opponent a whole turn of that
      // unit — but it is paid for, so the Energy comes back off.
      return (
        (-sign * weights.tapValue * 1.5 * (effect.limit === 'first_each_turn' ? 0.5 : 1) -
          weights.energyEfficiency * effect.energyCost) *
        gate
      );
  }
}

/**
 * What a card's continuous abilities are worth.
 *
 * `activeZone` narrows the sum to the abilities that are switched on where the
 * card currently is. A cost reduction is worth nothing to a unit already
 * standing on the battlefield: its own `activeZone` is the hand, and the
 * discount was spent to get it there.
 */
function staticAbilitiesValue(
  definition: CardDefinition,
  weights: BotWeights,
  activeZone?: ZoneId,
): number {
  return definition.staticAbilities.reduce((sum, ability) => {
    if (activeZone !== undefined && ability.activeZone !== activeZone) return sum;
    return sum + staticAbilityValue(ability, weights);
  }, 0);
}

/* ------------------------------------------------------------------- costs */

/**
 * What paying one cost is worth — always a number a caller adds, so always
 * negative or zero.
 *
 * Shared by the two places a cost is paid, and that sharing is the fix (M05.2):
 * `scoreActivate` had its own private copy of this switch, so an *additional*
 * cost on a played card — "as an additional cost, sacrifice a Unit" — was priced
 * by nobody at all and `cardValue` read those cards as free.
 *
 * Energy is discounted hard against the rest. A pilot only ever sees an action
 * it can already afford, so the Energy is a real but weak signal about whether
 * spending it here is right; a discarded card or a sacrificed Unit is a
 * resource gone whatever else happens.
 */
export function costValue(cost: AbilityCost, weights: BotWeights): number {
  switch (cost.type) {
    case 'energy':
      return -weights.energyEfficiency * cost.amount * 0.2;
    case 'discard':
      return -weights.discardCard * cost.amount;
    case 'sacrifice':
      return -weights.removalBonus * cost.amount;
    case 'exhaust_source':
      return -weights.readyBlockerValue;
  }
}

/** What a whole cost list is worth. Zero for a free ability or a free card. */
export function costsValue(costs: readonly AbilityCost[], weights: BotWeights): number {
  return costs.reduce((sum, cost) => sum + costValue(cost, weights), 0);
}

/**
 * Intrinsic value of holding or playing a card, ignoring board context.
 *
 * Used for mulligan decisions, for discard and sacrifice selection, and as the
 * base term when deciding what to play.
 */
export function cardValue(
  definition: CardDefinition,
  weights: BotWeights,
  database: CardDatabase,
): number {
  const body =
    (definition.attack ?? 0) * weights.unitAttack +
    (definition.health ?? 0) * weights.unitHealth +
    keywordsValue(definition.keywords, weights);

  const delayed = definition.delayedAbilities;
  const text =
    effectsValue(definition.effects, weights, database, delayed) +
    definition.abilities.reduce(
      (sum, ability) => sum + effectsValue(ability.effects, weights, database, delayed) * 0.7,
      0,
    ) +
    definition.activatedAbilities.reduce(
      // Net, then discounted: what an activation is worth is what it does *less*
      // what it charges, and the whole ability is halved because a card in hand
      // may never get to use it. Pricing only the upside made "sacrifice a Unit:
      // draw a card" read as "draw a card", which is the same defect the
      // additional-cost line below fixes for a played card (M05.2).
      (sum, ability) =>
        sum +
        (effectsValue(ability.effects, weights, database, delayed) +
          costsValue(ability.costs, weights)) *
          0.5,
      0,
    ) +
    staticAbilitiesValue(definition, weights);

  const chassis = definition.type === 'relic' ? weights.relicBase : 0;
  // "**As an additional cost**, sacrifice a Unit." Charged here because it is
  // paid to play the card at all — and because nothing else charged it: the
  // activated-ability path had its own private cost switch, so a Spell with an
  // additional cost read to every pilot as though it were free (M05.2).
  const price = costsValue(definition.additionalCosts, weights);
  return body + text + chassis + price;
}

/**
 * Value of a unit as it currently stands on the battlefield.
 *
 * Uses derived Attack/Health from the view rather than printed stats, so a
 * buffed or damaged unit is valued as it actually is.
 */
export function unitBoardValue(
  unit: CardInstanceView,
  weights: BotWeights,
  database: CardDatabase,
): number {
  const definition = database.get(unit.definitionId);
  const base =
    unit.attack * weights.unitAttack +
    Math.max(0, remainingHealthOf(unit)) * weights.unitHealth +
    keywordsValue(unit.keywords, weights);
  const text = definition
    ? definition.abilities.reduce(
        (sum, ability) =>
          sum + effectsValue(ability.effects, weights, database, definition.delayedAbilities) * 0.5,
        0,
      ) + staticAbilitiesValue(definition, weights, 'battlefield')
    : 0;
  const ready = unit.exhausted ? 0 : weights.readyBlockerValue;
  return base + text + ready;
}

/** Total board value a player controls, from the scorer's point of view. */
export function boardValueOf(
  view: PlayerView,
  playerId: string,
  weights: BotWeights,
  database: CardDatabase,
): number {
  return unitViewsOf(view, playerId).reduce(
    (sum, unit) => sum + unitBoardValue(unit, weights, database),
    0,
  );
}

/**
 * How attractive an opponent is as a target, given the pilot's focus weights.
 * Higher is more attractive.
 */
export function opponentPriority(
  view: PlayerView,
  opponent: PlayerViewSummary,
  weights: BotWeights,
  database: CardDatabase,
): number {
  const health = opponent.health;
  const board = boardValueOf(view, opponent.playerId, weights, database);
  return weights.focusLowestHealth * -health + weights.focusBiggestBoard * board;
}

/* ------------------------------------------------------------ combat model */

export interface CombatOutcome {
  /** Damage reaching the defending player after blocks. */
  readonly faceDamage: number;
  /** Attackers expected to die. */
  readonly attackersLost: readonly string[];
  /** Blockers expected to die. */
  readonly blockersLost: readonly string[];
}

/**
 * How much of the real damage step the hypothetical combat reproduces (M09.14).
 *
 * Every field is off in `BASELINE_COMBAT_MODEL`, which is the model that shipped
 * before M09.14 and the one Normal and Easy still use. A profile turns one on
 * because leaving it off is *wrong* rather than merely coarse — both members
 * below are shipped keywords the model silently ignored — and the switch exists
 * so that improving Hard cannot move Normal.
 */
export interface CombatModel {
  /** An unspent Barrier prevents the whole of the first damage event. */
  readonly barrier: boolean;
  /** A blocked Overwhelm attacker's excess still reaches the defending player. */
  readonly overwhelm: boolean;
}

export const BASELINE_COMBAT_MODEL: CombatModel = Object.freeze({
  barrier: false,
  overwhelm: false,
});

/**
 * Whether a unit's Barrier is still there to spend.
 *
 * Two questions, and the view answers both separately: `keywords` says the unit
 * *has* Barrier, `barrierSpent` says whether this combat is the one that eats it
 * (M06.1). Both are public board facts for every seat, so reading them is not a
 * disclosure.
 */
function barrierIsUp(unit: CardInstanceView): boolean {
  return unit.keywords.includes('barrier') && !unit.barrierSpent;
}

/**
 * Whether `attacker` dealing its damage would defeat `defender` this combat.
 *
 * `model` defaults to the baseline, so every existing caller keeps the exact
 * comparison it had. With `barrier` on, a defender whose Barrier is unspent
 * survives — the engine prevents the whole of the first non-zero damage event,
 * including a `venom` one, because prevention happens before the lethal flag is
 * read (`damage.ts`).
 */
export function wouldDefeat(
  attacker: CardInstanceView,
  defender: CardInstanceView,
  model: CombatModel = BASELINE_COMBAT_MODEL,
): boolean {
  if (model.barrier && attacker.attack > 0 && barrierIsUp(defender)) return false;
  if (attacker.keywords.includes('venom') && attacker.attack > 0) return true;
  return attacker.attack >= remainingHealthOf(defender);
}

export interface GreedyBlockOptions {
  readonly chumpBlock: boolean;
  readonly valueOnly: boolean;
  /**
   * Rank the eligible blockers by what the defender keeps, rather than taking
   * the first one that does any job at all (M09.14).
   *
   * Off by default, which is the pairing that shipped: the blockers are already
   * sorted smallest-first, so `findIndex` takes the smallest body that kills
   * *or* survives — and "kills" comes up first for a small attacker, which is
   * how a 2/1 ends up in front of a 3/2 that a 2/5 would have eaten and
   * survived. That is the M05.6 blocking finding, and it is a defect in this
   * pairing rather than in the score attached to it.
   *
   * On, the preference is: a blocker that survives *and* kills, then one that
   * survives, then one that only kills — with the existing smallest-first order
   * breaking ties inside each band, so the defender still does not spend a
   * bigger body than the job needs. It changes which plan is *offered*; the
   * scorer still decides between this plan and the trade.
   */
  readonly preserve?: boolean;
  /** How much of the damage step to reproduce. Baseline for every old caller. */
  readonly model?: CombatModel;
}

/**
 * How well a blocker answers this attacker, lowest is best.
 *
 * `3` means it neither kills nor survives, which `valueOnly` excludes outright.
 */
function blockRank(
  attacker: CardInstanceView,
  blocker: CardInstanceView,
  model: CombatModel,
): number {
  const kills = wouldDefeat(blocker, attacker, model);
  const survives = !wouldDefeat(attacker, blocker, model);
  if (survives && kills) return 0;
  if (survives) return 1;
  if (kills) return 2;
  return 3;
}

/**
 * How much of `unit` a single damage event of `amount` actually removes (M09.14).
 *
 * `1` when the damage defeats it, `0` when the damage is entirely prevented, and
 * the fraction of its remaining Health otherwise. This is what turns "aim
 * removal at the biggest body" into "aim removal at the body it removes": two
 * damage into a 2/5 removes two fifths of a 2/5, and two damage into a 2/1
 * removes the whole thing.
 *
 * Deliberately a fraction rather than a bonus. A bonus has no units and would
 * have to be re-tuned against every weight vector; a fraction of the body is the
 * same statement for all of them and cannot be out-scaled by a big statline.
 *
 * The Barrier case is only read when the model says to. It is `0` rather than a
 * small number because the engine prevents the *whole* of the first non-zero
 * damage event, so a Spell aimed at an unspent Barrier removes nothing at all.
 */
export function damageRemovalFraction(
  unit: CardInstanceView,
  amount: number,
  model: CombatModel = BASELINE_COMBAT_MODEL,
): number {
  if (amount <= 0) return 0;
  if (model.barrier && barrierIsUp(unit)) return 0;
  const remaining = remainingHealthOf(unit);
  if (remaining <= 0 || amount >= remaining) return 1;
  return amount / remaining;
}

/**
 * The greedy block the model assumes a rational defender makes: pair the
 * biggest incoming attacker with the blocker that answers it best.
 *
 * Used in two places — to predict what an opponent will do to our attack, and to
 * generate our own candidate blocks — so the attacker and the defender reason
 * about combat with the same model.
 */
export function greedyBlocks(
  attackers: readonly CardInstanceView[],
  blockers: readonly CardInstanceView[],
  options: GreedyBlockOptions,
): { attackerInstanceId: string; blockerInstanceId: string }[] {
  const model = options.model ?? BASELINE_COMBAT_MODEL;
  const remaining = [...blockers].sort((a, b) => {
    // Prefer the smallest blocker that still does the job, then a stable ID order.
    const health = remainingHealthOf(a) - remainingHealthOf(b);
    if (health !== 0) return health;
    if (a.attack !== b.attack) return a.attack - b.attack;
    return a.instanceId.localeCompare(b.instanceId);
  });

  const ordered = [...attackers].sort((a, b) => {
    if (b.attack !== a.attack) return b.attack - a.attack;
    return a.instanceId.localeCompare(b.instanceId);
  });

  const pairs: { attackerInstanceId: string; blockerInstanceId: string }[] = [];
  for (const attacker of ordered) {
    if (attacker.keywords.includes('evasive')) continue;
    const index = options.preserve
      ? bestBlockerIndex(attacker, remaining, options, model)
      : remaining.findIndex((blocker) => {
          if (options.valueOnly) return blockRank(attacker, blocker, model) < 3;
          return true;
        });
    if (index < 0) {
      if (!options.chumpBlock) continue;
      const fallback = remaining.shift();
      if (!fallback) break;
      pairs.push({
        attackerInstanceId: attacker.instanceId,
        blockerInstanceId: fallback.instanceId,
      });
      continue;
    }
    const [blocker] = remaining.splice(index, 1);
    if (!blocker) break;
    pairs.push({ attackerInstanceId: attacker.instanceId, blockerInstanceId: blocker.instanceId });
  }
  return pairs;
}

/**
 * The best-ranked blocker in `remaining`, or `-1` when none is eligible.
 *
 * `remaining` is already smallest-first, and the scan keeps the *first* blocker
 * of the best rank it finds, so the tie-break inside a band is the same
 * smallest-first order the unpreserved path uses.
 */
function bestBlockerIndex(
  attacker: CardInstanceView,
  remaining: readonly CardInstanceView[],
  options: GreedyBlockOptions,
  model: CombatModel,
): number {
  let bestIndex = -1;
  let bestRank = Infinity;
  for (const [index, blocker] of remaining.entries()) {
    const rank = blockRank(attacker, blocker, model);
    if (options.valueOnly && rank === 3) continue;
    if (rank < bestRank) {
      bestRank = rank;
      bestIndex = index;
    }
  }
  return bestIndex;
}

/**
 * Resolves a hypothetical combat under the simple simultaneous-damage rules.
 *
 * `quick_strike` is modelled: a quick-striking combatant that defeats its
 * opponent takes no damage back. `model` decides how much of the rest of the
 * damage step is reproduced; at the baseline nothing else is, which is where
 * this function stood before M09.14 and where Normal and Easy still stand.
 *
 * With `overwhelm` on, a blocked Overwhelm attacker's excess is added to the
 * face damage. The split follows the engine exactly (`combat.ts`): each blocker
 * absorbs its **current Health** rather than its remaining lethal requirement,
 * so damage already marked on a blocker does not widen the overflow, and Barrier
 * on the blocker never touches the overflow because that is a separate damage
 * event aimed at the player (ADR 0016 Q-D).
 */
export function resolveHypotheticalCombat(
  attackers: readonly CardInstanceView[],
  blocks: readonly { attackerInstanceId: string; blockerInstanceId: string }[],
  blockerLookup: ReadonlyMap<string, CardInstanceView>,
  model: CombatModel = BASELINE_COMBAT_MODEL,
): CombatOutcome {
  const blockedBy = new Map<string, CardInstanceView>();
  for (const block of blocks) {
    const blocker = blockerLookup.get(block.blockerInstanceId);
    if (blocker) blockedBy.set(block.attackerInstanceId, blocker);
  }

  let faceDamage = 0;
  const attackersLost: string[] = [];
  const blockersLost: string[] = [];

  for (const attacker of attackers) {
    const blocker = blockedBy.get(attacker.instanceId);
    if (!blocker) {
      faceDamage += attacker.attack;
      continue;
    }
    if (model.overwhelm && attacker.keywords.includes('overwhelm')) {
      faceDamage += Math.max(0, attacker.attack - blocker.health);
    }
    const attackerFirst =
      attacker.keywords.includes('quick_strike') && !blocker.keywords.includes('quick_strike');
    const blockerFirst =
      blocker.keywords.includes('quick_strike') && !attacker.keywords.includes('quick_strike');

    const attackerKills = wouldDefeat(attacker, blocker, model);
    const blockerKills = wouldDefeat(blocker, attacker, model);

    if (attackerFirst && attackerKills) {
      blockersLost.push(blocker.instanceId);
      continue;
    }
    if (blockerFirst && blockerKills) {
      attackersLost.push(attacker.instanceId);
      continue;
    }
    if (attackerKills) blockersLost.push(blocker.instanceId);
    if (blockerKills) attackersLost.push(attacker.instanceId);
  }

  return { faceDamage, attackersLost, blockersLost };
}
