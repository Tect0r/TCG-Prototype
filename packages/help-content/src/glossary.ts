import { z } from 'zod';

/**
 * Game concepts that are not keywords: the words the rules themselves are
 * written in. Keywords live in `@tcg/card-data`'s keyword registry; this covers
 * ownership, zones, states and timing terms.
 *
 * Entries may quote live configuration with `{matchConfig.…}` references, the
 * same mechanism the rulebook and keyword definitions use.
 */

export const GLOSSARY_SCHEMA_VERSION = 1;

export const glossaryEntrySchema = z.strictObject({
  id: z
    .string()
    .min(1)
    .max(48)
    .regex(/^[a-z][a-z0-9_]*$/, 'Glossary IDs must be lowercase_snake_case.'),
  term: z.string().min(1).max(60),
  definition: z.string().min(1).max(600),
  /** Other glossary IDs worth reading next. Validated to resolve. */
  seeAlso: z.array(z.string().min(1)).default([]),
  /** Rulebook section IDs. Validated to resolve. */
  relatedRuleSections: z.array(z.string().min(1)).default([]),
});
export type GlossaryEntry = z.infer<typeof glossaryEntrySchema>;

export const glossarySchema = z.strictObject({
  schemaVersion: z.number().int().min(1).max(GLOSSARY_SCHEMA_VERSION),
  entries: z.array(glossaryEntrySchema).min(1),
});
export type Glossary = z.infer<typeof glossarySchema>;

const RAW_GLOSSARY = {
  schemaVersion: 1,
  entries: [
    {
      id: 'active_player',
      term: 'Active player',
      definition:
        'The player whose turn it is. Only the active player may play cards, use activated abilities or declare attackers.',
      seeAlso: ['seat_order'],
      relatedRuleSections: ['turn_structure'],
    },
    {
      id: 'battlefield',
      term: 'Battlefield',
      definition:
        'Where units fight. Each player has their own; units are never shared and never move to another player’s battlefield. There is no limit on how many units you may have out — energy is the only thing that holds you back.',
      seeAlso: ['relic_zone'],
      relatedRuleSections: ['card_types', 'combat'],
    },
    {
      id: 'commander_zone',
      term: 'Commander zone',
      definition:
        'Where your Commander sits for the whole match. It is not in your deck and, for now, is never deployed as a unit.',
      seeAlso: ['owner'],
      relatedRuleSections: ['commander'],
    },
    {
      id: 'controller',
      term: 'Controller',
      definition:
        'The player who currently decides what a card does. Usually the same as its owner. Ownership and control are tracked separately so a card can be returned to the right player when its controller is eliminated.',
      seeAlso: ['owner'],
      relatedRuleSections: ['multiplayer'],
    },
    {
      id: 'duration',
      term: 'Duration',
      definition:
        'How long a bonus or penalty lasts. Permanent lasts for the rest of the match. Until end of turn is removed when the current turn finishes. For that combat is shorter still — it is gone once combat damage has been dealt, before the second Main Phase. Until the beginning of your next turn is longer, and is the only one that covers your opponents’ turns in between. While the source is in play ends the moment the card that granted it leaves the battlefield. Whichever boundary applies, if the bonus was extra Health, losing it can defeat the unit straight away.',
      seeAlso: ['state_based_check', 'marked_damage'],
      relatedRuleSections: ['choices_and_targets'],
    },
    {
      id: 'discard_pile',
      term: 'Discard pile',
      definition:
        'A public pile holding cards that have been discarded, spells that have resolved and units that have been defeated. Anyone may look through it.',
      seeAlso: ['owner'],
      relatedRuleSections: ['card_types'],
    },
    {
      id: 'energy',
      term: 'Energy',
      definition:
        'The single resource used to pay for everything. It refills to your maximum at the start of your turn and does not carry over.',
      seeAlso: [],
      relatedRuleSections: ['energy'],
    },
    {
      id: 'exhausted',
      term: 'Exhausted',
      definition:
        'A unit that has already attacked or blocked, or that an effect has exhausted. Exhausted units cannot attack or block, and cannot pay a cost that asks them to exhaust. They ready again at the start of their controller’s next turn.',
      seeAlso: ['ready', 'summoning_sickness'],
      relatedRuleSections: ['combat'],
    },
    {
      id: 'instance',
      term: 'Card instance',
      definition:
        'One physical copy of a card in a match. Two copies of the same card are one card definition and two instances, each with its own damage, modifiers and state.',
      seeAlso: [],
      relatedRuleSections: ['card_anatomy'],
    },
    {
      id: 'marked_damage',
      term: 'Marked damage',
      definition:
        'Damage recorded on a unit. It stays there across turns until it is healed. A unit is defeated as soon as its marked damage reaches its current health.',
      seeAlso: ['state_based_check'],
      relatedRuleSections: ['damage_and_defeat'],
    },
    {
      id: 'owner',
      term: 'Owner',
      definition:
        'The player whose deck a card started in. Ownership never changes, which is what lets a card find its way home when it leaves play.',
      seeAlso: ['controller'],
      relatedRuleSections: ['multiplayer'],
    },
    {
      id: 'pending_choice',
      term: 'Pending choice',
      definition:
        'A decision the game is waiting on. While a choice is pending, everything else stops — no other player may act until it is answered.',
      seeAlso: ['resolution_queue'],
      relatedRuleSections: ['choices_and_targets'],
    },
    {
      id: 'ready',
      term: 'Ready',
      definition:
        'A unit that is upright and able to attack, if it is not summoning sick. Units ready at the start of their controller’s turn.',
      seeAlso: ['exhausted'],
      relatedRuleSections: ['combat'],
    },
    {
      id: 'relic_zone',
      term: 'Relic zone',
      definition:
        'A separate row for relics. Relics are never units, and each player may control up to {matchConfig.relicSlots} at a time. Playing another relic replaces the one you have: the old one goes to your discard pile without being destroyed or sacrificed, so nothing that watches for a relic dying will fire.',
      seeAlso: ['battlefield'],
      relatedRuleSections: ['card_types'],
    },
    {
      id: 'resolution_queue',
      term: 'Resolution queue',
      definition:
        'The single first-in, first-out line that effects resolve through. There is no stack and no priority: nobody can respond to an effect while it is resolving.',
      seeAlso: ['trigger', 'pending_choice'],
      relatedRuleSections: ['choices_and_targets'],
    },
    {
      id: 'seat_order',
      term: 'Seat order',
      definition:
        'The fixed circle players take turns in, decided when the match is created. Eliminated seats are skipped; the circle is never renumbered.',
      seeAlso: ['active_player'],
      relatedRuleSections: ['multiplayer'],
    },
    {
      id: 'state_based_check',
      term: 'State-based check',
      definition:
        'An automatic sweep run after every instruction and after combat damage. It defeats lethally damaged units and eliminates players at zero health, all at the same time.',
      seeAlso: ['marked_damage'],
      relatedRuleSections: ['damage_and_defeat'],
    },
    {
      id: 'summoning_sickness',
      term: 'Summoning sickness',
      definition:
        'A unit cannot attack on the turn it arrives, unless it has Swift. It can still block that turn.',
      seeAlso: ['exhausted'],
      relatedRuleSections: ['playing_cards', 'combat'],
    },
    {
      id: 'target',
      term: 'Target',
      definition:
        'A card, unit or player an effect points at. The server works out the legal set; the client only shows it. A spell with no legal target for a required target cannot be played at all.',
      seeAlso: ['valid_target'],
      relatedRuleSections: ['choices_and_targets'],
    },
    {
      id: 'trigger',
      term: 'Trigger',
      definition:
        'An ability that fires by itself when something happens. Triggers join the resolution queue behind whatever is already in it.',
      seeAlso: ['resolution_queue'],
      relatedRuleSections: ['choices_and_targets'],
    },
    // The `unit_slot` term was removed rather than reworded: the battlefield has
    // no slots to explain (ruleset update §7). Nothing in the game refers to a
    // position on the battlefield any more.
    {
      id: 'valid_target',
      term: 'Valid target',
      definition:
        'A target that still satisfies the effect’s filter at the moment the effect resolves. A target that has become invalid is skipped, and the rest of the effect still happens.',
      seeAlso: ['target'],
      relatedRuleSections: ['choices_and_targets'],
    },
  ],
} as const;

export const GLOSSARY: Glossary = glossarySchema.parse(RAW_GLOSSARY);

export const GLOSSARY_ENTRIES: readonly GlossaryEntry[] = [...GLOSSARY.entries].sort((a, b) =>
  a.term.localeCompare(b.term),
);

export function glossaryEntry(id: string): GlossaryEntry | undefined {
  return GLOSSARY.entries.find((entry) => entry.id === id);
}
