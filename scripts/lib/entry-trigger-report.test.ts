import { describe, expect, it } from 'vitest';
import { loadBundledCardData } from '@tcg/card-data';
import {
  collectEntryUses,
  entryReportJson,
  formatEntryReport,
  type EntryUse,
} from './entry-trigger-report.js';

/**
 * `report:triggers` exists so the `deployed` / `entersBattlefield` review in
 * CLAUDE.md can be done card by card. A report that silently missed a card
 * would make that review look finished when it is not, so the shape of the
 * three groups is worth asserting.
 */

const sets = loadBundledCardData().sets;

describe('the entry-trigger report', () => {
  it('finds every explicit and implicit arrival in the bundled sets', () => {
    const uses = collectEntryUses(sets, null);
    expect(uses.length).toBeGreaterThan(0);

    // Cross-check against the validated card data rather than a fixture, so the
    // report cannot drift from the content it claims to describe.
    const expected: EntryUse[] = [];
    for (const set of sets) {
      for (const card of set.cards) {
        for (const form of ['on_deployed', 'on_entered_battlefield'] as const) {
          if (card.abilities.some((ability) => ability.trigger === form)) {
            expected.push({
              setId: set.setId,
              cardId: card.id,
              name: card.name,
              type: card.type,
              form,
              abilityIds: card.abilities
                .filter((ability) => ability.trigger === form)
                .map((ability) => ability.id),
              displayText: card.displayText ?? '',
            });
          }
        }
        const permanent = card.type !== 'spell' && card.type !== 'reaction';
        if (permanent && card.effects.length > 0) {
          expected.push({
            setId: set.setId,
            cardId: card.id,
            name: card.name,
            type: card.type,
            form: 'implicit_deploy_effects',
            abilityIds: [],
            displayText: card.displayText ?? '',
          });
        }
      }
    }
    expect(uses).toEqual(expected);
  });

  it('never reports a Spell or Reaction as arriving on the battlefield', () => {
    const implicit = collectEntryUses(sets, null).filter(
      (use) => use.form === 'implicit_deploy_effects',
    );
    expect(implicit.length).toBeGreaterThan(0);
    expect(implicit.map((use) => use.type)).not.toContain('spell');
    expect(implicit.map((use) => use.type)).not.toContain('reaction');
  });

  it('narrows to one set without changing what it reports about that set', () => {
    const setId = sets[0]?.setId ?? '';
    const scoped = collectEntryUses(sets, setId);
    expect(scoped.every((use) => use.setId === setId)).toBe(true);
    expect(scoped).toEqual(collectEntryUses(sets, null).filter((use) => use.setId === setId));
  });

  it('prints all three groups and the no-bulk-conversion warning', () => {
    const text = formatEntryReport(collectEntryUses(sets, null), null);
    expect(text).toContain('on_deployed —');
    expect(text).toContain('on_entered_battlefield —');
    expect(text).toContain('top-level effects —');
    expect(text).toContain('Do not convert them in bulk.');
  });

  it('emits a versioned JSON document', () => {
    const uses = collectEntryUses(sets, null);
    const parsed = JSON.parse(entryReportJson(uses)) as { schemaVersion: number; uses: EntryUse[] };
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.uses).toEqual(uses);
  });
});
