import { describe, expect, it } from 'vitest';
import {
  AGENT_CLASSES_WITHOUT_PILOTS,
  LEGAL_ONLY_PILOT_IDS,
  PILOT_IDS,
  type PilotId,
} from '@tcg/bot-interface';
import { preconsForFormat } from '@tcg/card-data';

import { pilotCatalog, preconsForEnvironment } from './content-catalog.js';
import { resolveDeckSource } from './deck-source.js';
import { resolveEnvironment, type EnvironmentConfigInput } from './environment.js';

/**
 * M08.8 — the list a chooser is offered, and the run that would follow it.
 *
 * The property worth holding down is not "the list is non-empty". It is that the
 * list and the run **agree**: a precon this reports as playable is one
 * `resolveDeckSource` accepts, and a precon it marks refused is one
 * `resolveDeckSource` rejects. A builder screen offering a precon the experiment
 * then stops on is exactly the failure a second legality rule produces, and this
 * suite is what makes that impossible rather than unlikely.
 */

const WAVE_1 = 'precon_wave_1';

function wave1Environment(overrides: Partial<EnvironmentConfigInput> = {}): EnvironmentConfigInput {
  return {
    id: 'wave_1',
    format: WAVE_1,
    deckFormat: { formatId: WAVE_1, deckSize: 40, singleton: true },
    ...overrides,
  };
}

describe('preconsForEnvironment', () => {
  it('publishes exactly the precons the environment’s own format does', () => {
    const environment = resolveEnvironment(wave1Environment());
    const published = preconsForEnvironment(environment);

    expect(published.map((entry) => entry.preconId)).toEqual(
      preconsForFormat(WAVE_1).map((precon) => precon.id),
    );
    expect(published.length).toBeGreaterThan(1);
    for (const entry of published) expect(entry.formatId).toBe(WAVE_1);
  });

  it('reports every shipped precon as playable in the format it is published for', () => {
    const environment = resolveEnvironment(wave1Environment());
    for (const entry of preconsForEnvironment(environment)) {
      expect(`${entry.preconId}: ${entry.refusals.join(' | ')}`).toBe(`${entry.preconId}: `);
    }
  });

  it('agrees with the resolution a run would actually perform', () => {
    // The whole reason this module is not a second list. Whatever the verdict
    // here, the experiment's own call has to reach the same one.
    const environment = resolveEnvironment(wave1Environment());
    for (const entry of preconsForEnvironment(environment)) {
      const resolves = ((): boolean => {
        try {
          resolveDeckSource(
            { kind: 'precon', preconIds: [entry.preconId] },
            environment,
            'agreement',
          );
          return true;
        } catch {
          return false;
        }
      })();
      expect(`${entry.preconId}: ${String(resolves)}`).toBe(
        `${entry.preconId}: ${String(entry.refusals.length === 0)}`,
      );
    }
  });

  it('marks a precon the environment refuses rather than dropping it from the list', () => {
    // An environment that bans a card the precon needs. The precon is still
    // published by the format, so a chooser must be able to tell "this format has
    // four precons and one is unplayable here" from "this format has three".
    const playable = preconsForEnvironment(resolveEnvironment(wave1Environment()));
    const victim = playable[0];
    expect(victim).toBeDefined();
    const banned = preconsForFormat(WAVE_1).find((precon) => precon.id === victim?.preconId);
    expect(banned).toBeDefined();

    const environment = resolveEnvironment(
      wave1Environment({ banCardIds: [banned?.cardIds[0] ?? ''] }),
    );
    const published = preconsForEnvironment(environment);

    expect(published.map((entry) => entry.preconId)).toEqual(
      playable.map((entry) => entry.preconId),
    );
    const refused = published.find((entry) => entry.preconId === victim?.preconId);
    expect(refused?.refusals.length).toBeGreaterThan(0);
    expect(refused?.refusals.join(' ')).toContain(banned?.cardIds[0] ?? 'nothing');
  });

  it('is empty for a format that publishes no precon, rather than falling back', () => {
    const environment = resolveEnvironment({
      id: 'fixtures',
      format: 'development',
      deckFormat: { formatId: 'development', deckSize: 30, copyLimit: 2 },
    });
    expect(preconsForEnvironment(environment)).toEqual([]);
  });

  it('carries the authored strategy and the card count content states', () => {
    const environment = resolveEnvironment(wave1Environment());
    for (const entry of preconsForEnvironment(environment)) {
      const source = preconsForFormat(WAVE_1).find((precon) => precon.id === entry.preconId);
      expect(entry.strategy).toBe(source?.strategy);
      expect(entry.cardCount).toBe(source?.cardIds.length);
      expect(entry.commanderId).toBe(source?.commanderId);
    }
  });
});

describe('pilotCatalog', () => {
  it('publishes every registered pilot, in registry order', () => {
    expect(pilotCatalog().map((entry) => entry.pilotId)).toEqual([...PILOT_IDS]);
  });

  it('reports play-quality evidence exactly where the agent-class taxonomy does', () => {
    // `LEGAL_ONLY_PILOT_IDS` is the registry's own view of the same predicate, so
    // the two are required to be complements rather than merely similar.
    const legalOnly = new Set<string>(LEGAL_ONLY_PILOT_IDS);
    for (const entry of pilotCatalog()) {
      expect(`${entry.pilotId}: ${String(entry.playQualityEvidence)}`).toBe(
        `${entry.pilotId}: ${String(!legalOnly.has(entry.pilotId as PilotId))}`,
      );
    }
    expect(pilotCatalog().some((entry) => !entry.playQualityEvidence)).toBe(true);
  });

  it('names each pilot’s agent class, and none of the classes without pilots', () => {
    const classes = new Set(pilotCatalog().map((entry) => entry.agentClass));
    for (const absent of AGENT_CLASSES_WITHOUT_PILOTS) expect(classes.has(absent)).toBe(false);
    for (const entry of pilotCatalog()) expect(entry.agentClass.length).toBeGreaterThan(0);
  });
});
