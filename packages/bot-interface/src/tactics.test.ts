import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EASY_SELECTION } from '@tcg/bot-config';
import type { CardInstanceView } from '@tcg/rules-engine';
import {
  CALIBRATED_PILOT_IDS,
  CALIBRATION_FIXTURES,
  CalibrationTable,
  calibrationDatabase,
  compareCalibrationSuite,
  preconMatchDeck,
  runFixture,
} from './calibration/index.js';
import { AGGRESSIVE_WEIGHTS } from './aggressive.js';
import { candidateActions } from './candidates.js';
import { scoreCandidate } from './heuristic.js';
import {
  createPilot,
  createStyledPilot,
  createTacticalPilot,
  STYLED_PILOT_IDS,
} from './registry.js';
import {
  arrivalBoostValue,
  BASELINE_COMBAT_MODEL,
  cardValue,
  damageRemovalFraction,
  DEFAULT_WEIGHTS,
  enablerLeadBonus,
  greedyBlocks,
  reactionEnergyReserve,
  resolveHypotheticalCombat,
  strandedReactionValue,
  windowIsReachable,
  wouldDefeat,
  type CombatModel,
  type PlayableEntry,
} from './scoring.js';
import {
  assertTacticalProfilesComplete,
  tacticalProfile,
  tacticalProfileGaps,
  BASELINE_TACTICS,
  HARD_TACTICAL_TACTICS,
  TACTICAL_PROFILES,
  TACTICAL_PROFILE_IDS,
  TACTICAL_REFINEMENTS,
  TACTICS_REGISTRY_VERSION,
} from './tactics.js';
import { BLUE_DECK, driveMatch, GREEN_DECK, RED_DECK } from './test-driver.js';
import type { BotObservation } from './types.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Hard's tactical half (M09.14).
 *
 * Four separate things are asserted here, and it matters that they are separate:
 *
 * 1. the registry is **complete and honest** — `baseline` really is nothing, and
 *    a second profile really is something;
 * 2. Normal and Easy are **unchanged**, measured rather than argued, both one
 *    decision at a time and over whole matches;
 * 3. the refinements are **arithmetic about the engine** — Barrier, Overwhelm,
 *    lethality and the preserving block are each checked against the rule they
 *    model rather than only through a fixture that happens to exercise them;
 * 4. a profile changes **nothing about the boundary** — no hidden state, no
 *    illegal action, no difficulty selection, and the same answer twice.
 */

describe('the tactical profile registry', () => {
  it('is complete in both directions', () => {
    expect(tacticalProfileGaps()).toEqual([]);
    expect(() => assertTacticalProfilesComplete()).not.toThrow();
    expect(TACTICS_REGISTRY_VERSION).toBeGreaterThan(0);
  });

  it('is a Record over the vocabulary, filed under its own IDs', () => {
    expect(Object.keys(TACTICAL_PROFILES).sort()).toEqual([...TACTICAL_PROFILE_IDS].sort());
    for (const id of TACTICAL_PROFILE_IDS) {
      expect(tacticalProfile(id).id).toBe(id);
      expect(tacticalProfile(id).version).not.toBe('');
      expect(tacticalProfile(id).summary).not.toBe('');
    }
  });

  it('makes "baseline is nothing" a property rather than a promise', () => {
    for (const refinement of TACTICAL_REFINEMENTS) {
      expect(BASELINE_TACTICS[refinement]).toBe(false);
    }
    // And the other direction: a profile that turned nothing on would be the
    // baseline with a version number, which the gap check refuses.
    expect(TACTICAL_REFINEMENTS.some((refinement) => HARD_TACTICAL_TACTICS[refinement])).toBe(true);
  });

  it('does not publish Hard: the difficulty registry still refuses it', async () => {
    // M09.14 builds the tactical half and M09.15 owns the strategic half, so
    // nothing in `@tcg/bot-config` moved and no lobby can select this yet. The
    // check is here rather than only over there because this is the file whose
    // existence would otherwise look like publication.
    const { DIFFICULTY_REGISTRY, AVAILABLE_DIFFICULTIES } = await import('@tcg/bot-config');
    expect(DIFFICULTY_REGISTRY.hard.status).toBe('planned');
    expect(DIFFICULTY_REGISTRY.hard.selection).toBeNull();
    expect(DIFFICULTY_REGISTRY.hard.behaviorVersion).toBeNull();
    expect(AVAILABLE_DIFFICULTIES).not.toContain('hard');
  });
});

describe('Normal and Easy are unchanged', () => {
  it('builds the identical pilot through the baseline profile and through no profile at all', () => {
    for (const pilotId of STYLED_PILOT_IDS) {
      const published = createPilot({ id: pilotId });
      const explicit = createTacticalPilot({ pilotId, tactics: BASELINE_TACTICS });
      expect(explicit.id).toBe(published.id);
      expect(explicit.version).toBe(published.version);
      expect(explicit.config).toEqual({ ...published.config, tactics: { ...BASELINE_TACTICS } });
    }
  });

  it('decides every calibration fixture identically at the baseline', () => {
    // The one-decision-at-a-time version of "nothing moved": twenty-four
    // hand-authored boards, three weight vectors, every recorded decision key
    // compared. A refinement that leaked into the default would show up here as
    // a different key long before it showed up as a different match result.
    for (const fixture of CALIBRATION_FIXTURES) {
      for (const pilotId of CALIBRATED_PILOT_IDS) {
        const viaDefault = runFixture(fixture, pilotId);
        const viaProfile = runFixture(fixture, pilotId, 'baseline');
        expect(viaProfile.characteristic).toBe(viaDefault.characteristic);
        expect(viaProfile.decisions.map((decision) => decision.key)).toEqual(
          viaDefault.decisions.map((decision) => decision.key),
        );
      }
    }
  });

  it.each(STYLED_PILOT_IDS)(
    '"%s" plays a whole match identically at Normal and at Easy',
    async (pilotId) => {
      // The whole-match version, in the shape M09.13 used for the same claim:
      // same seed, same seats, same decks, compared action by action. Easy is in
      // here too because the tactical profile is the *other* axis, and a
      // refinement that reached the selection would move both.
      const play = async (
        build: () => ReturnType<typeof createPilot>,
        seed: string,
      ): Promise<string[]> => {
        const outcome = await driveMatch({ seed, pilots: [build(), build()] });
        expect(outcome.state.status).toBe('complete');
        return outcome.actions.map((action) => JSON.stringify(action));
      };

      const normalDefault = await play(() => createPilot({ id: pilotId }), `tactics-${pilotId}`);
      const normalProfile = await play(
        () => createTacticalPilot({ pilotId, tactics: BASELINE_TACTICS }),
        `tactics-${pilotId}`,
      );
      expect(normalProfile).toEqual(normalDefault);

      const easyDefault = await play(
        () => createStyledPilot({ pilotId, selection: EASY_SELECTION }),
        `tactics-easy-${pilotId}`,
      );
      const easyProfile = await play(
        () => createStyledPilot({ pilotId, selection: EASY_SELECTION, tactics: BASELINE_TACTICS }),
        `tactics-easy-${pilotId}`,
      );
      expect(easyProfile).toEqual(easyDefault);
    },
  );

  it('leaves the published calibration report exactly where it was', () => {
    // `compareCalibrationSuite` defaults to the baseline, so the simulator's
    // calibration standing — which cites this report — reads the same instrument
    // it read before M09.14 without being changed at all.
    const report = compareCalibrationSuite();
    expect(report.tactics).toBe('baseline');
    expect(report.stale).toEqual([]);
  });
});

/* ------------------------------------------------------ the refinements */

const unit = (overrides: Partial<CardInstanceView>): CardInstanceView =>
  ({
    instanceId: 'inst_x',
    definitionId: 'def_x',
    controller: 'player_1',
    zone: 'battlefield',
    attack: 1,
    health: 1,
    markedDamage: 0,
    exhausted: false,
    keywords: [],
    barrierSpent: false,
    ...overrides,
  }) as CardInstanceView;

const HARD_MODEL: CombatModel = { barrier: true, overwhelm: true };

describe('the combat model', () => {
  it('leaves an unspent Barrier alive, and a spent one exactly where it was', () => {
    const attacker = unit({ instanceId: 'a', attack: 4 });
    const warded = unit({ instanceId: 'b', health: 3, keywords: ['barrier'] });
    const spent = unit({ instanceId: 'c', health: 3, keywords: ['barrier'], barrierSpent: true });

    expect(wouldDefeat(attacker, warded, HARD_MODEL)).toBe(false);
    expect(wouldDefeat(attacker, spent, HARD_MODEL)).toBe(true);
    // Baseline is the comparison that shipped, both times.
    expect(wouldDefeat(attacker, warded)).toBe(true);
    expect(wouldDefeat(attacker, warded, BASELINE_COMBAT_MODEL)).toBe(true);
  });

  it('prevents the whole event, so even a venom hit does not get through Barrier', () => {
    // `damage.ts` prevents the damage before the lethal flag is read, so this is
    // the engine's order rather than a convenient simplification.
    const venomous = unit({ instanceId: 'a', attack: 1, keywords: ['venom'] });
    const warded = unit({ instanceId: 'b', health: 9, keywords: ['barrier'] });
    expect(wouldDefeat(venomous, warded, HARD_MODEL)).toBe(false);
    expect(wouldDefeat(venomous, warded)).toBe(true);
  });

  it('sends an Overwhelm attacker’s excess to the player, split on current Health', () => {
    const trampler = unit({ instanceId: 'a', attack: 7, health: 7, keywords: ['overwhelm'] });
    const chump = unit({ instanceId: 'b', attack: 2, health: 1 });
    const blocks = [{ attackerInstanceId: 'a', blockerInstanceId: 'b' }];
    const lookup = new Map([['b', chump]]);

    expect(resolveHypotheticalCombat([trampler], blocks, lookup, HARD_MODEL).faceDamage).toBe(6);
    // Without the model a blocked attacker is fully stopped, which is the
    // reading Normal and Easy still make.
    expect(resolveHypotheticalCombat([trampler], blocks, lookup).faceDamage).toBe(0);
  });

  it('splits Overwhelm on printed Health rather than on the lethal requirement', () => {
    // The engine's decided rule (ADR 0016 Q-D): damage already marked on the
    // blocker does *not* widen the overflow.
    const trampler = unit({ instanceId: 'a', attack: 7, keywords: ['overwhelm'] });
    const hurt = unit({ instanceId: 'b', health: 4, markedDamage: 3 });
    const outcome = resolveHypotheticalCombat(
      [trampler],
      [{ attackerInstanceId: 'a', blockerInstanceId: 'b' }],
      new Map([['b', hurt]]),
      HARD_MODEL,
    );
    expect(outcome.faceDamage).toBe(3);
  });
});

describe('the preserving block', () => {
  const attacker = unit({ instanceId: 'atk', attack: 3, health: 2 });
  const trades = unit({ instanceId: 'trade', attack: 2, health: 1 });
  const eats = unit({ instanceId: 'eats', attack: 2, health: 5 });
  const walls = unit({ instanceId: 'wall', attack: 0, health: 6 });

  it('prefers the blocker that kills and survives, then the one that survives', () => {
    expect(
      greedyBlocks([attacker], [trades, eats], {
        chumpBlock: false,
        valueOnly: true,
        preserve: true,
      }).map((pair) => pair.blockerInstanceId),
    ).toEqual(['eats']);
    expect(
      greedyBlocks([attacker], [trades, walls], {
        chumpBlock: false,
        valueOnly: true,
        preserve: true,
      }).map((pair) => pair.blockerInstanceId),
    ).toEqual(['wall']);
  });

  it('is a widening: the unpreserved pairing is exactly what it always was', () => {
    // Smallest body that does *any* job, which for a small attacker is the one
    // that kills and dies — the M05.6 finding this refinement is about.
    expect(
      greedyBlocks([attacker], [trades, eats], { chumpBlock: false, valueOnly: true }).map(
        (pair) => pair.blockerInstanceId,
      ),
    ).toEqual(['trade']);
  });

  it('still declines when nothing does the job, rather than chumping', () => {
    const huge = unit({ instanceId: 'huge', attack: 9, health: 9 });
    expect(
      greedyBlocks([huge], [trades], { chumpBlock: false, valueOnly: true, preserve: true }),
    ).toEqual([]);
  });
});

describe('removal lethality', () => {
  it('is the whole body when the damage defeats it and a fraction when it does not', () => {
    const small = unit({ health: 1 });
    const big = unit({ health: 5 });
    expect(damageRemovalFraction(small, 2)).toBe(1);
    expect(damageRemovalFraction(big, 2)).toBeCloseTo(0.4);
    expect(damageRemovalFraction(big, 5)).toBe(1);
  });

  it('is nothing at all against an unspent Barrier, and only under the model', () => {
    const warded = unit({ health: 5, keywords: ['barrier'] });
    expect(damageRemovalFraction(warded, 3, HARD_MODEL)).toBe(0);
    expect(damageRemovalFraction(warded, 3)).toBeCloseTo(0.6);
  });

  it('is nothing for a damage instruction that deals none', () => {
    expect(damageRemovalFraction(unit({ health: 3 }), 0, HARD_MODEL)).toBe(0);
  });
});

/* ------------------------------------------- the short-horizon refinements */

describe('enabler sequencing', () => {
  const database = calibrationDatabase();
  const weights = DEFAULT_WEIGHTS;
  const armory = database.getOrThrow('bastion_armory');
  const guardian = database.getOrThrow('bastion_infantry');
  const plain = database.getOrThrow('border_recruit');

  const entry = (definitionId: string, energyCost: number, baseScore: number): PlayableEntry => ({
    instanceId: definitionId,
    definitionId,
    energyCost,
    baseScore,
  });

  it('reads what a Relic adds to the Unit its trigger covers, and nothing else', () => {
    // One Barrier, priced by the same keyword weight everything else uses. The
    // Relic's own board presence is not in here: that is `cardValue`'s job, and
    // counting it twice would make every card with a trigger an enabler.
    expect(arrivalBoostValue(armory, guardian, weights, database)).toBeCloseTo(
      weights.keywordBonus,
    );
    // The trigger's scope is `keywords: ['guardian']`, so a Unit without it is
    // not improved — a filter, not a card list.
    expect(arrivalBoostValue(armory, plain, weights, database)).toBe(0);
    // And nothing runs backwards.
    expect(arrivalBoostValue(guardian, armory, weights, database)).toBe(0);
  });

  it('leads with the enabler only while the beneficiary is still affordable', () => {
    const lead = entry('bastion_armory', 3, 2);
    const follow = entry('bastion_infantry', 2, 5);
    const horizon = [lead, follow];

    // Five Energy pays for both, so the order is the only thing at stake and the
    // enabler is raised to the follower's score plus the Barrier it hands it.
    expect(enablerLeadBonus(lead, horizon, 5, weights, database)).toBeCloseTo(
      3 + weights.keywordBonus,
    );
    // Four pays for the Relic and leaves nothing for the Guardian: an enabler
    // with nothing left to enable is a wasted turn, not a sequence.
    expect(enablerLeadBonus(lead, horizon, 4, weights, database)).toBe(0);
    // The follower is never lifted, whatever the Energy.
    expect(enablerLeadBonus(follow, horizon, 5, weights, database)).toBe(0);
  });

  it('is bounded above by the follower it is sequencing in front of', () => {
    // The ceiling is the whole reason this cannot run away: however far behind
    // the enabler starts, it never climbs past what the beneficiary was already
    // worth plus what leading adds to it.
    const lead = entry('bastion_armory', 3, -20);
    const follow = entry('bastion_infantry', 2, 5);
    const lifted = -20 + enablerLeadBonus(lead, [lead, follow], 5, weights, database);
    expect(lifted).toBeCloseTo(5 + weights.keywordBonus);
  });
});

describe('Reaction energy reservation', () => {
  const database = calibrationDatabase();
  const weights = DEFAULT_WEIGHTS;
  const counter = database.getOrThrow('calculated_response');
  const held = [{ definition: counter, energyCost: 3 }];

  /** A two-seat view where the opponent could still play a Spell. */
  function tableView(energy: number) {
    const table = CalibrationTable.open({ preconId: 'precon_containment_control', energy });
    return table.observationFor(table.self).view;
  }

  it('reserves what the Reaction costs, and only when it is already affordable', () => {
    expect(reactionEnergyReserve(held, tableView(3), 3)).toBe(3);
    // Two Energy cannot buy the counter at all, so holding it back would only be
    // a reason to pass with nothing to show for it.
    expect(reactionEnergyReserve(held, tableView(2), 2)).toBe(0);
    // Nothing held, nothing reserved — the deck is full of Reactions either way.
    expect(reactionEnergyReserve([], tableView(9), 9)).toBe(0);
  });

  it('reserves nothing once the window it names can no longer open', () => {
    const view = tableView(3);
    const empty = {
      ...view,
      players: view.players.map((seat) =>
        seat.playerId === 'player_1' ? seat : { ...seat, handCount: 0, deckCount: 0 },
      ),
    };
    expect(windowIsReachable('when_opponent_plays_spell', view)).toBe(true);
    expect(windowIsReachable('when_opponent_plays_spell', empty)).toBe(false);
    expect(reactionEnergyReserve(held, empty, 3)).toBe(0);
  });

  it('charges a play exactly the Reaction it strands, and nothing when it does not', () => {
    const view = tableView(3);
    const value = cardValue(counter, weights, database);
    // Three Energy down to one: the counter can no longer be played.
    expect(strandedReactionValue(held, view, 3, 1, weights, database)).toBeCloseTo(value);
    // Four down to three: it still can, so the play costs nothing extra.
    expect(strandedReactionValue(held, view, 4, 3, weights, database)).toBe(0);
  });

  it('holds the Energy when what it would buy is worth less than the answer', () => {
    // The behavioural half, on a real board: a 0/3 wall for one Energy against a
    // counter the seat can afford right now. Normal buys the wall; Hard does not.
    const table = CalibrationTable.open({ preconId: 'precon_containment_control', energy: 3 });
    table.give('calculated_response');
    table.give('archive_acolyte');
    const observation = table.observationFor(table.self);

    const best = (tactics: typeof BASELINE_TACTICS): string => {
      const candidates = candidateActions(observation, {
        weights: AGGRESSIVE_WEIGHTS,
        mayConcede: false,
        tactics,
      });
      return candidates
        .map((candidate) => ({
          key: candidate.key,
          score: scoreCandidate(observation, candidate, AGGRESSIVE_WEIGHTS, tactics),
        }))
        .reduce((a, b) => (b.score > a.score ? b : a)).key;
    };

    expect(best(BASELINE_TACTICS)).toBe('play:archive_acolyte:inst_t0083');
    expect(best(HARD_TACTICAL_TACTICS)).toBe('pass');
  });

  it('still spends the Energy when the body is worth more than the answer', () => {
    // The other direction, and the one that matters for a bot that must not
    // simply stop playing cards: a 3/2 for two outscores the counter it strands,
    // so Hard buys it — which is also why `hold_energy_for_the_counter` is still
    // a recorded gap rather than a closed one.
    const table = CalibrationTable.open({ preconId: 'precon_containment_control', energy: 3 });
    table.give('calculated_response');
    table.give('veil_skirmisher');
    const observation = table.observationFor(table.self);
    const candidates = candidateActions(observation, {
      weights: AGGRESSIVE_WEIGHTS,
      mayConcede: false,
      tactics: HARD_TACTICAL_TACTICS,
    });
    const picked = candidates
      .map((candidate) => ({
        key: candidate.key,
        score: scoreCandidate(observation, candidate, AGGRESSIVE_WEIGHTS, HARD_TACTICAL_TACTICS),
      }))
      .reduce((a, b) => (b.score > a.score ? b : a));
    expect(picked.key).toBe('play:veil_skirmisher:inst_t0083');
  });
});

/* -------------------------------------------------------- the boundary */

describe('a tactical profile changes nothing about the boundary', () => {
  it('reads no state outside the observation', () => {
    // The signature-level version of the claim: the three modules a profile
    // reaches into take a `BotObservation` and never a `MatchState`, and the
    // profile itself is data with no way to acquire one. Checked on the imports
    // rather than on the text, because the prose in these files says the word
    // and saying it is the opposite of the problem.
    for (const file of ['tactics.ts', 'candidates.ts', 'heuristic.ts']) {
      const source = readFileSync(join(HERE, file), 'utf8');
      const imports = source.slice(0, source.indexOf('/**'));
      expect(imports).not.toContain('MatchState');
      expect(source).not.toContain('state.instances');
      expect(source).not.toContain('state.players');
    }
  });

  it('never carries a difficulty selection, whichever profile it flies', () => {
    for (const pilotId of STYLED_PILOT_IDS) {
      for (const id of TACTICAL_PROFILE_IDS) {
        const pilot = createTacticalPilot({ pilotId, tactics: TACTICAL_PROFILES[id] });
        expect(pilot.config.selection).toEqual({ kind: 'best' });
        expect(pilot.config.tactics).toEqual({ ...TACTICAL_PROFILES[id] });
      }
    }
  });

  it.each(STYLED_PILOT_IDS)(
    '"%s" finishes matches legally under the hard tactical profile',
    async (pilotId) => {
      const seen = new Set<string>();
      for (const seed of ['t1', 't2', 't3', 't4']) {
        const outcome = await driveMatch({
          seed: `hard-${pilotId}-${seed}`,
          pilots: [
            createTacticalPilot({ pilotId, tactics: HARD_TACTICAL_TACTICS }),
            createTacticalPilot({ pilotId, tactics: HARD_TACTICAL_TACTICS }),
          ],
        });
        expect(outcome.stoppedEarly).toBe(false);
        expect(outcome.state.status).toBe('complete');
        expect(outcome.state.result?.reason).not.toBe('engine_error');
        // No fallback fired, so every action came from the pilot itself and was
        // one the engine had already offered.
        expect(outcome.failures).toEqual([]);
        for (const family of outcome.families) seen.add(family);
      }
      expect(seen.has('assign_blockers')).toBe(true);
      expect(seen.has('declare_attackers')).toBe(true);
      expect(seen.has('concede')).toBe(false);
    },
  );

  it('plays the four Wave 1 precons against each other, legally and to a result', async () => {
    // The committed corner of M09.15's smoke tournament. The full run is 768
    // matches — every ordered pairing of the four precons, at three styles, over
    // four seeds — and takes minutes, so it is a recorded measurement in the
    // milestone rather than a test. This keeps the part that would rot: a
    // Reaction-carrying, Token-making, Relic-carrying deck played end to end by
    // the profile, which is the only place in this file that exercises the
    // shipped card pool rather than the `prototype_core` fixtures.
    const decks = [
      'precon_bastion_guardians',
      'precon_containment_control',
      'precon_goblin_swarm',
      'precon_grave_sacrifice',
    ];
    for (let index = 0; index < decks.length; index += 1) {
      const left = decks[index] as string;
      const right = decks[(index + 1) % decks.length] as string;
      const outcome = await driveMatch({
        seed: `hard-precon-${left}-${right}`,
        database: calibrationDatabase(),
        decks: [preconMatchDeck(left), preconMatchDeck(right)],
        pilots: [
          createTacticalPilot({ pilotId: 'value', tactics: HARD_TACTICAL_TACTICS }),
          createTacticalPilot({ pilotId: 'aggressive', tactics: HARD_TACTICAL_TACTICS }),
        ],
        maxActions: 6000,
      });
      expect(outcome.stoppedEarly).toBe(false);
      expect(outcome.state.status).toBe('complete');
      expect(outcome.state.result?.reason).not.toBe('engine_error');
      expect(outcome.failures).toEqual([]);
      // A pilot that had turned into a passer would still "finish" by decking
      // out, so the shape of the finish is asserted rather than only the fact.
      expect(outcome.actions.some((action) => action.type === 'declare_attackers')).toBe(true);
    }
  }, 60_000);

  it('plays three- and four-seat tables under the hard tactical profile', async () => {
    for (const seats of [3, 4]) {
      const outcome = await driveMatch({
        seed: `hard-ffa-${seats}`,
        decks: [RED_DECK, GREEN_DECK, BLUE_DECK],
        pilots: Array.from({ length: seats }, (_, index) =>
          createTacticalPilot({
            pilotId: STYLED_PILOT_IDS[index % STYLED_PILOT_IDS.length] as 'value',
            tactics: HARD_TACTICAL_TACTICS,
          }),
        ),
      });
      expect(outcome.state.status).toBe('complete');
      expect(outcome.failures).toEqual([]);
    }
  });

  it('gives the same match twice from the same seed', async () => {
    const play = async (): Promise<string[]> => {
      const outcome = await driveMatch({
        seed: 'hard-determinism',
        pilots: [
          createTacticalPilot({ pilotId: 'value', tactics: HARD_TACTICAL_TACTICS }),
          createTacticalPilot({ pilotId: 'defensive', tactics: HARD_TACTICAL_TACTICS }),
        ],
      });
      return outcome.actions.map((action) => JSON.stringify(action));
    };
    expect(await play()).toEqual(await play());
  });

  it('decides the same whatever an opponent is holding', async () => {
    // The behavioural twin of the source scan. Two matches whose only difference
    // is the *opponent's* deck would normally diverge — so the comparison is of
    // the observations the profile was handed: every one of them is redacted,
    // and a decision taken on a redacted view cannot depend on a card in it.
    const observed: BotObservation[] = [];
    await driveMatch({
      seed: 'hard-redaction',
      decks: [RED_DECK, BLUE_DECK],
      pilots: [
        createTacticalPilot({ pilotId: 'value', tactics: HARD_TACTICAL_TACTICS }),
        createTacticalPilot({ pilotId: 'value', tactics: HARD_TACTICAL_TACTICS }),
      ],
      onObservation: (observation, policy) => {
        if (observation.view.viewerId === 'player_1' && policy.id === 'value') {
          observed.push(observation);
        }
      },
    });
    expect(observed.length).toBeGreaterThan(0);
    for (const observation of observed) {
      expect(observation).not.toHaveProperty('state');
      const visible = Object.values(observation.view.instances);
      // Nothing from a deck, and nothing from another seat's hand: the opponent's
      // hand is a count on the summary and its instances are simply absent.
      expect(visible.every((card) => card.zone !== 'deck')).toBe(true);
      expect(visible.every((card) => card.zone !== 'hand' || card.controller === 'player_1')).toBe(
        true,
      );
    }
  });

  it('answers every board the same way twice under the hard profile', () => {
    // Reproducibility one decision at a time, over the whole suite rather than
    // over one board: a refinement that read a `Set` iteration order or an
    // object key order would pass a single fixture and fail here.
    for (const fixture of CALIBRATION_FIXTURES) {
      const first = runFixture(fixture, 'value', 'hard_tactical');
      const second = runFixture(fixture, 'value', 'hard_tactical');
      expect(second.characteristic).toBe(first.characteristic);
      expect(second.decisions.map((decision) => decision.key)).toEqual(
        first.decisions.map((decision) => decision.key),
      );
    }
  });
});

describe('the named M05.6 tactical gaps', () => {
  const closed = [
    'goblin_swarm/bomb_the_body_it_defeats',
    'grave_sacrifice/knife_the_unit_it_kills',
    'goblin_swarm/absorb_with_the_wall_not_the_bruiser',
    'grave_sacrifice/block_with_the_body_that_survives',
    'containment_control/wall_eats_the_attack',
    // M09.15's sequencing half. Baseline still deploys the Guardian into an
    // empty board and follows with the Relic; Hard leads with the Relic.
    'bastion_guardians/armory_before_the_guardian',
  ];

  it.each(closed)('%s is answered by every pilot under the hard tactical profile', (fixtureId) => {
    const fixture = CALIBRATION_FIXTURES.find((entry) => entry.id === fixtureId);
    if (!fixture) throw new Error(`no fixture "${fixtureId}"`);
    // Recorded as closed in the fixture itself; asserted here as a statement
    // about the *tranche* rather than about one board, so removing a refinement
    // and quietly rewriting a record fails in two places.
    expect(fixture.tacticalGaps).toBeUndefined();
    for (const pilotId of CALIBRATED_PILOT_IDS) {
      expect(runFixture(fixture, pilotId, 'hard_tactical').characteristic).toBe(true);
    }
  });

  it('is honest about the strategic gap it did not close', () => {
    // One of M09.15's three is still open, and it is recorded in both places so
    // that closing it quietly is impossible: the fixture carries a note for
    // every pilot, and this names it as the tranche's remaining gap.
    const open = ['containment_control/hold_energy_for_the_counter'];
    for (const fixtureId of open) {
      const fixture = CALIBRATION_FIXTURES.find((entry) => entry.id === fixtureId);
      if (!fixture) throw new Error(`no fixture "${fixtureId}"`);
      expect(Object.keys(fixture.tacticalGaps ?? {}).sort()).toEqual(
        [...CALIBRATED_PILOT_IDS].sort(),
      );
      // The reserve is genuinely held — the refinement is not inert here, it is
      // outweighed — so a profile that stopped reserving would fail elsewhere
      // rather than silently agreeing with this record.
      for (const pilotId of CALIBRATED_PILOT_IDS) {
        expect(runFixture(fixture, pilotId, 'hard_tactical').characteristic).toBe(false);
      }
    }
  });

  it('records the sacrifice board as a rules correction rather than as a pilot one', () => {
    // `grave_sacrifice/make_fodder_before_spending_it` was one of M09.15's three
    // and closed for a reason that has nothing to do with a difficulty: the
    // owner's Token ruling (Q49) made a Thrall able to pay "sacrifice a Unit",
    // so the second card became playable at *every* profile. It must therefore
    // carry no gap at either, or a reader would cite it as evidence about Hard.
    const fixture = CALIBRATION_FIXTURES.find(
      (entry) => entry.id === 'grave_sacrifice/make_fodder_before_spending_it',
    );
    if (!fixture) throw new Error('no sacrifice sequencing fixture');
    expect(fixture.knownGaps).toBeUndefined();
    expect(fixture.tacticalGaps).toBeUndefined();
    for (const pilotId of CALIBRATED_PILOT_IDS) {
      expect(runFixture(fixture, pilotId, 'baseline').characteristic).toBe(true);
      expect(runFixture(fixture, pilotId, 'hard_tactical').characteristic).toBe(true);
    }
  });

  it('improves the suite overall without claiming every board improved', () => {
    const baseline = compareCalibrationSuite(CALIBRATION_FIXTURES, 'baseline');
    const hard = compareCalibrationSuite(CALIBRATION_FIXTURES, 'hard_tactical');
    expect(hard.stale).toEqual([]);

    for (const pilotId of CALIBRATED_PILOT_IDS) {
      const before = baseline.byPilot.find((row) => row.pilotId === pilotId);
      const after = hard.byPilot.find((row) => row.pilotId === pilotId);
      expect(after?.characteristic ?? 0).toBeGreaterThan(before?.characteristic ?? 0);
      // Still not a solved player: a rate of 1 would mean the suite had stopped
      // asking anything hard, and three strategic gaps are still open.
      expect(after?.rate ?? 1).toBeLessThan(1);
    }
    expect(hard.byFacet.attacking.total).toBeGreaterThan(0);
    expect(hard.byFacet.blocking.unanimousYes).toBeGreaterThan(
      baseline.byFacet.blocking.unanimousYes,
    );
    expect(hard.byFacet.targeting.unanimousYes).toBeGreaterThan(
      baseline.byFacet.targeting.unanimousYes,
    );
  });
});

describe('a tactical profile cannot reach the pilot registry', () => {
  it('refuses a pilot that is not trying', () => {
    expect(() =>
      createTacticalPilot({
        pilotId: 'random_legal',
        tactics: HARD_TACTICAL_TACTICS,
      }),
    ).toThrow(/makes no attempt to play well/);
  });

  it('keeps the style’s own identity, because the scorer is what it names', () => {
    // Deliberately: `pilotId`/`pilotVersion` identify the weight vector, and
    // which tactical profile flew is recorded beside them in `config` rather
    // than folded into them — the same separation M09.13 made for difficulty,
    // so a profile improving moves one record and not the other.
    const pilot = createTacticalPilot({ pilotId: 'defensive', tactics: HARD_TACTICAL_TACTICS });
    expect(pilot.id).toBe('defensive');
    expect(pilot.version).toBe(createPilot({ id: 'defensive' }).version);
    expect(pilot.config.tactics).toEqual({ ...HARD_TACTICAL_TACTICS });
  });
});
