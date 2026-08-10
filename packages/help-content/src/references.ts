import { DEFAULT_DECK_FORMAT, type DeckFormatConfig } from '@tcg/deck';
import { DEFAULT_RULES_CONFIG, MATCH_PHASES, type RulesConfig } from '@tcg/rules-engine';

/**
 * Live configuration values, addressable by name from content.
 *
 * Rulebook blocks and keyword definitions never write a number such as "20
 * health" as prose. They name a reference — `matchConfig.startingHealth` — and
 * it is resolved here against the shared configuration the engine actually
 * runs. Change a provisional value in one place and every sentence that quotes
 * it follows.
 *
 * The namespace is fixed and shallow on purpose. There is no arbitrary property
 * traversal: exactly two roots, whose keys come from the two configuration
 * types, plus a small set of derived values that are still computed from those
 * same sources. An unknown reference fails content validation rather than
 * rendering as an empty string.
 */

export interface HelpConfig {
  readonly matchConfig: RulesConfig;
  readonly deckRules: DeckFormatConfig;
}

export const DEFAULT_HELP_CONFIG: HelpConfig = {
  matchConfig: DEFAULT_RULES_CONFIG,
  deckRules: DEFAULT_DECK_FORMAT,
};

export type ReferenceValue = string | number | boolean | readonly string[];

export interface ResolvedReference {
  readonly reference: string;
  readonly value: ReferenceValue;
  /** The value as it should read inside a sentence or a value chip. */
  readonly display: string;
}

/**
 * The in-turn phases, in order, excluding the pre-game and terminal states.
 *
 * `reaction_window` is excluded as well, and not because it is unimportant. It
 * is not a *step* in the turn: it is a bounded interruption that can open at
 * four different points and then hands the turn back where it left off.
 * Printing it after "Turn End" — where the enum happens to put it — would
 * describe a turn that does not exist. Reaction windows are explained in their
 * own right instead; `PHASE_NAMES` still covers it so any UI showing the
 * current phase has a real name to show.
 */
export const TURN_PHASES: readonly string[] = MATCH_PHASES.filter(
  (phase) =>
    phase !== 'setup' &&
    phase !== 'mulligan' &&
    phase !== 'complete' &&
    phase !== 'reaction_window',
);

/** Player-facing name for a phase of the turn state machine. */
export const PHASE_NAMES: Readonly<Record<string, string>> = {
  setup: 'Setup',
  mulligan: 'Opening Hands',
  turn_start: 'Turn Start',
  draw: 'Draw',
  main_1: 'Main Phase',
  declare_attackers: 'Declare Attackers',
  assign_blockers: 'Assign Blockers',
  resolve_combat: 'Resolve Combat',
  main_2: 'Second Main Phase',
  turn_end: 'Turn End',
  reaction_window: 'Reaction Window',
  complete: 'Match Over',
};

/** What happens in each phase, written from the implemented state machine. */
export const PHASE_DESCRIPTIONS: Readonly<Record<string, string>> = {
  turn_start:
    'Exhausted units ready, maximum energy increases and current energy refills, and turn-start abilities trigger.',
  draw: 'The active player draws one card. The player who goes first skips this on their very first turn.',
  main_1:
    'The active player may play units, spells and relics, and use activated abilities, in any order they can pay for.',
  declare_attackers:
    'The active player chooses any number of ready units to attack with, and picks which opponent each one attacks.',
  assign_blockers:
    'Each attacked player independently assigns blockers to the attacks aimed at them. Skipped when nobody attacked.',
  resolve_combat: 'Combat damage is dealt, then every lethally damaged unit is defeated at once.',
  main_2: 'A second main phase, identical to the first.',
  turn_end:
    'Turn-end abilities trigger, end-of-turn effects expire, and the active player discards down to the maximum hand size.',
  reaction_window:
    'A bounded window in which players may play Reactions. Priority goes round the table starting with the active player; each player may play at most one Reaction, and the window closes once everybody has passed in a row. The cards played then resolve in reverse order — the last one played resolves first — and the turn carries on from where it paused.',
};

function displayOf(value: ReferenceValue): string {
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}

/**
 * Every reference a piece of content may name, resolved against one config.
 *
 * Built by enumerating the configuration objects rather than by hand, so adding
 * a provisional rule value makes it referenceable without touching this file —
 * and so a reference can never point at a value the engine does not have.
 */
export function resolveReferences(
  config: HelpConfig = DEFAULT_HELP_CONFIG,
): ReadonlyMap<string, ResolvedReference> {
  const entries = new Map<string, ResolvedReference>();

  const add = (reference: string, value: ReferenceValue): void => {
    entries.set(reference, { reference, value, display: displayOf(value) });
  };

  for (const [key, value] of Object.entries(config.matchConfig)) {
    add(`matchConfig.${key}`, value as ReferenceValue);
  }
  for (const [key, value] of Object.entries(config.deckRules)) {
    add(`deckRules.${key}`, value as ReferenceValue);
  }

  // Derived, but still computed from the same sources rather than authored.
  add(
    'matchConfig.turnPhases',
    TURN_PHASES.map((phase) => PHASE_NAMES[phase] ?? phase),
  );
  add('matchConfig.maxPlayers', 4);
  add('matchConfig.minPlayers', 2);
  add(
    'matchConfig.turnsToMaxEnergy',
    Math.max(
      1,
      Math.ceil(
        (config.matchConfig.energyCap - config.matchConfig.startingMaxEnergy) /
          Math.max(1, config.matchConfig.energyGainPerTurn) +
          1,
      ),
    ),
  );

  return entries;
}

/** Every reference name that currently resolves. Used by content validation. */
export function knownReferences(config: HelpConfig = DEFAULT_HELP_CONFIG): readonly string[] {
  return [...resolveReferences(config).keys()].sort();
}

const TEMPLATE_TOKEN = /\{([a-zA-Z][a-zA-Z0-9_.]*)\}/g;

/** Reference names a template string mentions, in order of appearance. */
export function templateReferences(text: string): readonly string[] {
  return [...text.matchAll(TEMPLATE_TOKEN)].map((match) => match[1] as string);
}

/**
 * Substitutes `{reference}` tokens with live configuration values.
 *
 * An unrecognised token is left verbatim rather than silently blanked, so a
 * mistake is visible in the UI as well as caught by validation — content is
 * never allowed to quietly invent or omit a rules number.
 */
export function resolveTemplate(text: string, config: HelpConfig = DEFAULT_HELP_CONFIG): string {
  const references = resolveReferences(config);
  return text.replace(TEMPLATE_TOKEN, (token, name: string) => {
    const resolved = references.get(name);
    return resolved ? resolved.display : token;
  });
}
