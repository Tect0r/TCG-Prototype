import { describe, expect, it } from 'vitest';
import { loadFormatCardData, type CardDefinitionInput } from '@tcg/card-data';
import { analyzeMechanicSupport, supportLimitsOf } from './analysis/support.js';
import { applySupportLimits, computeFlags, supportFlags, type Flag } from './analysis/flags.js';
import { makeDeck } from '@tcg/deck-generator';
import { aggregate } from './analysis/aggregate.js';
import { clusterDecks } from './analysis/clusters.js';
import { DEFAULT_ANALYSIS_SETTINGS } from './config.js';
import { tinyEnvironment, fixtureDeck } from './test-fixtures.js';

/**
 * The run's own statement of what its evidence is worth (M05.1).
 *
 * Two things are under test: that the statement is *derived* from the mechanic
 * support registry and the decks that actually played, and that a review signal
 * the statement cannot carry is declined rather than printed.
 */

const env = tinyEnvironment();

/**
 * A body whose only text is the one keyword the engine deliberately does not
 * execute (Q4).
 *
 * Layered on by this file rather than added to `FIXTURE_CARDS`, following the
 * rule in `test-fixtures.ts`: that list is the default pool of every tiny
 * environment, and adding to it changes what every seeded population in the
 * suite can roll. Synthetic because it has to be — since M05.1 the content build
 * refuses an `engine: 'none'` mechanic in a `playtest` set, so no shipped card
 * can carry one.
 */
const INERT_KEYWORD_CARD: CardDefinitionInput = {
  schemaVersion: 2,
  id: 'fixture_inert_keyword_unit',
  name: 'Fixture Inert Keyword Unit',
  type: 'unit',
  colorIdentity: [],
  cost: 2,
  attack: 2,
  health: 2,
  keywords: ['resilient'],
  role: 'attacker',
  powerClass: 'standard',
  tags: ['fixture'],
  displayText: 'Resilient.',
};

const inertEnv = tinyEnvironment({
  id: 'inert',
  copyLimit: 6,
  cardOverrides: [INERT_KEYWORD_CARD],
});

const NEUTRAL_DECK = fixtureDeck('neutral', 'prototype_commander_blue', [
  ['prototype_drone', 2],
  ['prototype_scout', 2],
  ['prototype_guard', 2],
  ['trench_guard', 2],
  ['unstable_construct', 2],
  ['surveyors_lens', 2],
]);

function flag(overrides: Partial<Flag> = {}): Flag {
  return {
    level: 'review_recommended',
    reason: 'high_inclusion_win_rate_lift',
    subject: 'prototype_drone',
    message: 'Decks running it win more.',
    evidence: { lift: 0.2 },
    sampleSize: 200,
    interval: { low: 0.1, high: 0.3 },
    threshold: { name: 'inclusionLift', value: 0.1 },
    ...overrides,
  };
}

describe('mechanic support analysis', () => {
  it('reads support off the registry rather than off the cards’ own claims', () => {
    const analysis = analyzeMechanicSupport({
      decks: [NEUTRAL_DECK],
      database: env.database,
      pilotIds: ['value'],
    });

    expect(analysis.decks).toHaveLength(1);
    const deck = analysis.decks[0];
    // Everything in the fixture pool is executed and documented; nothing in it
    // is a Reaction, so no card is unvalued by the pilots.
    expect(deck?.weakest.engine).toBe('full');
    expect(deck?.weakest.help).toBe('full');
    expect(deck?.weakest.pilot).toBe('approximate');
    expect(deck?.inertCards).toEqual([]);
    expect(analysis.legalOnlyPilots).toBe(false);
    expect(analysis.registryVersion).toBeGreaterThan(0);
  });

  it('names the mechanics that hold each dimension back', () => {
    const analysis = analyzeMechanicSupport({
      decks: [NEUTRAL_DECK],
      database: env.database,
      pilotIds: ['value'],
    });
    const deck = analysis.decks[0];
    expect(deck?.limiting.engine.length).toBeGreaterThan(0);
    // A dimension that is not fully supported has to say what is limiting it,
    // otherwise the level is an unactionable adjective.
    expect(deck?.limiting.telemetry.length).toBeGreaterThan(0);
    for (const key of deck?.limiting.telemetry ?? []) {
      expect(key).toMatch(/^[a-z_]+:[a-z_]+$/);
    }
    // Every named mechanic carries the note explaining where it stands.
    const noted = new Set(analysis.notes.map((note) => note.key));
    for (const key of deck?.limiting.pilot ?? []) expect(noted.has(key)).toBe(true);
  });

  it('follows a deck into the tokens its cards create', () => {
    // `unstable_construct` is in the fixture pool and creates a token; the
    // token's own mechanics are part of what the deck does.
    const analysis = analyzeMechanicSupport({
      decks: [NEUTRAL_DECK],
      database: env.database,
      pilotIds: ['value'],
    });
    expect(analysis.decks[0]?.limiting.engine.length).toBeGreaterThan(0);
  });

  it('marks a run flown entirely by legality-only pilots', () => {
    const mixed = analyzeMechanicSupport({
      decks: [NEUTRAL_DECK],
      database: env.database,
      pilotIds: ['random_legal', 'value'],
    });
    // A mixed run still produced heuristic play at some seats; refusing to
    // report any of it would throw away the arm that was flown properly.
    expect(mixed.legalOnlyPilots).toBe(false);

    const random = analyzeMechanicSupport({
      decks: [NEUTRAL_DECK],
      database: env.database,
      pilotIds: ['random_legal'],
    });
    expect(random.legalOnlyPilots).toBe(true);
  });

  it('no longer reports a deck of Reactions as pilot-blind (M05.2)', () => {
    // This assertion is the inverse of the one it replaces. Until M05.2 no pilot
    // valued a counter, so a deck built entirely out of the shipped Reactions
    // reported `legal_only` and every balance flag about it was downgraded. The
    // pilots price a counter now, and a report that still declined those claims
    // would be understating evidence the run actually has.
    const loaded = loadFormatCardData('precon_wave_1');
    if (!loaded.ok) throw new Error('precon_wave_1 failed to load');
    const { database } = loaded.value;
    const counterCards = database
      .all()
      .filter((card) => card.effects.some((effect) => effect.type === 'counter'));
    expect(counterCards.length).toBeGreaterThan(0);

    const commander = database.all().find((card) => card.type === 'commander');
    expect(commander).toBeDefined();
    const deck = makeDeck({
      id: 'reaction_deck',
      commanderId: commander?.id ?? 'missing',
      cards: counterCards.map((card) => ({ cardId: card.id, quantity: 1 })),
    });
    const analysis = analyzeMechanicSupport({
      decks: [deck],
      database,
      pilotIds: ['value'],
    });
    expect(analysis.decks[0]?.weakest.pilot).toBe('approximate');
    expect(analysis.pilotBlindCards).toEqual([]);
  });

  it('still reports a card built on an inert mechanic as pilot-blind', () => {
    // The path above stopped firing on the shipped catalog, so it is proved here
    // instead — otherwise M05.2 would have quietly deleted the only coverage of
    // the downgrade this analysis exists to drive. `resilient` is the remaining
    // `pilot: legal_only` mechanic (Q4), and the content build bars it from a
    // `playtest` set, so the card carrying it has to be synthetic.
    const inert = fixtureDeck('inert', 'prototype_commander_blue', [
      [INERT_KEYWORD_CARD.id, 6],
      ['prototype_scout', 6],
    ]);
    const analysis = analyzeMechanicSupport({
      decks: [inert],
      database: inertEnv.database,
      pilotIds: ['value'],
    });
    expect(analysis.decks[0]?.weakest.pilot).toBe('legal_only');
    expect(analysis.pilotBlindCards).toEqual([INERT_KEYWORD_CARD.id]);
  });
});

describe('declining a claim the run cannot support', () => {
  it('downgrades every balance flag when the pilots only play legally', () => {
    const [downgraded] = applySupportLimits([flag()], {
      legalOnlyPilots: true,
      pilotBlindCards: [],
      telemetryBlindCards: [],
    });
    expect(downgraded?.level).toBe('insufficient_data');
    expect(downgraded?.message).toMatch(/plays? only legally/);
    // The evidence survives: a downgraded flag is still checkable.
    expect(downgraded?.sampleSize).toBe(200);
    expect(downgraded?.interval).toEqual({ low: 0.1, high: 0.3 });
    expect(downgraded?.evidence.supportDowngraded).toBe(true);
  });

  it('leaves run-quality flags alone, because they are not balance claims', () => {
    const quality = flag({ level: 'run_quality', reason: 'abnormal_terminations', subject: 'run' });
    const [kept] = applySupportLimits([quality], {
      legalOnlyPilots: true,
      pilotBlindCards: [],
      telemetryBlindCards: [],
    });
    expect(kept).toEqual(quality);
  });

  it('downgrades a card flag about a card no pilot values, and only that card', () => {
    const flags = [flag({ subject: 'blind_card' }), flag({ subject: 'ordinary_card' })];
    const limited = applySupportLimits(flags, {
      legalOnlyPilots: false,
      pilotBlindCards: ['blind_card'],
      telemetryBlindCards: [],
    });
    expect(limited[0]?.level).toBe('insufficient_data');
    expect(limited[0]?.message).toMatch(/played blind/);
    expect(limited[1]?.level).toBe('review_recommended');
  });

  it('downgrades a card flag about a card nothing observes', () => {
    const [limited] = applySupportLimits([flag({ subject: 'invisible_card' })], {
      legalOnlyPilots: false,
      pilotBlindCards: [],
      telemetryBlindCards: ['invisible_card'],
    });
    expect(limited?.level).toBe('insufficient_data');
    expect(limited?.message).toMatch(/telemetry counter/);
  });

  it('leaves a deck- or cluster-subject flag alone, because it is not about one card', () => {
    const deckFlag = flag({ reason: 'matchup_polarization', subject: 'cluster_a' });
    const [kept] = applySupportLimits([deckFlag], {
      legalOnlyPilots: false,
      pilotBlindCards: ['blind_card'],
      telemetryBlindCards: ['invisible_card'],
    });
    expect(kept).toEqual(deckFlag);
  });

  it('says nothing at all when every mechanic in the run is supported', () => {
    expect(
      supportFlags({ legalOnlyPilots: false, pilotBlindCards: [], telemetryBlindCards: [] }, 4),
    ).toEqual([]);
  });

  it('raises one run-quality note naming what is missing', () => {
    const [note] = supportFlags(
      { legalOnlyPilots: false, pilotBlindCards: ['a', 'b'], telemetryBlindCards: ['c'] },
      4,
    );
    expect(note?.level).toBe('run_quality');
    expect(note?.reason).toBe('unsupported_mechanics');
    expect(note?.evidence.pilotBlindCards).toBe('a,b');
    expect(note?.evidence.telemetryBlindCards).toBe('c');
  });
});

describe('computeFlags', () => {
  it('applies the downgrade after every flag has been computed', () => {
    const limits = supportLimitsOf(
      analyzeMechanicSupport({
        decks: [NEUTRAL_DECK],
        database: env.database,
        pilotIds: ['random_legal'],
      }),
    );
    const flags = computeFlags({
      aggregate: aggregate([], { confidence: DEFAULT_ANALYSIS_SETTINGS.confidence }),
      clustering: clusterDecks([NEUTRAL_DECK], env.database, [], {
        confidence: DEFAULT_ANALYSIS_SETTINGS.confidence,
      }),
      pairs: [],
      replacements: [],
      settings: DEFAULT_ANALYSIS_SETTINGS,
      support: limits,
      deckCount: 1,
    });
    // The note is emitted because the pilots were legality-only, and nothing
    // survives as a balance claim.
    expect(flags.map((entry) => entry.reason)).toContain('unsupported_mechanics');
    expect(flags.every((entry) => entry.level !== 'review_recommended')).toBe(true);
  });
});
