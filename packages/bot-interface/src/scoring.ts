import { z } from 'zod';
import { isDistributedSelection } from '@tcg/card-data';
import type {
  CardDatabase,
  CardDefinition,
  DelayedAbilityDefinition,
  Duration,
  EffectDefinition,
  KeywordId,
  SignedValueExpression,
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
   * A confirm has no entity behind it, so the enemy/hostile reasoning every
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

function keywordCount(keywords: readonly KeywordId[]): number {
  return keywords.length;
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

function ungatedEffectValue(
  effect: EffectDefinition,
  weights: BotWeights,
  database: CardDatabase,
  delayedAbilities: readonly DelayedAbilityDefinition[],
): number {
  switch (effect.type) {
    case 'draw':
      return effect.player === 'self'
        ? weights.cardDraw * estimateValue(effect.amount)
        : -weights.cardDraw * estimateValue(effect.amount);
    case 'discard':
      return effect.player === 'self'
        ? -weights.discardCard * estimateValue(effect.amount)
        : weights.discardCard * estimateValue(effect.amount);
    case 'deal_damage': {
      if (effect.target.kind === 'player') {
        return effect.target.relation === 'self'
          ? -weights.faceDamage * estimateValue(effect.amount)
          : weights.faceDamage * estimateValue(effect.amount);
      }
      if (effect.target.kind === 'players') {
        return weights.faceDamage * estimateValue(effect.amount);
      }
      if (effect.target.kind !== 'entity') {
        // `source` and `trigger_subject` both aim at a card on our own side.
        return -weights.unitDamage * estimateValue(effect.amount);
      }
      const selector = effect.target.selector;
      const sign = selector.controller === 'self' ? -1 : 1;
      // A divided amount is a *total* split across the set, not an amount each
      // member takes, so it must not be multiplied by the size of the set —
      // that would price "divide five damage" as five damage to every target
      // (M02.5).
      if (effect.divided === true) {
        return sign * weights.unitDamage * estimateValue(effect.amount);
      }
      const count = selector.count === 'all' ? 2 : selector.count;
      return sign * weights.unitDamage * estimateValue(effect.amount) * count;
    }
    case 'heal': {
      if (effect.target.kind === 'player') {
        return effect.target.relation === 'self'
          ? weights.healing * estimateValue(effect.amount)
          : -weights.healing * estimateValue(effect.amount);
      }
      if (effect.target.kind === 'players') return 0;
      return weights.healing * estimateValue(effect.amount);
    }
    case 'modify_stats': {
      const magnitude = estimateValue(effect.attack) + estimateValue(effect.health);
      const sign =
        effect.target.kind === 'entity' && effect.target.selector.controller === 'opponent'
          ? -1
          : 1;
      return sign * weights.buffValue * magnitude * durationScale(effect.duration);
    }
    case 'grant_keyword':
      return weights.keywordBonus * durationScale(effect.duration);
    case 'remove_keyword':
      return weights.keywordBonus * 0.5 * durationScale(effect.duration);
    case 'create_token': {
      const token = database.get(effect.tokenCardId);
      const body = token
        ? (token.attack ?? 0) * weights.unitAttack + (token.health ?? 0) * weights.unitHealth
        : 1;
      return weights.tokenValue * body * estimateValue(effect.amount);
    }
    case 'destroy': {
      const selector = effect.target.kind === 'entity' ? effect.target.selector : null;
      // `source` and `trigger_subject` both point at one of our own cards, so
      // destroying through either is a cost, not a gain.
      const sign = selector === null || selector.controller === 'self' ? -1 : 1;
      const count = selector === null ? 1 : selector.count === 'all' ? 2 : selector.count;
      return sign * weights.removalBonus * count;
    }
    case 'sacrifice': {
      const selector = effect.target.kind === 'entity' ? effect.target.selector : null;
      // "Each player sacrifices one" is not a self-cost: we give one up and so
      // does every opponent, and everybody gives up their worst. What is left
      // over is the tempo of choosing when it happens, which is small but real
      // — pricing it as a pure cost would make the pilot mulligan a symmetrical
      // removal spell away (M02.5).
      if (selector !== null && isDistributedSelection(selector)) {
        return weights.removalBonus * 0.6 * SYMMETRIC_EFFECT_EDGE;
      }
      return -weights.removalBonus * 0.6;
    }
    case 'return_to_hand': {
      const ours = effect.target.kind !== 'entity' || effect.target.selector.controller === 'self';
      return (ours ? -0.2 : 1) * weights.bounceValue;
    }
    case 'search_zone':
      return weights.cardDraw * effect.amount * 1.1;
    case 'reorder_zone':
      return weights.cardDraw * 0.25;
    case 'modify_cost':
      return effect.player === 'self'
        ? -effect.delta * weights.energyEfficiency * durationScale(effect.duration)
        : 0;
    case 'prevent_damage':
      return (
        weights.preventionValue * estimateValue(effect.amount) * durationScale(effect.duration)
      );
    case 'exhaust':
      return weights.tapValue;
    case 'ready':
      return weights.tapValue;
    case 'skip_next_ready': {
      // Costing a unit its next Ready Step is worth more than exhausting it now:
      // the exhaustion it enforces lasts a whole turn cycle rather than until
      // the owner's next untap. Aimed at one of our own cards it is a drawback.
      const ours =
        // `blocked_by_source` names the attackers we blocked, so it is always
        // aimed at somebody else's units however the rest of the card reads.
        effect.target.kind !== 'blocked_by_source' &&
        (effect.target.kind !== 'entity' || effect.target.selector.controller === 'self');
      const count =
        effect.target.kind === 'entity'
          ? effect.target.selector.count === 'all'
            ? 2
            : effect.target.selector.count
          : 1;
      return (ours ? -1 : 1) * weights.tapValue * 1.5 * count;
    }
    case 'move_card': {
      const selector = effect.target.kind === 'entity' ? effect.target.selector : null;
      const count = selector === null ? 1 : selector.count === 'all' ? 2 : selector.count;
      // Putting a card onto the battlefield is worth more than moving one: the
      // card arrives in play without being paid for. *Which* card cannot be
      // known from the definition — it is whatever is in the pile at the time —
      // so it is priced as a card gained, a little above a draw, and a pilot
      // that cannot see anything to bring back is corrected where it can see the
      // board rather than here (see `emptySourceZonePenalty`).
      if (effect.toZone === 'battlefield') return weights.cardDraw * count * 1.2;
      // Removing a card from the game. One of ours is a small price paid for
      // whatever else the instruction list does; one of theirs denies them the
      // card outright, which is worth about what making them discard it is.
      if (effect.toZone === 'removed') {
        const ours = selector === null || selector.controller === 'self';
        return ours ? -weights.cardDraw * 0.2 * count : weights.discardCard * count;
      }
      return weights.cardDraw * 0.3;
    }
    case 'schedule_delayed': {
      const ability = delayedAbilities.find((entry) => entry.id === effect.delayedAbilityId);
      // An unresolvable reference cannot happen on validated card data, and a
      // caller that did not pass the card's delayed list gets zero rather than
      // an invented number.
      if (!ability) return 0;
      const scale = ability.trigger === undefined ? DELAYED_BOUNDARY_SCALE : DELAYED_WATCH_SCALE;
      // Nested one level only — the schema forbids a delayed body scheduling
      // another — so this cannot recur.
      return effectsValue(ability.effects, weights, database) * scale;
    }
    default:
      return 0;
  }
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

/**
 * What a card's continuous abilities are worth.
 *
 * Priced per ability rather than as `staticAbilities.length × buffValue × 2`,
 * which is what it used to be. That proxy read every continuous ability as a
 * lord's aura, and two of the three are not: a Reaction discount and a
 * `cost_reduction` are worth *energy*, not board presence, and the coarse
 * proxy over-valued both (M02.3).
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
    switch (ability.effect.type) {
      case 'modify_stats':
      case 'grant_keyword':
        return sum + weights.buffValue * 2;
      case 'reaction_discount':
        return sum + weights.energyEfficiency * ability.effect.amount;
      case 'cost_reduction':
        return sum + weights.energyEfficiency * estimateValue(ability.effect.amount);
      case 'replace_arrival': {
        // Two different cards wear this shape. Rewriting an *opponent's* arrival
        // to be Exhausted is tempo denial, worth about what exhausting a unit is;
        // handing your own arrivals a keyword is a buff. A "first each turn"
        // limit halves it, because it reaches one arrival rather than all of
        // them.
        const denial =
          ability.effect.entersExhausted === true
            ? (ability.affects.controller === 'opponent' ? 1 : -1) * weights.tapValue
            : 0;
        const granted = ability.effect.grantKeyword === undefined ? 0 : weights.keywordBonus * 2;
        const throttle = ability.effect.limit === 'first_each_turn' ? 0.5 : 1;
        return sum + (denial + granted) * throttle;
      }
      case 'replace_ready':
        // Keeping an enemy unit Exhausted through its Ready Step is worth more
        // than exhausting one during a turn — it costs the opponent a whole turn
        // of that unit — but it is paid for, so the Energy comes back off.
        return (
          sum +
          (ability.affects.controller === 'opponent' ? 1 : -1) * weights.tapValue * 1.5 -
          weights.energyEfficiency * ability.effect.energyCost
        );
    }
  }, 0);
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
    keywordCount(definition.keywords) * weights.keywordBonus;

  const delayed = definition.delayedAbilities;
  const text =
    effectsValue(definition.effects, weights, database, delayed) +
    definition.abilities.reduce(
      (sum, ability) => sum + effectsValue(ability.effects, weights, database, delayed) * 0.7,
      0,
    ) +
    definition.activatedAbilities.reduce(
      (sum, ability) => sum + effectsValue(ability.effects, weights, database, delayed) * 0.5,
      0,
    ) +
    staticAbilitiesValue(definition, weights);

  const chassis = definition.type === 'relic' ? weights.relicBase : 0;
  return body + text + chassis;
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
    keywordCount(unit.keywords) * weights.keywordBonus;
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

/** Whether `attacker` dealing its damage would defeat `defender` this combat. */
export function wouldDefeat(attacker: CardInstanceView, defender: CardInstanceView): boolean {
  if (attacker.keywords.includes('venom') && attacker.attack > 0) return true;
  return attacker.attack >= remainingHealthOf(defender);
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
  options: { readonly chumpBlock: boolean; readonly valueOnly: boolean },
): { attackerInstanceId: string; blockerInstanceId: string }[] {
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
    const index = remaining.findIndex((blocker) => {
      const kills = wouldDefeat(blocker, attacker);
      const survives = !wouldDefeat(attacker, blocker);
      if (options.valueOnly) return kills || survives;
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
 * Resolves a hypothetical combat under the simple simultaneous-damage rules.
 *
 * `quick_strike` is modelled: a quick-striking combatant that defeats its
 * opponent takes no damage back. Nothing else about the real damage step is
 * approximated away.
 */
export function resolveHypotheticalCombat(
  attackers: readonly CardInstanceView[],
  blocks: readonly { attackerInstanceId: string; blockerInstanceId: string }[],
  blockerLookup: ReadonlyMap<string, CardInstanceView>,
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
    const attackerFirst =
      attacker.keywords.includes('quick_strike') && !blocker.keywords.includes('quick_strike');
    const blockerFirst =
      blocker.keywords.includes('quick_strike') && !attacker.keywords.includes('quick_strike');

    const attackerKills = wouldDefeat(attacker, blocker);
    const blockerKills = wouldDefeat(blocker, attacker);

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
