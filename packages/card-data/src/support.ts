import {
  ABILITY_COST_TYPES,
  EFFECT_TYPES,
  STATIC_ABILITY_EFFECT_TYPES,
  TRIGGER_IDS,
  type AbilityCostType,
  type EffectDefinition,
  type EffectType,
  type StaticAbilityEffectType,
  type TriggerId,
} from './schema/effect.js';
import {
  CONDITION_KINDS,
  VALUE_EXPRESSION_KINDS,
  valueExpressionKindOf,
  type ConditionKind,
  type SignedValueExpression,
  type ValueExpression,
  type ValueExpressionKind,
} from './schema/condition.js';
import { KEYWORD_IDS, type KeywordId } from './schema/primitives.js';
import type { CardDefinition } from './schema/card.js';

/**
 * The machine-readable answer to "how well is this mechanic actually supported"
 * (M05.1).
 *
 * Every other statement of support in this repository is an *author claim*: a
 * card says `implemented: true`, a keyword says `implemented: false`, a report
 * says its pilots are heuristics. None of those can be checked, none of them is
 * per-mechanic, and none of them distinguishes "the engine executes this" from
 * "a bot knows what to do with it" or "a batch of matches records that it
 * happened". This registry separates the four questions and answers each one for
 * every member of every executable vocabulary.
 *
 * It is **descriptive, never prescriptive**. Nothing here decides what a
 * mechanic does; the rules engine remains the only authority on behaviour, the
 * help layer on wording and the pilots on play. A level here is a claim *about*
 * those modules, kept honest by the tests beside this file and by the `where`
 * note on each entry, which names the module the claim is about.
 *
 * ## The four dimensions
 *
 * - **engine** — `full` when the rules engine executes the mechanic; `none` when
 *   it is authored, filterable, printed on cards, and deliberately inert.
 * - **help** — `full` when the help layer both names the mechanic and describes
 *   every field an author can set on it; `partial` when it is named but some
 *   parameter goes unmentioned; `none` when nothing player-facing exists.
 * - **pilot** — `full` when a pilot evaluates the mechanic against the actual
 *   board; `approximate` when it is priced from the card definition with
 *   board-independent assumptions; `legal_only` when no pilot values it at all
 *   and it is merely played around legally.
 * - **telemetry** — `full` when a counter in a match record counts this
 *   mechanic's occurrences and its magnitude where it has one; `partial` when
 *   occurrences are folded into a broader counter that does not distinguish this
 *   mechanic from others; `none` when no counter records it and its effect can
 *   only be inferred from downstream board state.
 *
 * ## Adding a mechanic
 *
 * Every table below is a total `Record` over a vocabulary read off the schema,
 * so adding an effect, trigger, keyword, condition, value or cost without
 * classifying it here is a **compile error**. `assertSupportRegistryComplete`
 * makes the same check at runtime, for the JSON-driven paths that never see the
 * type.
 */

/**
 * Bumped when a *classification* changes, so a manifest's claims can be read
 * against the registry that made them rather than against today's.
 *
 * - 1 — M05.1, the first registry.
 * - 2 — M05.2. `effect:counter` moved `legal_only` → `approximate` (the pilots
 *   now price it), and the pilot notes on the keywords, the continuous effects
 *   and the two additional-cost types were rewritten to describe valuation that
 *   reads magnitude and scope rather than list length.
 */
export const SUPPORT_REGISTRY_VERSION = 2;

export const ENGINE_SUPPORT_LEVELS = ['full', 'none'] as const;
export type EngineSupport = (typeof ENGINE_SUPPORT_LEVELS)[number];

export const HELP_SUPPORT_LEVELS = ['full', 'partial', 'none'] as const;
export type HelpSupport = (typeof HELP_SUPPORT_LEVELS)[number];

export const PILOT_SUPPORT_LEVELS = ['full', 'approximate', 'legal_only'] as const;
export type PilotSupport = (typeof PILOT_SUPPORT_LEVELS)[number];

export const TELEMETRY_SUPPORT_LEVELS = ['full', 'partial', 'none'] as const;
export type TelemetrySupport = (typeof TELEMETRY_SUPPORT_LEVELS)[number];

/** The four dimensions, in the order every report prints them. */
export const SUPPORT_DIMENSIONS = ['engine', 'help', 'pilot', 'telemetry'] as const;
export type SupportDimension = (typeof SUPPORT_DIMENSIONS)[number];

export interface MechanicSupport {
  readonly engine: EngineSupport;
  readonly help: HelpSupport;
  readonly pilot: PilotSupport;
  readonly telemetry: TelemetrySupport;
}

/** A registry entry: the four levels plus the modules the claim is about. */
export interface MechanicSupportEntry extends MechanicSupport {
  /**
   * Where the support comes from, or what is missing. Developer-facing, and the
   * thing that makes a downgrade actionable rather than mysterious.
   */
  readonly where: string;
}

/**
 * The families a mechanic can belong to.
 *
 * `effect` and `static_effect` are separate because they are separate schema
 * unions with separate executors: a continuous `modify_stats` is derived and
 * recomputed, and an instruction `modify_stats` is applied once. Sharing a
 * namespace would make two different levels collide under one name.
 */
export const MECHANIC_KINDS = [
  'effect',
  'static_effect',
  'trigger',
  'keyword',
  'condition',
  'value',
  'cost',
] as const;
export type MechanicKind = (typeof MECHANIC_KINDS)[number];

/** One mechanic, named by family and ID. Stable and serializable. */
export interface MechanicRef {
  readonly kind: MechanicKind;
  readonly id: string;
}

/** `effect:deal_damage` — the flat key used in manifests, CSVs and messages. */
export function mechanicKey(ref: MechanicRef): string {
  return `${ref.kind}:${ref.id}`;
}

/* ------------------------------------------------------------- instructions */

const EFFECT_SUPPORT: Readonly<Record<EffectType, MechanicSupportEntry>> = Object.freeze({
  draw: {
    engine: 'full',
    help: 'full',
    pilot: 'approximate',
    telemetry: 'full',
    where: 'effects.ts draw; scoring.ts prices the amount; telemetry cardsDrawnBy/timesDrawn.',
  },
  discard: {
    engine: 'full',
    help: 'full',
    pilot: 'approximate',
    telemetry: 'full',
    where:
      'effects.ts discard; scoring.ts prices the amount but not which card is chosen; telemetry cardsDiscardedBy/timesDiscarded.',
  },
  deal_damage: {
    engine: 'full',
    help: 'full',
    pilot: 'approximate',
    telemetry: 'full',
    where:
      'effects.ts deal_damage; scoring.ts prices amount × target count from the definition, not the board; telemetry damageToPlayers/damageToUnits and lethal → unitsRemoved.',
  },
  heal: {
    engine: 'full',
    help: 'full',
    pilot: 'approximate',
    telemetry: 'full',
    where: 'effects.ts heal; scoring.ts prices the amount; telemetry healingDone.',
  },
  modify_stats: {
    engine: 'full',
    help: 'full',
    pilot: 'approximate',
    telemetry: 'none',
    where:
      'effects.ts modify_stats; scoring.ts prices magnitude × durationScale; no counter records a stat change or its size.',
  },
  grant_keyword: {
    engine: 'full',
    help: 'full',
    pilot: 'approximate',
    telemetry: 'none',
    where:
      "effects.ts grant_keyword; scoring.ts prices the granted keyword's own value × durationScale, which is a flat keywordBonus for every keyword the engine executes and zero for one it does not (M05.2); no counter records a grant.",
  },
  remove_keyword: {
    engine: 'full',
    help: 'full',
    pilot: 'approximate',
    telemetry: 'none',
    where:
      "effects.ts remove_keyword; scoring.ts prices half the removed keyword's value × durationScale, negative when the target is one of our own units (M05.2); no counter records a removal.",
  },
  create_token: {
    engine: 'full',
    help: 'full',
    pilot: 'approximate',
    telemetry: 'full',
    where:
      'effects.ts create_token; scoring.ts prices the token statline from the database; telemetry tokensCreated.',
  },
  destroy: {
    engine: 'full',
    help: 'full',
    pilot: 'approximate',
    telemetry: 'full',
    where:
      'effects.ts destroy; scoring.ts prices removalBonus × target count; telemetry unitsRemoved via unit_defeated(reason=destroyed).',
  },
  sacrifice: {
    engine: 'full',
    help: 'full',
    pilot: 'approximate',
    telemetry: 'full',
    where:
      'effects.ts sacrifice; scoring.ts prices it as a cost, and as a symmetrical edge when the selector is plural; telemetry timesSacrificed.',
  },
  return_to_hand: {
    engine: 'full',
    help: 'full',
    pilot: 'approximate',
    telemetry: 'none',
    where:
      'effects.ts return_to_hand; scoring.ts prices bounceValue. `CardTelemetry.timesReturnedToHand` exists in the schema but is never incremented by the collector, so a bounce is invisible to a batch.',
  },
  search_zone: {
    engine: 'full',
    help: 'full',
    pilot: 'approximate',
    telemetry: 'none',
    where:
      'effects.ts search_zone; scoring.ts prices it as cardDraw × amount and ignores the filter, the destination and fromTop; no counter records a search or what it found.',
  },
  reorder_zone: {
    engine: 'full',
    help: 'full',
    pilot: 'approximate',
    telemetry: 'none',
    where:
      'effects.ts reorder_zone; scoring.ts prices a flat quarter-draw; no counter records a reorder.',
  },
  modify_cost: {
    engine: 'full',
    help: 'full',
    pilot: 'approximate',
    telemetry: 'partial',
    where:
      'effects.ts modify_cost; scoring.ts prices the delta for `self` and zero for an opponent; card_played.energySpent shows the price actually paid but nothing attributes the difference to the modifier.',
  },
  prevent_damage: {
    engine: 'full',
    help: 'full',
    pilot: 'approximate',
    telemetry: 'none',
    where:
      'effects.ts prevent_damage; scoring.ts prices amount × durationScale; no counter records a shield being placed or spent.',
  },
  exhaust: {
    engine: 'full',
    help: 'full',
    pilot: 'approximate',
    telemetry: 'none',
    where: 'effects.ts exhaust; scoring.ts prices a flat tapValue; no counter records an exhaust.',
  },
  ready: {
    engine: 'full',
    help: 'full',
    pilot: 'approximate',
    telemetry: 'none',
    where: 'effects.ts ready; scoring.ts prices a flat tapValue; no counter records a ready.',
  },
  skip_next_ready: {
    engine: 'full',
    help: 'full',
    pilot: 'approximate',
    telemetry: 'partial',
    where:
      'effects.ts skip_next_ready; scoring.ts prices 1.5 × tapValue × target count. The engine emits ready_prevented, but the collector deliberately skips the stored half so one card is not billed twice, so only the arming instruction is counted.',
  },
  move_card: {
    engine: 'full',
    help: 'full',
    pilot: 'approximate',
    telemetry: 'partial',
    where:
      'effects.ts move_card; scoring.ts prices a revival above a draw and a removal as a denied card. Telemetry records `removed` as timesRemoved; every other destination is only a zone change on the instance.',
  },
  schedule_delayed: {
    engine: 'full',
    help: 'full',
    pilot: 'approximate',
    telemetry: 'partial',
    where:
      'effects.ts schedule_delayed; scoring.ts prices the named body, discounted for the delay. delayed_effect_fired lands in the undifferentiated triggersFired counter.',
  },
  counter: {
    engine: 'full',
    help: 'full',
    pilot: 'approximate',
    telemetry: 'none',
    where:
      "reactions.ts counters the card the window named. scoring.ts's `EFFECT_PRICERS.counter` prices it at `counterValue`, softened by `unlessPays`, and `scoreReaction` swaps that estimate for the value of the card actually on the stack once a window exists — so holding one is approximate and spending one is board-aware (M05.2). No counter records a card being countered.",
  },
});

/* -------------------------------------------------------- continuous effects */

const STATIC_EFFECT_SUPPORT: Readonly<Record<StaticAbilityEffectType, MechanicSupportEntry>> =
  Object.freeze({
    modify_stats: {
      engine: 'full',
      help: 'full',
      pilot: 'approximate',
      telemetry: 'none',
      where:
        "continuous.ts recomputes the layer; scoring.ts's `staticAbilityValue` prices printed magnitude × the scope's assumed reach × a source-bound duration, signed by whose cards it lands on. The reach is assumed rather than counted, because `cardValue` ranks a card before there is a board (M05.2). No counter records the layer.",
    },
    grant_keyword: {
      engine: 'full',
      help: 'full',
      pilot: 'approximate',
      telemetry: 'none',
      where:
        "continuous.ts recomputes the layer; scoring.ts's `staticAbilityValue` prices it as the granted keyword's own value × the scope's assumed reach, so granting an `engine: 'none'` keyword is worth nothing (M05.2). No counter records the layer.",
    },
    reaction_discount: {
      engine: 'full',
      help: 'full',
      pilot: 'approximate',
      telemetry: 'partial',
      where:
        'playCostOf applies it; scoring.ts prices amount × energyEfficiency, halved for a `first_each_turn` limit. card_played.energySpent shows the discounted price, but nothing attributes the difference to this ability.',
    },
    cost_reduction: {
      engine: 'full',
      help: 'full',
      pilot: 'approximate',
      telemetry: 'partial',
      where:
        'playCostOf applies it; scoring.ts prices the estimated amount × energyEfficiency × the scope reach, so "**this card** costs less" is priced below a discount on a whole hand. Same partial observation as reaction_discount.',
    },
    replace_arrival: {
      engine: 'full',
      help: 'full',
      pilot: 'approximate',
      telemetry: 'partial',
      where:
        "replacement.ts rewrites the arrival; scoring.ts prices denial or a grant — the grant at the granted keyword's own value over its printed `grantDuration` — signed by whose arrivals it rewrites and halved for a first-each-turn limit. arrival_replaced lands in the undifferentiated triggersFired counter.",
    },
    replace_ready: {
      engine: 'full',
      help: 'full',
      pilot: 'approximate',
      telemetry: 'partial',
      where:
        'replacement.ts rewrites the Ready Step; scoring.ts prices 1.5 × tapValue, signed by whose Ready Step it rewrites and halved for a first-each-turn limit, less the energy it charges. ready_prevented lands in the undifferentiated triggersFired counter.',
    },
  });

/* ------------------------------------------------------------------ triggers */

/**
 * Triggers share one classification, and that is the honest reading rather than
 * a shortcut: the engine fires every one of them, the help layer has a written
 * clause and description for every one, `cardValue` prices a triggered ability
 * as its body × a flat 0.7 with no model of how likely the trigger is, and the
 * collector counts every firing into one `triggersFired` total that does not say
 * which trigger fired.
 */
function triggerEntry(where: string): MechanicSupportEntry {
  return { engine: 'full', help: 'full', pilot: 'approximate', telemetry: 'partial', where };
}

const TRIGGER_SUPPORT: Readonly<Record<TriggerId, MechanicSupportEntry>> = Object.freeze({
  on_attack: triggerEntry('combat.ts declaration; TRIGGER_REGISTRY.on_attack.'),
  on_block: triggerEntry('combat.ts blocker assignment; TRIGGER_REGISTRY.on_block.'),
  on_survive_combat: triggerEntry('combat.ts after damage; TRIGGER_REGISTRY.on_survive_combat.'),
  on_survive_combat_as_blocker: triggerEntry(
    'combat.ts after damage, blockers only; TRIGGER_REGISTRY.on_survive_combat_as_blocker.',
  ),
  on_defeated: triggerEntry(
    'state-based defeat, including from the discard pile; TRIGGER_REGISTRY.on_defeated.',
  ),
  on_sacrifice: triggerEntry('defeat with reason=sacrificed; TRIGGER_REGISTRY.on_sacrifice.'),
  on_deployed: triggerEntry('arrival by play or token creation; TRIGGER_REGISTRY.on_deployed.'),
  on_entered_battlefield: triggerEntry(
    'arrival by any route, revivals included; TRIGGER_REGISTRY.on_entered_battlefield.',
  ),
  on_tokens_created: triggerEntry(
    'once per creating instruction, not once per token; TRIGGER_REGISTRY.on_tokens_created.',
  ),
  on_turn_start: triggerEntry("the controller's own Turn Start; TRIGGER_REGISTRY.on_turn_start."),
  on_turn_end: triggerEntry("the controller's own Turn End; TRIGGER_REGISTRY.on_turn_end."),
  on_opponent_turn_start: triggerEntry(
    "another seat's Turn Start; TRIGGER_REGISTRY.on_opponent_turn_start.",
  ),
  on_opponent_turn_end: triggerEntry(
    "another seat's Turn End; TRIGGER_REGISTRY.on_opponent_turn_end.",
  ),
});

/* ------------------------------------------------------------------ keywords */

/**
 * No telemetry counter exists for any keyword, so every entry below reads
 * `telemetry: 'none'`. A keyword changes numbers that *are* recorded — Siphon
 * moves healingDone, Venom moves unitsRemoved — but nothing separates the part
 * the keyword caused from the part the card would have done anyway, which is the
 * definition of an inference from downstream board state rather than an
 * observation.
 */
const KEYWORD_SUPPORT: Readonly<Record<KeywordId, MechanicSupportEntry>> = Object.freeze({
  rush: {
    engine: 'full',
    help: 'full',
    pilot: 'approximate',
    telemetry: 'none',
    where:
      'legal-actions.ts bypasses Newly Deployed. Pilots see the resulting legality but never value Rush beyond the flat per-keyword bonus in `keywordsValue`.',
  },
  guardian: {
    engine: 'full',
    help: 'full',
    pilot: 'approximate',
    telemetry: 'none',
    where:
      'legal-actions.ts enforces the block requirement. Pilots block legally because the engine makes them, and value Guardian only through the flat per-keyword bonus in `keywordsValue`.',
  },
  barrier: {
    engine: 'full',
    help: 'full',
    pilot: 'approximate',
    telemetry: 'none',
    where:
      'damage.ts prevents the first non-zero damage. Neither `wouldDefeat` nor `resolveHypotheticalCombat` models it, so a pilot trades into a Barrier as if it were not there; valued only through the flat per-keyword bonus in `keywordsValue`.',
  },
  overwhelm: {
    engine: 'full',
    help: 'full',
    pilot: 'approximate',
    telemetry: 'none',
    where:
      'combat.ts splits against current blocker Health. Not modelled in the pilot combat estimate; valued only through the flat per-keyword bonus in `keywordsValue`.',
  },
  untargetable_by_opponents: {
    engine: 'full',
    help: 'full',
    pilot: 'approximate',
    telemetry: 'none',
    where:
      'targeting.ts drops the unit from an opposing chooser. Pilots only ever see legal target sets, so they never have to model it; valued through the flat per-keyword bonus in `keywordsValue`.',
  },
  evasive: {
    engine: 'full',
    help: 'full',
    pilot: 'full',
    telemetry: 'none',
    where:
      'legal-actions.ts filters it out of blocker assignment, and both `greedyBlocks` and the attack candidate filter read it off the board.',
  },
  armored: {
    engine: 'full',
    help: 'full',
    pilot: 'approximate',
    telemetry: 'none',
    where:
      'damage.ts reduces each instance by RulesConfig.armoredReduction. Not modelled in the pilot combat estimate; valued only through the flat per-keyword bonus in `keywordsValue`.',
  },
  siphon: {
    engine: 'full',
    help: 'full',
    pilot: 'approximate',
    telemetry: 'none',
    where:
      'combat.ts heals the controller for dealt combat damage. Not modelled when a pilot decides an attack; valued only through the flat per-keyword bonus in `keywordsValue`.',
  },
  venom: {
    engine: 'full',
    help: 'full',
    pilot: 'full',
    telemetry: 'none',
    where:
      'damage.ts raises marked damage to current health. `wouldDefeat` and the attack candidate filter both read it off the board.',
  },
  quick_strike: {
    engine: 'full',
    help: 'full',
    pilot: 'full',
    telemetry: 'none',
    where:
      'combat.ts puts it in the earlier damage step, and `resolveHypotheticalCombat` reproduces that ordering when a pilot evaluates a trade.',
  },
  resilient: {
    engine: 'none',
    help: 'full',
    pilot: 'legal_only',
    telemetry: 'none',
    where:
      'Deliberately inert pending open question Q4: the candidate readings differ sharply in power. The glossary says so in the words a player reads, which is why `help` is full. There is nothing to play well, so `pilot` is legal_only — and since M05.2 the pilots pay nothing for it either: `keywordIsValued` reads this table, so an `engine: "none"` keyword is worth zero everywhere a keyword is priced.',
  },
});

/* ---------------------------------------------------------------- conditions */

const CONDITION_SUPPORT: Readonly<Record<ConditionKind, MechanicSupportEntry>> = Object.freeze({
  count: {
    engine: 'full',
    help: 'full',
    pilot: 'approximate',
    telemetry: 'none',
    where:
      'conditions.ts evaluates the query when the instruction resolves. Pilots apply one flat CONDITION_DISCOUNT and never evaluate the query; nothing records whether a gate held.',
  },
  source_state: {
    engine: 'full',
    help: 'full',
    pilot: 'approximate',
    telemetry: 'none',
    where: 'conditions.ts reads the source. Same flat pilot discount; no record of the outcome.',
  },
  active_turn: {
    engine: 'full',
    help: 'full',
    pilot: 'approximate',
    telemetry: 'none',
    where:
      'conditions.ts compares the active seat to the controller. Same flat pilot discount; no record of the outcome.',
  },
  previous_step: {
    engine: 'full',
    help: 'full',
    pilot: 'approximate',
    telemetry: 'none',
    where:
      'conditions.ts reads whether the preceding step emitted an event. Same flat pilot discount; no record of the outcome.',
  },
});

/* -------------------------------------------------------- value expressions */

const VALUE_SUPPORT: Readonly<Record<ValueExpressionKind, MechanicSupportEntry>> = Object.freeze({
  fixed: {
    engine: 'full',
    help: 'full',
    pilot: 'full',
    telemetry: 'full',
    where: 'A printed number. Nothing has to be estimated and nothing has to be observed.',
  },
  count: {
    engine: 'full',
    help: 'full',
    pilot: 'approximate',
    telemetry: 'none',
    where:
      'values.ts counts the board when the instruction resolves. `estimateValue` substitutes ASSUMED_MATCH_COUNT because a pilot ranking a hand has no board to count; no record says what it evaluated to.',
  },
  stat: {
    engine: 'full',
    help: 'full',
    pilot: 'approximate',
    telemetry: 'none',
    where:
      'values.ts reads the derived statline per recipient. `estimateValue` substitutes ASSUMED_STAT; no record says what it evaluated to.',
  },
  previous_targets: {
    engine: 'full',
    help: 'full',
    pilot: 'approximate',
    telemetry: 'none',
    where:
      'values.ts counts what the preceding step resolved with. `estimateValue` substitutes ASSUMED_MATCH_COUNT; no record says what it evaluated to.',
  },
});

/* --------------------------------------------------------------------- costs */

const COST_SUPPORT: Readonly<Record<AbilityCostType, MechanicSupportEntry>> = Object.freeze({
  energy: {
    engine: 'full',
    help: 'full',
    pilot: 'approximate',
    telemetry: 'full',
    where:
      'costs.ts pays it atomically; `costValue` penalises it; telemetry energySpent, per card and per seat.',
  },
  exhaust_source: {
    engine: 'full',
    help: 'full',
    pilot: 'approximate',
    telemetry: 'none',
    where:
      '`costValue` penalises it by readyBlockerValue. Activation is counted, but nothing records that the source was exhausted to pay for it.',
  },
  discard: {
    engine: 'full',
    help: 'full',
    pilot: 'approximate',
    telemetry: 'partial',
    where:
      '`costValue` prices it, for an activation and for a played card’s additional cost alike (M05.2). The discarded card is counted, but the collector deliberately attributes the payment to the activation rather than marking the pitched card used.',
  },
  sacrifice: {
    engine: 'full',
    help: 'full',
    pilot: 'approximate',
    telemetry: 'full',
    where:
      '`costValue` prices it, for an activation and for a played card’s additional cost alike (M05.2); telemetry timesSacrificed on the victim.',
  },
});

/* ----------------------------------------------------------------- the table */

const SUPPORT_TABLES: {
  readonly [K in MechanicKind]: Readonly<Record<string, MechanicSupportEntry>>;
} = {
  effect: EFFECT_SUPPORT,
  static_effect: STATIC_EFFECT_SUPPORT,
  trigger: TRIGGER_SUPPORT,
  keyword: KEYWORD_SUPPORT,
  condition: CONDITION_SUPPORT,
  value: VALUE_SUPPORT,
  cost: COST_SUPPORT,
};

/** The vocabulary each table has to cover, read off the schema. */
const MECHANIC_VOCABULARY: Readonly<Record<MechanicKind, readonly string[]>> = {
  effect: EFFECT_TYPES,
  static_effect: STATIC_ABILITY_EFFECT_TYPES,
  trigger: TRIGGER_IDS,
  keyword: KEYWORD_IDS,
  condition: CONDITION_KINDS,
  value: VALUE_EXPRESSION_KINDS,
  cost: ABILITY_COST_TYPES,
};

/**
 * Every classified mechanic, in vocabulary order. The one list a report, a
 * manifest or a coverage check iterates.
 */
export const MECHANIC_SUPPORT_LIST: readonly (MechanicRef & MechanicSupportEntry)[] =
  MECHANIC_KINDS.flatMap((kind) =>
    MECHANIC_VOCABULARY[kind].map((id) => ({
      kind,
      id,
      ...(SUPPORT_TABLES[kind][id] as MechanicSupportEntry),
    })),
  );

/**
 * The classification for one mechanic.
 *
 * Throws on an unknown reference rather than inventing a level. A caller holding
 * a `MechanicRef` got it from `mechanicsUsedBy` or from the vocabulary lists, so
 * an unknown one means the registry and the schema have diverged — exactly the
 * silent gap this module exists to make impossible.
 */
export function mechanicSupport(ref: MechanicRef): MechanicSupportEntry {
  const entry = SUPPORT_TABLES[ref.kind]?.[ref.id];
  if (!entry) {
    throw new Error(
      `No support classification for ${mechanicKey(ref)}. Add it to packages/card-data/src/support.ts.`,
    );
  }
  return entry;
}

/**
 * Runtime twin of the type-level totality check.
 *
 * The `Record` types already fail a build that adds a mechanic without
 * classifying it. This catches the other direction — an entry for a mechanic the
 * schema no longer has — and covers the JSON-driven paths that never see the
 * type at all. Returns the problems rather than throwing, so a caller can report
 * all of them at once.
 */
export function supportRegistryGaps(): string[] {
  const problems: string[] = [];
  for (const kind of MECHANIC_KINDS) {
    const vocabulary = new Set(MECHANIC_VOCABULARY[kind]);
    const classified = new Set(Object.keys(SUPPORT_TABLES[kind]));
    for (const id of vocabulary) {
      if (!classified.has(id)) problems.push(`${kind}:${id} is in the schema but not classified.`);
    }
    for (const id of classified) {
      if (!vocabulary.has(id)) problems.push(`${kind}:${id} is classified but not in the schema.`);
    }
  }
  return problems;
}

export function assertSupportRegistryComplete(): void {
  const problems = supportRegistryGaps();
  if (problems.length > 0) {
    throw new Error(`Mechanic support registry is out of date:\n- ${problems.join('\n- ')}`);
  }
}

/* ------------------------------------------------------ walking a card */

function pushValue(
  into: MechanicRef[],
  value: ValueExpression | SignedValueExpression | undefined,
): void {
  if (value === undefined) return;
  into.push({ kind: 'value', id: valueExpressionKindOf(value) });
}

/** Every mechanic one instruction uses, including its gate and its numbers. */
function refsOfEffect(effect: EffectDefinition, into: MechanicRef[]): void {
  into.push({ kind: 'effect', id: effect.type });
  if (effect.condition) into.push({ kind: 'condition', id: effect.condition.kind });

  switch (effect.type) {
    case 'draw':
    case 'discard':
    case 'deal_damage':
    case 'heal':
    case 'create_token':
    case 'prevent_damage':
      pushValue(into, effect.amount);
      break;
    case 'modify_stats':
      pushValue(into, effect.attack);
      pushValue(into, effect.health);
      break;
    case 'grant_keyword':
    case 'remove_keyword':
      // The granted keyword's own support matters: granting an inert keyword
      // makes the instruction inert too, however well `grant_keyword` works.
      into.push({ kind: 'keyword', id: effect.keyword });
      break;
    default:
      break;
  }
}

/**
 * Every mechanic a card definition uses, deduplicated and in a stable order.
 *
 * This is the "derive support, do not read the author's claim" half of M05.1.
 * `implemented: true` on a card is a sentence somebody typed; this is a walk of
 * the structured data the engine actually executes.
 */
export function mechanicsUsedBy(card: CardDefinition): readonly MechanicRef[] {
  const refs: MechanicRef[] = [];

  for (const keyword of card.keywords) refs.push({ kind: 'keyword', id: keyword });
  for (const cost of card.additionalCosts) refs.push({ kind: 'cost', id: cost.type });
  for (const effect of card.effects) refsOfEffect(effect, refs);

  for (const ability of card.abilities) {
    refs.push({ kind: 'trigger', id: ability.trigger });
    if (ability.condition) refs.push({ kind: 'condition', id: ability.condition.kind });
    for (const effect of ability.effects) refsOfEffect(effect, refs);
  }

  for (const ability of card.activatedAbilities) {
    for (const cost of ability.costs) refs.push({ kind: 'cost', id: cost.type });
    for (const effect of ability.effects) refsOfEffect(effect, refs);
  }

  for (const ability of card.delayedAbilities) {
    if (ability.trigger) refs.push({ kind: 'trigger', id: ability.trigger });
    if (ability.condition) refs.push({ kind: 'condition', id: ability.condition.kind });
    for (const effect of ability.effects) refsOfEffect(effect, refs);
  }

  for (const ability of card.staticAbilities) {
    refs.push({ kind: 'static_effect', id: ability.effect.type });
    if (ability.effect.type === 'grant_keyword') {
      refs.push({ kind: 'keyword', id: ability.effect.keyword });
    }
    if (ability.effect.type === 'replace_arrival' && ability.effect.grantKeyword !== undefined) {
      refs.push({ kind: 'keyword', id: ability.effect.grantKeyword });
    }
    if (ability.effect.type === 'cost_reduction') pushValue(refs, ability.effect.amount);
  }

  const seen = new Set<string>();
  const unique: MechanicRef[] = [];
  for (const ref of refs) {
    const key = mechanicKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(ref);
  }
  // Sorted so two runs, and two cards that use the same mechanics in a different
  // order, produce byte-identical manifests.
  return unique.sort((left, right) => mechanicKey(left).localeCompare(mechanicKey(right)));
}

/* ------------------------------------------------------------- aggregation */

const ORDER: { readonly [K in SupportDimension]: readonly string[] } = {
  engine: ENGINE_SUPPORT_LEVELS,
  help: HELP_SUPPORT_LEVELS,
  pilot: PILOT_SUPPORT_LEVELS,
  telemetry: TELEMETRY_SUPPORT_LEVELS,
};

/** Rank of a level within its dimension. 0 is the strongest. */
export function supportRank(dimension: SupportDimension, level: string): number {
  const rank = ORDER[dimension].indexOf(level);
  if (rank < 0) throw new Error(`"${level}" is not a ${dimension} support level.`);
  return rank;
}

/** The strongest level in a dimension. Used as the identity when folding. */
const STRONGEST: MechanicSupport = {
  engine: 'full',
  help: 'full',
  pilot: 'full',
  telemetry: 'full',
};

/** The weakest level in a dimension. */
const WEAKEST: MechanicSupport = {
  engine: 'none',
  help: 'none',
  pilot: 'legal_only',
  telemetry: 'none',
};

function fold(
  refs: readonly MechanicRef[],
  pick: (candidate: number, current: number) => boolean,
  identity: MechanicSupport,
): MechanicSupport {
  const result: Record<SupportDimension, string> = { ...identity };
  for (const ref of refs) {
    const entry = mechanicSupport(ref);
    for (const dimension of SUPPORT_DIMENSIONS) {
      if (
        pick(supportRank(dimension, entry[dimension]), supportRank(dimension, result[dimension]))
      ) {
        result[dimension] = entry[dimension];
      }
    }
  }
  return result as MechanicSupport;
}

/**
 * The weakest level reached in each dimension, independently.
 *
 * Per dimension rather than "the worst mechanic overall", because the dimensions
 * are answers to different questions: a card can be perfectly executed, fully
 * documented, invisible to telemetry and unpriced by every pilot, and collapsing
 * that into one adjective would lose the only part a reader can act on.
 *
 * An empty list — a vanilla unit with no keywords and no text — is fully
 * supported in every dimension, which is true: there is nothing to get wrong.
 */
export function weakestSupport(refs: readonly MechanicRef[]): MechanicSupport {
  return fold(refs, (candidate, current) => candidate > current, STRONGEST);
}

/**
 * The strongest level reached in each dimension.
 *
 * Only interesting for `telemetry`, where it answers "is *anything* this card
 * does written down?". A card whose strongest telemetry is `none` is invisible
 * to a batch, and no statistic about it can be checked against an observation.
 */
export function strongestSupport(refs: readonly MechanicRef[]): MechanicSupport {
  return fold(refs, (candidate, current) => candidate < current, WEAKEST);
}

/** The mechanics that hold a set back to its weakest level in one dimension. */
export function limitingMechanics(
  refs: readonly MechanicRef[],
  dimension: SupportDimension,
): readonly MechanicRef[] {
  const weakest = weakestSupport(refs)[dimension];
  return refs.filter((ref) => mechanicSupport(ref)[dimension] === weakest);
}

/** One card's derived support, with the evidence for it. */
export interface CardSupport {
  readonly cardId: string;
  readonly mechanics: readonly MechanicRef[];
  readonly weakest: MechanicSupport;
  readonly strongest: MechanicSupport;
  /**
   * No pilot values at least one thing this card does, so a decision involving
   * it was made blind rather than badly.
   */
  readonly pilotBlind: boolean;
  /**
   * Nothing this card does reaches a telemetry counter, so no statistic about it
   * can be checked against a recorded observation.
   */
  readonly telemetryBlind: boolean;
  /**
   * The engine executes everything the card is built from. Derived, and
   * deliberately not read from `card.implemented`.
   */
  readonly executable: boolean;
}

export function describeCardSupport(card: CardDefinition): CardSupport {
  const mechanics = mechanicsUsedBy(card);
  const weakest = weakestSupport(mechanics);
  const strongest = strongestSupport(mechanics);
  return {
    cardId: card.id,
    mechanics,
    weakest,
    strongest,
    pilotBlind: weakest.pilot === 'legal_only',
    telemetryBlind: mechanics.length > 0 && strongest.telemetry === 'none',
    executable: weakest.engine === 'full',
  };
}

/** Every mechanic a group of cards uses, deduplicated. */
export function mechanicsUsedByAll(cards: readonly CardDefinition[]): readonly MechanicRef[] {
  const seen = new Set<string>();
  const refs: MechanicRef[] = [];
  for (const card of cards) {
    for (const ref of mechanicsUsedBy(card)) {
      const key = mechanicKey(ref);
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push(ref);
    }
  }
  return refs.sort((left, right) => mechanicKey(left).localeCompare(mechanicKey(right)));
}
