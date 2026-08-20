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
        'The player whose turn it is. Only the active player may play units, spells and relics, deploy their Commander, use activated abilities or declare attackers. Everyone else is limited to assigning blockers when attacked and to playing a Reaction inside an open window.',
      seeAlso: ['seat_order', 'reaction_window'],
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
      term: 'Command Zone',
      definition:
        'Where your Commander starts, and where it returns to when it is defeated. It is never part of your deck and is never drawn. From here you may deploy it to the battlefield for its cost; a Commander with no printed cost stays here for the whole match.',
      seeAlso: ['owner', 'commander_cost_tax'],
      relatedRuleSections: ['commander'],
    },
    {
      id: 'commander_cost_tax',
      term: 'Commander cost tax',
      definition:
        'The surcharge a Commander carries for having been defeated. Each defeat adds {matchConfig.commanderCostPerDefeat} energy to the cost of deploying it again, and the total is capped at {matchConfig.commanderCostCap}. A defeated Commander is never lost — the escalating cost is the whole of the penalty.',
      seeAlso: ['commander_zone', 'energy'],
      relatedRuleSections: ['commander', 'damage_and_defeat'],
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
      id: 'delayed_effect',
      term: 'Delayed effect',
      definition:
        'A promise a card makes for later in the same turn — "return it to your hand at the end of the turn", or "when it is defeated this turn, create two Tokens". It is set up when that instruction resolves, everyone can see it waiting, and it never survives the turn it was made on. The card it is about is decided once and never chosen again: if that card moves to a different zone before the promise comes due, the promise is dropped. A promise that was waiting for an event which never happened simply ends.',
      seeAlso: ['duration', 'trigger', 'resolution_queue'],
      relatedRuleSections: ['choices_and_targets'],
    },
    {
      id: 'discard_pile',
      term: 'Discard pile',
      definition:
        'A public pile holding cards that have been discarded, spells that have resolved and units that have been defeated. Anyone may look through it.',
      seeAlso: ['owner', 'removed_from_game'],
      relatedRuleSections: ['card_types'],
    },
    {
      id: 'removed_from_game',
      term: 'Removed from the game',
      definition:
        'Gone for good. A card removed from the game leaves whatever pile it was in and is not in the discard pile, the deck, a hand or anywhere else a card can be reached: nothing may target it, and no effect returns it. It is the one place a card can go and not come back, which is why so few cards do it. You can still see how many cards a player has had removed.',
      seeAlso: ['discard_pile', 'instance'],
      relatedRuleSections: ['card_types'],
    },
    {
      id: 'energy',
      term: 'Energy',
      definition:
        'The single resource used to pay for everything. Your energy is set to your maximum at the start of your own turn. Whatever you do not spend stays with you through everybody else’s turns — which is what pays for a Reaction — and is then replaced, not topped up, by the next refill.',
      seeAlso: ['reaction_window', 'cost_reduction'],
      relatedRuleSections: ['energy'],
    },
    {
      id: 'cost_reduction',
      term: 'Cost reduction',
      definition:
        'A card that costs less than its printed cost. The discount is worked out fresh every time the cost is asked for, so a card whose reduction counts something — “1 less for each friendly Unit defeated this turn” — gets cheaper the moment that number goes up, and goes straight back to full price if it goes down. A printed “to a minimum cost of N” is a floor, never a raise: it can never make a card that already cost less than N cost more.',
      seeAlso: ['energy', 'derived_value'],
      relatedRuleSections: ['energy'],
    },
    {
      id: 'derived_value',
      term: 'Derived value',
      definition:
        'A number a card works out instead of printing. It may count something — “for each Goblin you control” — or read a card’s own statline, as in “gains Health equal to its ATK”. Either way it is read at the moment the effect resolves, using the values you can see at that moment: a unit that was buffed after the ability triggered is measured as it is now, not as it was.',
      seeAlso: ['cost_reduction', 'duration'],
      relatedRuleSections: ['choices_and_targets'],
    },
    {
      id: 'exhausted',
      term: 'Exhausted',
      definition:
        'A unit that has already attacked or blocked, or that an effect has exhausted. Exhausted units cannot attack or block, and cannot pay a cost that asks them to exhaust. They ready again at the start of their controller’s next turn.',
      seeAlso: ['ready', 'newly_deployed'],
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
      id: 'token',
      term: 'Token',
      definition:
        'A unit an effect creates rather than one played from a hand. A Token on the battlefield is a Unit in every sense: anything that says “a Unit” — a target, an ability, an attack, an additional cost — may use one, unless it says a nontoken Unit or a Unit card. A card that asks only for Tokens still means only Tokens. A Token is never a Unit card, so “a Unit card in your discard pile” never means one, and a Token that leaves the battlefield stops existing rather than going anywhere.',
      seeAlso: ['token_stack', 'instance', 'additional_cost'],
      relatedRuleSections: ['card_types'],
    },
    {
      id: 'token_stack',
      term: 'Token stack',
      definition:
        'A way of drawing the board, not a game object. Tokens share one card with a count only when they match in every way that matters: same token, stats, damage, Ready or Exhausted, Newly Deployed, keywords, Barrier, and job in this combat. Any token that differs is drawn on its own. A stack is never what you pick: open it — by click, or Enter, with Escape to close — and every token is there by name, each still its own unit to attack, block, target, sacrifice or activate with. A token you pick leaves its stack. A card affecting every token of a kind may cross several stacks.',
      seeAlso: ['instance', 'marked_damage', 'newly_deployed'],
      relatedRuleSections: ['card_types'],
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
        'A unit that is upright and able to attack, provided it is not Newly Deployed. Units ready at the start of their controller’s turn, in the same step that clears Newly Deployed.',
      seeAlso: ['exhausted', 'newly_deployed'],
      relatedRuleSections: ['combat'],
    },
    {
      id: 'replacement_effect',
      term: 'Replacement effect',
      definition:
        'An effect that changes something as it happens, rather than reacting to it afterwards. “The first enemy Unit deployed each turn enters Exhausted” does not exhaust the unit once it has arrived — the unit arrives Exhausted, and there is no moment in between for anything to see it Ready or respond to it. The card responsible is always named in the log, so you can tell which permanent did it.',
      seeAlso: ['ready_step', 'exhausted', 'newly_deployed'],
      relatedRuleSections: ['turn_structure'],
    },
    {
      id: 'ready_step',
      term: 'Ready Step',
      definition:
        'The moment at the start of your turn when your Exhausted permanents ready and Newly Deployed clears. A card can stop one permanent readying there — “it does not Ready during its controller’s next Ready Step” — which is used up by that one Ready Step whether or not the permanent was Exhausted, and only stops that step: an effect that says “Ready target Unit” still works. Newly Deployed clears either way.',
      seeAlso: ['ready', 'exhausted', 'replacement_effect', 'newly_deployed'],
      relatedRuleSections: ['turn_structure'],
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
        'The single first-in, first-out line that effects resolve through. There is no stack and no priority: nobody can respond to an effect while it is resolving. A Reaction window is the one exception to the ordering — the cards played into it resolve last in, first out — and even there nothing may interrupt a card that has started.',
      seeAlso: ['trigger', 'pending_choice', 'reaction_window'],
      relatedRuleSections: ['choices_and_targets', 'reactions'],
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
      id: 'newly_deployed',
      term: 'Newly Deployed',
      definition:
        'The state a permanent has until it has been through its controller’s Ready Step. A Newly Deployed unit cannot attack and cannot pay an “Exhaust this unit” cost; it may still block, and it may still pay every other kind of cost. Rush lifts both restrictions without removing the state. It lasts through opponents’ turns and clears at its controller’s next Turn Start.',
      seeAlso: ['exhausted', 'ready'],
      relatedRuleSections: ['playing_cards', 'combat'],
    },
    {
      id: 'reaction_window',
      term: 'Reaction window',
      definition:
        'A bounded interruption in which players may play Reactions, opened around declaring attackers, assigning blockers, combat damage, or a spell being played. It opens only if somebody could legally use it. Priority goes round the table once, to the active player first and then clockwise; each player may play at most {matchConfig.reactionsPerPlayerPerWindow} Reaction, playing does not start the round again, and the cards resolve last in, first out.',
      seeAlso: ['resolution_queue', 'energy'],
      relatedRuleSections: ['reactions', 'turn_structure'],
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
      id: 'additional_cost',
      term: 'Additional cost',
      definition:
        'Something a card makes you pay on top of its energy cost — sacrificing a unit, for instance. You pay it as you play the card, before an opponent gets a chance to answer it, and you do not get it back if the card is countered.',
      seeAlso: ['energy', 'optional_effect'],
      relatedRuleSections: ['energy', 'choices_and_targets'],
    },
    {
      id: 'optional_effect',
      term: 'You may',
      definition:
        'A step of a card you can decline. The game asks you yes or no when the step comes up; saying no skips only that step and the rest of the card still happens. A later step that says "if you do" only happens when the optional step actually changed something.',
      seeAlso: ['pending_choice', 'additional_cost'],
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
      id: 'each_player_choice',
      term: 'Each player chooses',
      definition:
        'A choice every player makes at once. You are each asked separately, starting with the player whose card it is and going clockwise, and nothing takes effect until the last answer is in — so nobody chooses knowing what anyone else picked. A player with no legal option is skipped, and a player knocked out before the last answer takes their choice with them.',
      seeAlso: ['pending_choice', 'seat_order'],
      relatedRuleSections: ['choices_and_targets'],
    },
    {
      id: 'divided_damage',
      term: 'Divided damage',
      definition:
        'Damage a card gives you as a total to split rather than an amount for each target. You allocate every point to a legal target — you may pile them all onto one — and each target then takes its whole share as a single hit, so Barrier and prevention answer the share, not the individual points.',
      seeAlso: ['target', 'pending_choice'],
      relatedRuleSections: ['choices_and_targets', 'combat'],
    },
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
