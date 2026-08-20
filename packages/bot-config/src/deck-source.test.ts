import { describe, expect, it } from 'vitest';
import {
  BOT_DECK_MODES,
  DECK_MODE_SUPPORT,
  botDeckSnapshotSchema,
  botDeckSourcePublicSchema,
  botDeckSourceSchema,
  configuredCommanderIdOf,
  deckModeGenerates,
  deckModeIsSupported,
  generatedDeckProvenanceSchema,
  publicDeckSourceOf,
  type BotDeckMode,
  type BotDeckSource,
  type GeneratedDeckProvenance,
} from './deck-source.js';

/**
 * Where a bot's cards come from, and what an opponent may learn about them
 * (M09.1).
 *
 * The privacy rule under test is the milestone's, exactly: **public at the
 * Commander, private at the list**. The assertions below check it the strict
 * way — by serialising the whole public projection and looking for the private
 * values in the text — rather than by naming the fields the projection happens
 * to have today, because the failure this guards against is a field being
 * *added* later.
 */

const SNAPSHOT = {
  sourceDeckId: 'saved_1',
  name: "The host's control pile",
  commanderId: 'commander_containment',
  cardIds: ['card_one', 'card_two'],
  deckHash: 'abcdef0123456789',
};

const PROVENANCE: GeneratedDeckProvenance = {
  generatorVersion: '1.0.0',
  mode: 'autonomous_generated',
  formatId: 'precon_wave_1',
  seed: 'lobby_abc|bot:2|deck',
  rerollCount: 2,
  commanderId: 'commander_swarm',
  deckHash: 'fedcba9876543210',
  legalPoolSize: 41,
  forcedInclusionFloor: 39,
};

const SOURCES: Record<BotDeckMode, BotDeckSource> = {
  exact_precon: { mode: 'exact_precon', preconId: 'goblin_swarm' },
  exact_saved_deck: { mode: 'exact_saved_deck', deck: SNAPSHOT },
  commander_generated: {
    mode: 'commander_generated',
    commanderId: 'commander_bastion',
    seed: 'lobby_abc|bot:1|deck',
    generated: null,
  },
  autonomous_generated: {
    mode: 'autonomous_generated',
    seed: 'lobby_abc|bot:2|deck',
    generated: PROVENANCE,
  },
};

/** Every value the private configuration holds that an opponent must not see. */
const PRIVATE_VALUES = [
  SNAPSHOT.sourceDeckId,
  SNAPSHOT.name,
  SNAPSHOT.deckHash,
  ...SNAPSHOT.cardIds,
  PROVENANCE.seed,
  PROVENANCE.deckHash,
  'lobby_abc|bot:1|deck',
];

describe('the deck source union', () => {
  it('has exactly four members, and no fifth', () => {
    expect(BOT_DECK_MODES).toEqual([
      'exact_precon',
      'exact_saved_deck',
      'commander_generated',
      'autonomous_generated',
    ]);
    // AI Lab finalists as a deck source would be a fifth, and need M08 to exist.
    expect(
      botDeckSourceSchema.safeParse({ mode: 'ai_lab_finalist', finalistId: 'x' }).success,
    ).toBe(false);
  });

  it('parses every member', () => {
    for (const mode of BOT_DECK_MODES) {
      expect(botDeckSourceSchema.safeParse(SOURCES[mode]).success).toBe(true);
    }
  });

  it('discriminates on the mode rather than on the fields present', () => {
    // A precon ID does not smuggle a saved deck through, and a saved deck's
    // snapshot does not stand in for a precon.
    expect(botDeckSourceSchema.safeParse({ mode: 'exact_precon', deck: SNAPSHOT }).success).toBe(
      false,
    );
    expect(
      botDeckSourceSchema.safeParse({ mode: 'exact_saved_deck', preconId: 'goblin_swarm' }).success,
    ).toBe(false);
  });

  it('refuses an unknown member on every variant', () => {
    for (const mode of BOT_DECK_MODES) {
      const widened = { ...SOURCES[mode], counterpickAgainst: 'seat_1' };
      expect(botDeckSourceSchema.safeParse(widened).success).toBe(false);
    }
  });

  it('requires a generated mode to say whether it has generated yet', () => {
    expect(
      botDeckSourceSchema.safeParse({
        mode: 'commander_generated',
        commanderId: 'commander_bastion',
        seed: 'seed',
      }).success,
    ).toBe(false);
  });

  it('knows which modes build a deck and which are handed one', () => {
    expect(BOT_DECK_MODES.filter(deckModeGenerates)).toEqual([
      'commander_generated',
      'autonomous_generated',
    ]);
  });

  it('round-trips every member through JSON', () => {
    for (const mode of BOT_DECK_MODES) {
      const parsed = botDeckSourceSchema.parse(JSON.parse(JSON.stringify(SOURCES[mode])));
      expect(parsed).toEqual(SOURCES[mode]);
    }
  });
});

describe('the snapshot and its provenance', () => {
  it('freezes a saved deck rather than pointing at one', () => {
    const parsed = botDeckSnapshotSchema.parse(SNAPSHOT);
    expect(parsed.cardIds).toEqual(SNAPSHOT.cardIds);
    // A later edit in the deck builder cannot reach a live match, because what
    // was configured is the list itself and not a reference to it.
    expect(parsed).not.toHaveProperty('cards');
  });

  it('refuses an empty list and an unknown member', () => {
    expect(botDeckSnapshotSchema.safeParse({ ...SNAPSHOT, cardIds: [] }).success).toBe(false);
    expect(botDeckSnapshotSchema.safeParse({ ...SNAPSHOT, updatedAt: 'now' }).success).toBe(false);
  });

  it('records the pool a generated deck was built from', () => {
    // Wave 1 Commander-legal pools are 41-42 cards for a 40-card singleton deck,
    // so generated decks are minimally different from one another. The UI reads
    // that from here rather than from a comment.
    const parsed = generatedDeckProvenanceSchema.parse(PROVENANCE);
    expect(parsed.legalPoolSize).toBe(41);
    expect(parsed.forcedInclusionFloor).toBe(39);
    expect(parsed.rerollCount).toBe(2);
  });

  it('never claims an exact mode generated a deck', () => {
    expect(
      generatedDeckProvenanceSchema.safeParse({ ...PROVENANCE, mode: 'exact_precon' }).success,
    ).toBe(false);
  });
});

describe('the public projection', () => {
  it('publishes the Commander for every mode that has decided one', () => {
    expect(publicDeckSourceOf(SOURCES.exact_saved_deck)).toEqual({
      mode: 'exact_saved_deck',
      commanderId: SNAPSHOT.commanderId,
    });
    expect(publicDeckSourceOf(SOURCES.commander_generated)).toEqual({
      mode: 'commander_generated',
      commanderId: 'commander_bastion',
    });
    expect(publicDeckSourceOf(SOURCES.autonomous_generated)).toEqual({
      mode: 'autonomous_generated',
      commanderId: PROVENANCE.commanderId,
    });
  });

  it('says null rather than guessing before an autonomous bot has chosen', () => {
    const undecided: BotDeckSource = {
      mode: 'autonomous_generated',
      seed: 'lobby_abc|bot:2|deck',
      generated: null,
    };
    expect(publicDeckSourceOf(undecided)).toEqual({
      mode: 'autonomous_generated',
      commanderId: null,
    });
    expect(configuredCommanderIdOf(undecided)).toBeNull();
  });

  it('keeps a precon addressable, because a precon list is shipped public content', () => {
    expect(publicDeckSourceOf(SOURCES.exact_precon)).toEqual({
      mode: 'exact_precon',
      preconId: 'goblin_swarm',
    });
    // Its Commander is not duplicated into the configuration, so there is no
    // second place for it to be wrong: the precon owns that fact.
    expect(configuredCommanderIdOf(SOURCES.exact_precon)).toBeNull();
  });

  it('leaks no card list, no seed, no hash and no saved-deck identity', () => {
    for (const mode of BOT_DECK_MODES) {
      const published = JSON.stringify(publicDeckSourceOf(SOURCES[mode]));
      for (const secret of PRIVATE_VALUES) {
        expect(published).not.toContain(secret);
      }
    }
  });

  it('is strict, so nothing can be appended to it in transit', () => {
    for (const mode of BOT_DECK_MODES) {
      const published = publicDeckSourceOf(SOURCES[mode]);
      expect(botDeckSourcePublicSchema.safeParse(published).success).toBe(true);
      expect(
        botDeckSourcePublicSchema.safeParse({ ...published, cardIds: SNAPSHOT.cardIds }).success,
      ).toBe(false);
    }
  });

  it('cannot be satisfied by a private configuration handed over whole', () => {
    for (const mode of BOT_DECK_MODES) {
      expect(botDeckSourcePublicSchema.safeParse(SOURCES[mode]).success).toBe(
        // The precon variant is the one case where private and public agree,
        // because its only member is the public identifier.
        mode === 'exact_precon',
      );
    }
  });
});

describe('mode support', () => {
  it('supports every mode, each having gained a resolver in its own tranche', () => {
    // `exact_saved_deck` joined the supported list in M09.6, `commander_generated`
    // in M09.9 and `autonomous_generated` in M09.10, each when the server grew a
    // resolver for it. With the fourth on, no mode names a tranche any more —
    // which is the state the table was built to reach, not a reason to delete it.
    expect(BOT_DECK_MODES.filter(deckModeIsSupported)).toEqual([...BOT_DECK_MODES]);
    for (const mode of BOT_DECK_MODES) expect(DECK_MODE_SUPPORT[mode].plannedIn).toBeNull();
  });

  it('gives every mode an entry, so none can be refused without a reason', () => {
    for (const mode of BOT_DECK_MODES) {
      const support = DECK_MODE_SUPPORT[mode];
      expect(support.supported === (support.plannedIn === null)).toBe(true);
    }
  });
});
