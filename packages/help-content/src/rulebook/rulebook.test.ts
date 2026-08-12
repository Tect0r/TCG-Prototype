import { describe, expect, it } from 'vitest';
import { KEYWORD_LIST } from '@tcg/card-data';
import { DEFAULT_DECK_FORMAT, DEVELOPMENT_DECK_FORMAT } from '@tcg/deck';
import { DEFAULT_RULES_CONFIG } from '@tcg/rules-engine';
import { GLOSSARY } from '../glossary.js';
import { DEFAULT_HELP_CONFIG, type HelpConfig } from '../references.js';
import { RULEBOOK_SECTION_IDS, loadRulebook, type ResolvedRulebook } from './load.js';
import { searchRulebook } from './search.js';

const rulebook = loadRulebook();

/**
 * Every text fragment a section renders, flattened and lower-cased.
 *
 * `searchText` is what the loader itself built, so an assertion here covers the
 * keyword registry and the glossary too — both are rendered *into* a section
 * rather than sitting beside it.
 */
function textOf(sectionId: string, book: ResolvedRulebook = rulebook): string {
  const section = book.sections.find((entry) => entry.id === sectionId);
  if (!section) throw new Error(`No section "${sectionId}"`);
  return section.searchText;
}

/** One resolved `configValue` chip, by the label it is printed under. */
function configValue(sectionId: string, label: string, book: ResolvedRulebook = rulebook): string {
  const section = book.sections.find((entry) => entry.id === sectionId);
  if (!section) throw new Error(`No section "${sectionId}"`);
  const block = section.blocks.find(
    (entry) => entry.type === 'configValue' && entry.label === label,
  );
  if (block?.type !== 'configValue') {
    throw new Error(`No configValue labelled "${label}" in "${sectionId}"`);
  }
  return block.value;
}

describe('rulebook content', () => {
  it('contains every section the game needs explained', () => {
    const required = [
      'objective',
      'setup',
      'deck_building',
      'card_anatomy',
      'card_types',
      'energy',
      'turn_structure',
      'playing_cards',
      'reactions',
      'combat',
      'damage_and_defeat',
      'commander',
      'multiplayer',
      'choices_and_targets',
      'keywords',
      'glossary',
      'example_first_turn',
      'edge_cases',
    ];
    for (const id of required) {
      expect(RULEBOOK_SECTION_IDS, id).toContain(id);
    }
  });

  it('renders sections in a defined order', () => {
    const ids = rulebook.sections.map((section) => section.id);
    expect(ids[0]).toBe('objective');
    expect(ids[ids.length - 1]).toBe('edge_cases');
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('leaves no unresolved reference anywhere in the book', () => {
    for (const section of rulebook.sections) {
      expect(section.searchText, section.id).not.toMatch(/\{[a-zA-Z]/);
    }
    expect(rulebook.intro).not.toMatch(/\{[a-zA-Z]/);
  });

  it('shows live configuration values, not copied numbers', () => {
    const objective = rulebook.sections.find((section) => section.id === 'objective');
    const starting = objective?.blocks.find(
      (block) => block.type === 'configValue' && block.label === 'Starting health',
    );
    expect(starting).toMatchObject({ value: String(DEFAULT_RULES_CONFIG.startingHealth) });
  });

  it('follows a changed configuration everywhere it is quoted', () => {
    const houseRules: HelpConfig = {
      ...DEFAULT_HELP_CONFIG,
      matchConfig: { ...DEFAULT_HELP_CONFIG.matchConfig, startingHealth: 45, relicSlots: 9 },
      deckRules: { ...DEFAULT_HELP_CONFIG.deckRules, deckSize: 60 },
    };
    const modified = loadRulebook(houseRules);

    const objective = modified.sections.find((section) => section.id === 'objective');
    expect(
      objective?.blocks.find((block) => block.type === 'configValue' && block.value === '45'),
    ).toBeDefined();

    const deckBuilding = modified.sections.find((section) => section.id === 'deck_building');
    expect(deckBuilding?.searchText).toContain('60');

    // The glossary quotes the relic limit in prose, through the same reference
    // mechanism. (It used to quote the unit-slot count; there are no slots to
    // quote now — ruleset update §7.)
    const glossary = modified.sections.find((section) => section.id === 'glossary');
    expect(glossary?.searchText).toContain('control up to 9');
  });

  it('builds the keyword index from the shared registry', () => {
    const section = rulebook.sections.find((entry) => entry.id === 'keywords');
    const index = section?.blocks.find((block) => block.type === 'keywordIndex');
    expect(index).toBeDefined();
    if (index?.type !== 'keywordIndex') throw new Error('expected a keyword index');

    expect(index.keywords.map((keyword) => keyword.id)).toEqual(
      KEYWORD_LIST.map((keyword) => keyword.id),
    );
    // Armored quotes a configured number, resolved from the live config.
    const armored = index.keywords.find((keyword) => keyword.id === 'armored');
    expect(armored?.shortDefinition).toContain(String(DEFAULT_RULES_CONFIG.armoredReduction));
    expect(armored?.shortDefinition).not.toMatch(/\{/);
  });

  it('tells players plainly which keywords do nothing yet', () => {
    const section = rulebook.sections.find((entry) => entry.id === 'keywords');
    const index = section?.blocks.find((block) => block.type === 'keywordIndex');
    if (index?.type !== 'keywordIndex') throw new Error('expected a keyword index');

    for (const keyword of index.keywords.filter((entry) => !entry.implemented)) {
      expect(keyword.shortDefinition, keyword.id).toMatch(/not implemented|no effect/i);
    }
  });

  it('builds the glossary index from the shared glossary', () => {
    const section = rulebook.sections.find((entry) => entry.id === 'glossary');
    const index = section?.blocks.find((block) => block.type === 'glossaryIndex');
    if (index?.type !== 'glossaryIndex') throw new Error('expected a glossary index');
    expect(index.entries.length).toBe(GLOSSARY.entries.length);
  });

  it('lists the turn phases from the engine state machine', () => {
    const section = rulebook.sections.find((entry) => entry.id === 'turn_structure');
    const index = section?.blocks.find((block) => block.type === 'phaseList');
    if (index?.type !== 'phaseList') throw new Error('expected a phase list');

    expect(index.phases.map((phase) => phase.id)).toEqual([
      'turn_start',
      'draw',
      'main_1',
      'declare_attackers',
      'assign_blockers',
      'resolve_combat',
      'main_2',
      'turn_end',
    ]);
    for (const phase of index.phases) {
      expect(phase.name, phase.id).not.toBe(phase.id);
      expect(phase.description.length, phase.id).toBeGreaterThan(0);
    }
  });

  it('describes only rules the engine implements', () => {
    // Blocking is restricted to the attacked player.
    expect(textOf('combat')).toMatch(/only the player being attacked/i);
  });
});

/**
 * M01.4. Each of these pins a rule the book used to get wrong, and pins it as a
 * positive statement of the current rule rather than as the absence of the old
 * sentence — a book that simply deleted the wrong claim would still be a book
 * that does not teach the game.
 *
 * `searchText` is lower-cased by the loader, so the expectations are too.
 */
describe('the rulebook teaches the implemented ruleset', () => {
  it('describes Commanders as deployable permanents with a printed cost', () => {
    const text = textOf('commander');
    expect(text).toMatch(/deploy your commander by paying its cost/);
    expect(text).toMatch(/behaves as a unit/);
    expect(text).toMatch(/arrives newly deployed/);
    // A Commander with no printed cost is not free, it is undeployable.
    expect(text).toMatch(/no printed cost cannot be deployed/);
    // The Command Zone/battlefield split on abilities (rule adjustment §3).
    expect(text).toMatch(/stops the moment the commander is deployed/);
    // The card-anatomy entry has to agree that a Commander has a payable cost.
    expect(textOf('card_anatomy')).toMatch(/printed cost is what you pay to deploy it/);
  });

  it('describes Commander defeat as a return to the Command Zone, not a loss', () => {
    const text = textOf('commander');
    expect(text).toMatch(/returns to your command zone immediately/);
    expect(text).toMatch(/does not go to your discard pile/);
    expect(textOf('objective')).toMatch(/losing your commander is not losing the match/);
    // Every route to a defeat lands in the same place (effects.ts#restDefeated).
    expect(textOf('edge_cases')).toMatch(
      /sacrifice, destruction and lethal damage all send it back/,
    );
  });

  it('quotes the Commander cost tax and its cap from live configuration', () => {
    expect(configValue('commander', 'Extra energy per Commander defeat')).toBe(
      String(DEFAULT_RULES_CONFIG.commanderCostPerDefeat),
    );
    expect(configValue('commander', "Highest a Commander's deployment cost can reach")).toBe(
      String(DEFAULT_RULES_CONFIG.commanderCostCap),
    );

    // And the prose follows the same dials rather than writing the numbers out.
    const houseRules: HelpConfig = {
      ...DEFAULT_HELP_CONFIG,
      matchConfig: {
        ...DEFAULT_HELP_CONFIG.matchConfig,
        commanderCostPerDefeat: 3,
        commanderCostCap: 17,
      },
    };
    const modified = loadRulebook(houseRules);
    expect(textOf('commander', modified)).toContain('adds 3 energy');
    expect(textOf('commander', modified)).toContain('never costs more than 17 energy');
    expect(textOf('damage_and_defeat', modified)).toContain('costs 3 more energy');
  });

  it('describes Wave 1 construction as singleton, in the format’s own numbers', () => {
    expect(configValue('deck_building', 'Deck size')).toBe(`${DEFAULT_DECK_FORMAT.deckSize} cards`);
    expect(configValue('deck_building', 'One copy of each card only')).toBe('Yes');
    expect(DEFAULT_DECK_FORMAT.singleton).toBe(true);

    const text = textOf('deck_building');
    expect(text).toMatch(/no card may appear in your deck twice/);
    // The rule that a copy limit alone cannot express (ADR 0016 §1).
    expect(text).toMatch(/splitting a card across two entries/);
    expect(text).toMatch(/the commander is not part of the deck/);
  });

  it('is written from the active format rather than hard-coded to Wave 1', () => {
    const development: HelpConfig = {
      ...DEFAULT_HELP_CONFIG,
      deckRules: DEVELOPMENT_DECK_FORMAT,
    };
    const modified = loadRulebook(development);
    expect(configValue('deck_building', 'Deck size', modified)).toBe(
      `${DEVELOPMENT_DECK_FORMAT.deckSize} cards`,
    );
    // The fixture format is not singleton, and the book must say so.
    expect(DEVELOPMENT_DECK_FORMAT.singleton).toBe(false);
    expect(configValue('deck_building', 'One copy of each card only', modified)).toBe('No');
    expect(configValue('deck_building', 'Copies of a regular card', modified)).toBe(
      String(DEVELOPMENT_DECK_FORMAT.copyLimit),
    );
  });

  it('tells players the pool is format-scoped and refuses unfinished cards', () => {
    const text = textOf('deck_building');
    expect(text).toMatch(/not every card that exists/);
    expect(text).toMatch(/still being built is refused by name/);
    expect(text).toMatch(/never quietly played as a blank/);
  });

  it('says unspent energy survives the opponents’ turns and is then replaced', () => {
    const text = textOf('energy');
    expect(text).toMatch(/not lost at the end of your turn/);
    expect(text).toMatch(/stays with you through everybody else's turns/);
    expect(text).toMatch(/pays for a reaction played on an opponent's turn/);
    // Replaced, not topped up — the distinction the engine actually implements.
    expect(text).toMatch(/replaces what you were holding rather than adding to it/);
    // The glossary entry is rendered into the glossary section and must agree.
    expect(textOf('glossary')).toMatch(/replaced, not topped up/);
  });

  it('explains where Reaction windows open and how one runs', () => {
    const text = textOf('reactions');
    for (const moment of [
      /after attackers are declared/,
      /after blockers are assigned/,
      /after combat damage has been dealt/,
      /when a player plays a spell/,
    ]) {
      expect(text, String(moment)).toMatch(moment);
    }
    expect(text).toMatch(/opens only if somebody could actually use it/);
    expect(text).toMatch(/active player first, then clockwise/);
    expect(text).toMatch(/last in, first out/);
    // Implemented behaviour: a play restarts the round, which is the one way a
    // Reaction can answer another (reactions.ts#handlePlayReaction).
    expect(text).toMatch(/playing a reaction restarts the round/);
    expect(text).toMatch(/countered card goes to its owner's discard pile/);
    expect(text).toMatch(/cost is not refunded/);
  });

  it('quotes the per-window Reaction limit from configuration', () => {
    const houseRules: HelpConfig = {
      ...DEFAULT_HELP_CONFIG,
      matchConfig: { ...DEFAULT_HELP_CONFIG.matchConfig, reactionsPerPlayerPerWindow: 4 },
    };
    expect(textOf('reactions')).toContain(
      `at most ${DEFAULT_RULES_CONFIG.reactionsPerPlayerPerWindow} reaction in one window`,
    );
    expect(textOf('reactions', loadRulebook(houseRules))).toContain(
      'at most 4 reaction in one window',
    );
  });

  it('tells players that opponents may act, and exactly when', () => {
    const text = textOf('turn_structure');
    expect(text).toMatch(/opponents act only inside named windows/);
    expect(text).toMatch(/you play a reaction inside one of the bounded windows/);
    // Reaction windows are not a phase of the turn, and the phase list says so.
    expect(text).toMatch(/an interruption rather than a phase of the turn/);
  });

  it('describes Guardian as the compulsory-block rule the engine enforces', () => {
    const text = textOf('combat');
    expect(text).toMatch(/guardian makes blocking compulsory/);
    expect(text).toMatch(
      /at least as many of the attacks aimed at you as you have ready guardians/,
    );
    // Any legal blocker may discharge the obligation (engine.ts).
    expect(text).toMatch(/it does not have to be the guardians themselves/);
    expect(text).toMatch(/evasive ones, do not count towards the obligation/);

    const guardian = KEYWORD_LIST.find((keyword) => keyword.id === 'guardian');
    expect(guardian?.implemented).toBe(true);
    expect(textOf('keywords')).not.toMatch(/guardian currently does nothing/);
  });

  it('uses Newly Deployed and Rush, and never the retired vocabulary', () => {
    const playing = textOf('playing_cards');
    expect(playing).toMatch(/arrives ready, but newly deployed/);
    expect(playing).toMatch(/unless it has rush/);
    // The three restrictions, stated as the engine has them.
    expect(playing).toMatch(/cannot pay an "exhaust this unit" cost/);
    expect(playing).toMatch(/it can block on the turn it arrives/);
    expect(playing).toMatch(/lasts until your own next turn start/);
    expect(textOf('combat')).toMatch(/a newly deployed unit may still block/);

    expect(GLOSSARY.entries.map((entry) => entry.id)).toContain('newly_deployed');
    expect(GLOSSARY.entries.map((entry) => entry.id)).not.toContain('summoning_sickness');
  });

  it('states that the battlefield is unbounded and exactly one Relic is active', () => {
    expect(textOf('card_types')).toMatch(/there is no limit on units/);
    expect(textOf('edge_cases')).toMatch(/there is no unit limit/);
    expect(configValue('card_types', 'Relics per player')).toBe(
      String(DEFAULT_RULES_CONFIG.relicSlots),
    );
    expect(textOf('playing_cards')).toMatch(/it replaces the one you have/);
    // Replacement is a rules action, not a defeat (ADR 0016 §3).
    expect(textOf('playing_cards')).toMatch(/not destroyed and not sacrificed/);
  });

  it('separates damage to a player from damage to a deployed Commander', () => {
    const text = textOf('damage_and_defeat');
    expect(text).toMatch(/means that player's own health total/);
    expect(text).toMatch(/whether or not any commander has been deployed/);
    expect(text).toMatch(/the two pools never touch/);
    expect(textOf('commander')).toMatch(/"damage to your commander" means damage to you/);
  });

  it('describes the Overwhelm split and what Barrier does about it', () => {
    const text = textOf('combat');
    expect(text).toMatch(/unless the attacker has overwhelm/);
    // Current Health, before prevention — ADR 0016 Q-D, including the part that
    // diverges from the update's §9.
    expect(text).toMatch(/damage equal to its current health/);
    expect(text).toMatch(/damage already marked on the blocker does not increase the overflow/);
    expect(text).toMatch(/barrier on the blocker prevents only the share assigned to the blocker/);
    expect(text).toMatch(/overflow that overwhelm sent to the player is a separate hit/);
    expect(text).toMatch(/separate hit and still lands/);
  });

  it('keeps genuinely unresolved rules visible', () => {
    const resilient = KEYWORD_LIST.find((keyword) => keyword.id === 'resilient');
    expect(resilient?.implemented).toBe(false);
    const unresolved = textOf('edge_cases');
    expect(unresolved).toMatch(/resilient, is printed on cards but does nothing yet/);
    // The Reaction chaining policy is provisional and versioned, not settled.
    expect(unresolved).toMatch(/deliberately the smallest workable rule and may be replaced/);
  });

  /**
   * Every claim the ruleset update retired, in one sweep over the whole book.
   *
   * The per-rule tests above prove the new sentence is present; this proves the
   * old one is gone from *everywhere*, including the keyword registry and the
   * glossary, which are rendered into sections rather than living beside them.
   */
  it('contains none of the retired claims, anywhere', () => {
    const retired: readonly (readonly [RegExp, string])[] = [
      [/summoning sick/, 'Newly Deployed replaced summoning sickness'],
      [/\bswift\b/, 'the Swift keyword was renamed to Rush'],
      [/no instants/, 'Reactions are playable on an opponent’s turn'],
      [/no acting on someone else/, 'Reaction windows exist'],
      [/never deployed/, 'Commanders are deployable'],
      [/commanders do not fight/, 'Commanders are deployable'],
      [/energy you do not spend is lost/, 'unspent energy carries over'],
      [/never carries over/, 'unspent energy carries over'],
      [/nowhere to go is never created/, 'the battlefield is unbounded'],
      [/battlefield is full/, 'the battlefield is unbounded'],
      [/guardian and resilient/, 'Guardian is implemented; only Resilient is inert'],
    ];

    for (const section of rulebook.sections) {
      for (const [pattern, why] of retired) {
        expect(section.searchText, `${section.id}: ${why}`).not.toMatch(pattern);
      }
    }
    for (const [pattern, why] of retired) {
      expect(rulebook.intro.toLowerCase(), `intro: ${why}`).not.toMatch(pattern);
    }
  });
});

describe('rulebook search', () => {
  it('finds a section by its title', () => {
    const results = searchRulebook(rulebook, 'energy');
    expect(results[0]?.sectionId).toBe('energy');
  });

  it('finds a keyword defined only inside the keyword index', () => {
    const results = searchRulebook(rulebook, 'venom');
    expect(results.map((result) => result.sectionId)).toContain('keywords');
  });

  it('finds a glossary term', () => {
    const results = searchRulebook(rulebook, 'newly deployed');
    expect(results.length).toBeGreaterThan(0);
  });

  it('returns a snippet with the match in it', () => {
    const [first] = searchRulebook(rulebook, 'mulligan');
    expect(first?.snippet.length ?? 0).toBeGreaterThan(0);
  });

  it('ignores queries that are too short to be useful', () => {
    expect(searchRulebook(rulebook, 'a')).toEqual([]);
    expect(searchRulebook(rulebook, '  ')).toEqual([]);
  });

  it('returns nothing rather than guessing when there is no match', () => {
    expect(searchRulebook(rulebook, 'planeswalker')).toEqual([]);
  });
});
