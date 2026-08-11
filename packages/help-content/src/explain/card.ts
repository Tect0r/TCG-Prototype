import {
  KEYWORD_REGISTRY,
  type AbilityCost,
  type AbilityDefinition,
  type ActivatedAbilityDefinition,
  type CardDatabase,
  type CardDefinition,
  type KeywordDefinition,
  type StaticAbilityDefinition,
} from '@tcg/card-data';
import { DEFAULT_HELP_CONFIG, resolveTemplate, type HelpConfig } from '../references.js';
import { DEPLOY_TRIGGER, TRIGGER_REGISTRY } from '../registries/triggers.js';
import { capitalise, humanise, list, numberWord, quantify, sentence } from './grammar.js';
import { explainEffect, type EffectExplanation } from './effects.js';
import { describeSelector, describeTriggerScope, filterPhrases, zoneName } from './selectors.js';
import { conditionClause } from './values.js';
import type { PublicCardContext } from '../context.js';
import { contextMessages } from '../context.js';

/**
 * The shared card explanation service.
 *
 * Pure, deterministic and side-effect free: the same card, registries and
 * context always produce the same object. Nothing here reads `displayText` to
 * work out what a card does — the canonical text is carried through untouched
 * so a player can compare it against the generated explanation, and the two are
 * always labelled distinctly in the UI.
 *
 * The registries are module-level singletons rather than parameters on purpose.
 * There is exactly one keyword registry, one trigger registry and one effect
 * registry in the repository; threading them through as arguments would invite
 * a second copy to exist.
 */

export interface ExplanationStep {
  /** Generated from structured data. */
  readonly text: string;
  /** Qualifications the generator produced. */
  readonly notes: readonly string[];
  /** An author-written clarification for this step, when one exists. */
  readonly curated: string | null;
}

export type ExplanationSectionKind = 'resolve' | 'triggered' | 'activated' | 'static';

export interface ExplanationSection {
  readonly id: string;
  readonly kind: ExplanationSectionKind;
  /** When this happens, e.g. "When this unit is deployed". */
  readonly title: string;
  /** Timing detail from the trigger registry. */
  readonly timing: string;
  /** What it costs to use. Activated abilities only. */
  readonly costs: readonly string[];
  /** How often it may be used. Activated abilities only. */
  readonly limit: string | null;
  readonly steps: readonly ExplanationStep[];
}

export interface CardExplanation {
  readonly cardId: string;
  /** One sentence. Author-written when supplied, generated otherwise. */
  readonly summary: string;
  /** True when `summary` came from the card's curated text. */
  readonly summaryIsCurated: boolean;
  readonly sections: readonly ExplanationSection[];
  readonly keywords: readonly KeywordDefinition[];
  /** Curated edge-case notes, plus generated ones that apply to the whole card. */
  readonly notes: readonly string[];
  /** Status derived from the authoritative view, when a context was supplied. */
  readonly context: readonly string[];
}

export interface ExplainCardOptions {
  /** Resolves token references in `create_token`. */
  readonly database?: CardDatabase | undefined;
  /** Supplies live values for `{matchConfig.…}` references in curated text. */
  readonly config?: HelpConfig | undefined;
  /** Facts derived from the player's own authoritative view. */
  readonly context?: PublicCardContext | undefined;
}

/** What to call the card its own text is printed on. */
function sourceNounFor(card: CardDefinition): string {
  switch (card.type) {
    case 'unit':
      return 'this unit';
    case 'token':
      return 'this token';
    case 'relic':
      return 'this relic';
    case 'spell':
      return 'this spell';
    case 'reaction':
      return 'this Reaction';
    case 'commander':
      return 'your Commander';
  }
}

function describeCost(cost: AbilityCost, sourceNoun: string): string {
  switch (cost.type) {
    case 'energy':
      return `${numberWord(cost.amount)} energy`;
    case 'exhaust_source':
      return `exhaust ${sourceNoun}`;
    case 'discard':
      return `discard ${quantify(cost.amount, 'card')}${
        cost.selection === 'random'
          ? ' at random'
          : cost.selection === 'player_choice'
            ? ' of your choice'
            : ''
      }`;
    case 'sacrifice': {
      const phrases = filterPhrases(cost.filter);
      const noun = phrases.noun ?? 'friendly unit';
      // "other" is the whole of `excludeSource`, and a player who does not see it
      // will read the card as one they can feed to itself. It goes inside the
      // noun phrase rather than in front of the count, because `quantify` writes
      // the number: "one other friendly unit", not "another one friendly unit".
      const qualified = [
        ...(cost.excludeSource ? ['other'] : []),
        ...phrases.before,
        noun,
        ...phrases.after,
      ].join(' ');
      return `sacrifice ${quantify(cost.amount, qualified)}`;
    }
  }
}

function describeLimit(ability: ActivatedAbilityDefinition): string {
  switch (ability.usageLimit) {
    case 'once_per_match':
      return 'Once per match.';
    case 'once_per_turn':
      return 'Once per turn.';
    case 'unlimited':
      return 'Any number of times per turn, as long as you can pay.';
  }
}

/**
 * When a triggered ability happens, as one sentence.
 *
 * Three things the trigger registry's bare `clause` cannot say, and every one
 * of them changes what the card does:
 *
 *  - **scope** — "when *another friendly* unit is defeated" is a different card
 *    from "when this unit is defeated", and the registry clause only knows how
 *    to say the second;
 *  - **the throttle** — "the first time … each turn";
 *  - **the condition** — an ability that only fires on your own turn.
 *
 * An unscoped, unthrottled, unconditional ability keeps the registry clause
 * verbatim, which is both the common case and the wording players already see.
 */
function triggeredTitle(ability: AbilityDefinition): string {
  const trigger = TRIGGER_REGISTRY[ability.trigger];
  const condition = conditionClause(ability.condition);

  if (!ability.scope && !ability.limit) return `${trigger.clause}${condition}`;

  const event = trigger.event(ability.scope ? describeTriggerScope(ability.scope) : 'this card');
  const timing = ability.limit === 'each_turn' ? `The first time ${event} each turn` : null;
  // `capitalise`, not `sentence`: a title carries no full stop — the registry
  // clauses have none — and a condition clause may still be appended after it.
  return `${timing ?? capitalise(`when ${event}`)}${condition}`;
}

function describeStatic(ability: StaticAbilityDefinition, sourceNoun: string): string {
  const scope = ability.affects;

  // A Reaction discount gets its own sentence rather than being squeezed into
  // the "your <cards> <change>" shape below. What it reduces is the *next*
  // Reaction its controller plays, and the "first one after your turn begins"
  // window is the whole card — a scope phrase has nowhere to put either.
  if (ability.effect.type === 'reaction_discount') {
    const which =
      ability.effect.limit === 'first_each_turn'
        ? 'The first Reaction you play after the beginning of each of your turns'
        : 'Reactions you play';
    const narrowed = filterPhrases(scope.filter).noun;
    return sentence(
      `${narrowed ? `${which} (${narrowed})` : which} costs ${ability.effect.amount} less, to a minimum of ${ability.effect.minimum}`,
    );
  }
  const phrases = filterPhrases(scope.filter);
  const defaultNoun = scope.zone === 'battlefield' ? 'units' : 'cards';
  const noun = phrases.noun ? `${phrases.noun}s` : defaultNoun;
  const owner =
    scope.controller === 'self' ? 'your' : scope.controller === 'opponent' ? 'enemy' : 'all';
  const where = scope.zone === 'battlefield' ? '' : ` in the ${zoneName(scope.zone)}`;
  const subject = [owner, ...phrases.before, noun].join(' ') + where;
  const except = scope.excludeSource ? ` (not ${sourceNoun} itself)` : '';

  const change =
    ability.effect.type === 'modify_stats'
      ? `get ${ability.effect.attack >= 0 ? '+' : ''}${ability.effect.attack}/${
          ability.effect.health >= 0 ? '+' : ''
        }${ability.effect.health}`
      : `have ${KEYWORD_REGISTRY[ability.effect.keyword].name}`;

  return sentence(`${subject}${except} ${change}`);
}

function stepsFor(
  effects: readonly CardDefinition['effects'][number][],
  options: ExplainCardOptions,
  sourceNoun: string,
  curated: readonly string[] | undefined,
): readonly ExplanationStep[] {
  return effects.map((effect, index): ExplanationStep => {
    const explanation: EffectExplanation = explainEffect(effect, {
      database: options.database,
      sourceNoun,
    });
    return {
      text: explanation.text,
      notes: explanation.notes,
      curated: curated?.[index] ?? null,
    };
  });
}

/**
 * A one-sentence summary generated from the card's shape.
 *
 * Deliberately coarse: it names the card's job, not its numbers, because the
 * numbers are already spelled out step by step below it. A curated
 * `text.summary` replaces it entirely.
 */
function generateSummary(card: CardDefinition): string {
  const parts: string[] = [];

  const typeWord =
    card.type === 'commander'
      ? 'Commander'
      : card.type === 'token'
        ? 'token unit'
        : (card.type as string);
  const cost =
    card.cost === null ? 'that is never paid for' : `costing ${numberWord(card.cost)} energy`;
  const stats =
    card.attack !== undefined && card.health !== undefined
      ? `, ${card.attack} attack and ${card.health} health`
      : '';
  parts.push(`${capitalise(typeWord)} ${cost}${stats}`);

  const abilities: string[] = [];
  if (card.effects.length > 0) {
    abilities.push(
      card.type === 'spell'
        ? `${quantify(card.effects.length, 'effect')} when you cast it`
        : `${quantify(card.effects.length, 'effect')} when it arrives`,
    );
  }
  if (card.abilities.length > 0) {
    abilities.push(
      `${quantify(card.abilities.length, 'triggered ability', 'triggered abilities')}`,
    );
  }
  if (card.activatedAbilities.length > 0) {
    abilities.push(
      `${quantify(card.activatedAbilities.length, 'ability you can activate', 'abilities you can activate')}`,
    );
  }
  if (card.staticAbilities.length > 0) {
    abilities.push(
      `${quantify(card.staticAbilities.length, 'continuous effect')} while it is in play`,
    );
  }
  if (card.keywords.length > 0) {
    abilities.push(
      `the ${card.keywords.length === 1 ? 'keyword' : 'keywords'} ${list(
        card.keywords.map((id) => KEYWORD_REGISTRY[id].name),
      )}`,
    );
  }

  if (abilities.length === 0) return sentence(`${parts[0]!} and no special rules`);
  return sentence(`${parts[0]!}, with ${list(abilities)}`);
}

/** Whole-card caveats worth showing beneath the steps. */
function generatedNotes(card: CardDefinition): readonly string[] {
  const notes: string[] = [];

  const inert = card.keywords.filter((id) => !KEYWORD_REGISTRY[id].implemented);
  if (inert.length > 0) {
    notes.push(
      `${list(inert.map((id) => KEYWORD_REGISTRY[id].name))} ${
        inert.length === 1 ? 'has' : 'have'
      } no effect in the rules engine yet, so ${
        inert.length === 1 ? 'it does' : 'they do'
      } not change how this card plays.`,
    );
  }
  if (card.unique) {
    notes.push('Unique: your deck may contain only one copy.');
  }
  if (card.additionalCosts.length > 0) {
    notes.push(
      'The additional cost is paid as you play this, before an opponent can respond. If this card is countered you still paid it — nothing is refunded.',
    );
  }
  if (card.type === 'relic') {
    notes.push(
      'Relics sit in their own row and are never units. Playing another relic replaces this one — it goes to your discard pile as a rules action, not as a destruction or a sacrifice.',
    );
  }
  if (card.type === 'commander') {
    notes.push(
      'Your Commander starts in the Commander zone. Playing it pays its printed cost and puts it onto the battlefield, where it behaves as a unit.',
    );
  }
  if (card.type === 'reaction') {
    notes.push(
      'A Reaction can only be played inside its printed timing window, not during your Main Phase.',
    );
  }
  if (
    (card.type === 'unit' || card.type === 'commander') &&
    card.keywords.every((id) => id !== 'rush')
  ) {
    notes.push(
      'Like any unit without Rush, it cannot attack, or pay an "Exhaust this unit" cost, on the turn it is deployed.',
    );
  }
  return notes;
}

export function explainCard(
  card: CardDefinition,
  options: ExplainCardOptions = {},
): CardExplanation {
  const config = options.config ?? DEFAULT_HELP_CONFIG;
  const sourceNoun = sourceNounFor(card);
  const resolve = (text: string): string => resolveTemplate(text, config);

  const sections: ExplanationSection[] = [];

  // A card with an additional cost and no deploy effects still has something to
  // say about being played, so the section is not gated on `effects` alone.
  if (card.effects.length > 0 || card.additionalCosts.length > 0) {
    const deploy = DEPLOY_TRIGGER[card.type === 'commander' ? 'unit' : card.type];
    sections.push({
      id: 'resolve',
      kind: 'resolve',
      title: deploy.clause,
      timing: deploy.description,
      // An additional cost belongs on the resolve section because that is the
      // section describing playing the card. It is paid before an opponent can
      // answer the card, and countering does not give it back — which is worth
      // saying in `notes`, not in the cost line.
      costs: card.additionalCosts.map((cost) => describeCost(cost, sourceNoun)),
      limit: null,
      steps: stepsFor(card.effects, options, sourceNoun, card.text?.effectExplanations),
    });
  }

  for (const ability of card.abilities) {
    const trigger = TRIGGER_REGISTRY[ability.trigger];
    sections.push({
      id: `trigger:${ability.id}`,
      kind: 'triggered',
      title: triggeredTitle(ability),
      timing: trigger.description,
      costs: [],
      limit: ability.limit === 'each_turn' ? 'Once each turn.' : null,
      steps: stepsFor(ability.effects, options, sourceNoun, undefined),
    });
  }

  for (const ability of card.activatedAbilities) {
    sections.push({
      id: `activated:${ability.id}`,
      kind: 'activated',
      title: ability.name,
      timing:
        'You choose when to use this, during your own Main Phase, with nothing else resolving.',
      costs: ability.costs.map((cost) => describeCost(cost, sourceNoun)),
      limit: describeLimit(ability),
      steps: stepsFor(ability.effects, options, sourceNoun, undefined),
    });
  }

  for (const ability of card.staticAbilities) {
    sections.push({
      id: `static:${ability.id}`,
      kind: 'static',
      title: 'While this is in play',
      timing:
        'Continuous: recalculated from the board, so it covers cards that arrive later and stops the moment the source leaves play.',
      costs: [],
      limit: null,
      steps: [{ text: describeStatic(ability, sourceNoun), notes: [], curated: null }],
    });
  }

  const summaryIsCurated = card.text?.summary !== undefined;

  return {
    cardId: card.id,
    summary: resolve(summaryIsCurated ? card.text!.summary! : generateSummary(card)),
    summaryIsCurated,
    sections: sections.map((section) => ({
      ...section,
      steps: section.steps.map((step) => ({
        ...step,
        text: resolve(step.text),
        notes: step.notes.map(resolve),
        curated: step.curated === null ? null : resolve(step.curated),
      })),
    })),
    keywords: card.keywords.map((id) => KEYWORD_REGISTRY[id]),
    notes: [...generatedNotes(card), ...(card.text?.notes ?? [])].map(resolve),
    context: options.context ? contextMessages(options.context) : [],
  };
}

export { describeSelector, humanise };
