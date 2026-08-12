import type { CardDefinition } from './schema/card.js';

/**
 * The one place a card's fields are split into "the engine reads this" and "the
 * engine does not" (M01.3).
 *
 * Two hand-maintained field lists used to answer that question — one in the
 * spectator's `cardPoolHash`, one in the simulator's `cardMechanics` — and they
 * disagreed. The spectator's omitted `additionalCosts`, so a replay stayed
 * "compatible" after a card's sacrifice cost changed; the simulator's omitted
 * `additionalCosts`, `reaction` and `implemented`. Both were lists someone had
 * to remember to extend, and neither failed when nobody did.
 *
 * {@link CARD_FIELD_KINDS} replaces both. It is a mapped type over
 * `keyof CardDefinition`, so adding a field to the card schema without
 * classifying it here is a **compile error**, not a silently unhashed mechanic.
 *
 * The projections below are the only supported way to ask "what does the engine
 * execute for this card". Hashing is left to the caller, because the two callers
 * cannot share a digest: the simulator uses SHA-256 from `node:crypto`, and the
 * spectator's hash also runs in the browser.
 */

/**
 * What a card field is for.
 *
 * - `identity` — the card's permanent name. Present in every projection, so a
 *   projection can never be confused with another card's.
 * - `mechanics` — read by the engine or by deck legality. Changing it can change
 *   how a match plays out, so it must move every replay hash.
 * - `pilot` — authored metadata pilots and deck generation read. Cannot change a
 *   match the engine replays from a recorded decision log, but can change which
 *   decisions a pilot would make.
 * - `presentation` — player-facing text. Can never change a match.
 */
export type CardFieldKind = 'identity' | 'mechanics' | 'pilot' | 'presentation';

/**
 * Every field of a `CardDefinition`, classified.
 *
 * Four classifications are easy to get wrong and are called out here rather than
 * left to be rediscovered:
 *
 * - `tags` are **mechanical**. `CardFilter` matches on them, so a tag edit can
 *   change which Units a lord buffs or which cards a Spell may target.
 * - `unique` and `collectible` are **mechanical**. Deck legality reads both, so
 *   they change what can be played.
 * - `additionalCosts` is **mechanical**, and was the omission this map exists to
 *   make impossible. An additional cost is paid before the card is queued and is
 *   never refunded (CLAUDE.md), so changing one changes what a match cost its
 *   players even when nothing else about the card moved.
 * - `implemented` is **mechanical**. `validateDeck` refuses a deck containing an
 *   unimplemented card or Commander (M01.2), so flipping the flag changes which
 *   decks exist.
 * - `schemaVersion` is **mechanical**. It states which reading of the same JSON
 *   the data was written for; a migration that stamps a default (v3 → v4 wrote
 *   `activeZone` onto every ability) changes behaviour without changing any
 *   authored field.
 *
 * `unsupportedReason` is presentation: it is the sentence shown beside a card
 * that cannot be played, and `implemented` — next to it, and mechanical — is the
 * field that decides anything.
 */
export const CARD_FIELD_KINDS: { readonly [K in keyof CardDefinition]-?: CardFieldKind } = {
  id: 'identity',

  schemaVersion: 'mechanics',
  type: 'mechanics',
  colorIdentity: 'mechanics',
  cost: 'mechanics',
  attack: 'mechanics',
  health: 'mechanics',
  unique: 'mechanics',
  collectible: 'mechanics',
  tags: 'mechanics',
  keywords: 'mechanics',
  effects: 'mechanics',
  additionalCosts: 'mechanics',
  abilities: 'mechanics',
  activatedAbilities: 'mechanics',
  staticAbilities: 'mechanics',
  delayedAbilities: 'mechanics',
  reaction: 'mechanics',
  implemented: 'mechanics',

  role: 'pilot',
  powerClass: 'pilot',
  design: 'pilot',

  name: 'presentation',
  displayText: 'presentation',
  text: 'presentation',
  unsupportedReason: 'presentation',
};

/**
 * Fields whose order is not part of their meaning, and which are therefore
 * sorted before hashing.
 *
 * Only sets belong here. `effects`, `additionalCosts` and the ability lists are
 * **ordered** — an effect list is a sequence of instructions, and "if you do"
 * refers to the instruction before it — so reordering one is a real change and
 * must move the hash.
 */
const UNORDERED_FIELDS: ReadonlySet<string> = new Set(['colorIdentity', 'keywords', 'tags']);

function fieldsOfKind(kind: CardFieldKind): readonly (keyof CardDefinition)[] {
  return (Object.keys(CARD_FIELD_KINDS) as (keyof CardDefinition)[])
    .filter((field) => CARD_FIELD_KINDS[field] === kind)
    .sort((left, right) => left.localeCompare(right));
}

export const IDENTITY_CARD_FIELDS = fieldsOfKind('identity');
export const MECHANICS_CARD_FIELDS = fieldsOfKind('mechanics');
export const PILOT_CARD_FIELDS = fieldsOfKind('pilot');
export const PRESENTATION_CARD_FIELDS = fieldsOfKind('presentation');

/** A projection of a card: identity plus the fields of one kind. */
export type CardProjection = Readonly<Record<string, unknown>>;

function normalize(field: keyof CardDefinition, value: unknown): unknown {
  // An absent optional field and an explicit `null` mean the same thing here —
  // "this card does not have one" — so they must not hash differently.
  if (value === undefined) return null;
  if (UNORDERED_FIELDS.has(field) && Array.isArray(value)) {
    return [...(value as string[])].sort((left, right) => left.localeCompare(right));
  }
  return value;
}

function project(card: CardDefinition, fields: readonly (keyof CardDefinition)[]): CardProjection {
  const projection: Record<string, unknown> = {};
  for (const field of [...IDENTITY_CARD_FIELDS, ...fields]) {
    projection[field] = normalize(field, (card as Record<string, unknown>)[field]);
  }
  return projection;
}

/**
 * The executable projection of a card: everything the engine or deck legality
 * reads, and nothing else.
 *
 * Two cards with equal mechanics projections play identically. That is the whole
 * contract, and it is what lets a replay recorded against one card pool be
 * refused against another.
 */
export function cardMechanics(card: CardDefinition): CardProjection {
  return project(card, MECHANICS_CARD_FIELDS);
}

/** Authored metadata pilots and deck generation read but the engine does not. */
export function cardPilotMetadata(card: CardDefinition): CardProjection {
  return project(card, PILOT_CARD_FIELDS);
}

/** Player-facing content. Changing it can never change a match. */
export function cardPresentation(card: CardDefinition): CardProjection {
  return project(card, PRESENTATION_CARD_FIELDS);
}

/**
 * JSON with every object key sorted, so two structurally equal values built in a
 * different order serialize identically.
 *
 * Deliberately dependency-free rather than `node:crypto`-based: the spectator
 * hashes a card pool in the browser as well as in Node, and a serialization that
 * differed between the two would break the reproducibility claim it exists to
 * support.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return Object.fromEntries(entries.map(([key, entry]) => [key, sortDeep(entry)]));
  }
  return value;
}

/**
 * The canonical mechanics snapshot of a whole card pool, as a string.
 *
 * Sorted by card ID and canonically serialized, so the snapshot depends on the
 * cards a pool contains and never on the order they were loaded in. Callers hash
 * this with whatever digest suits their environment.
 */
export function cardPoolMechanicsJson(cards: readonly CardDefinition[]): string {
  const sorted = [...cards].sort((left, right) => left.id.localeCompare(right.id));
  return canonicalJson(sorted.map(cardMechanics));
}
