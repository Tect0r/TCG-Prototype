import { describe, expect, it } from 'vitest';
import {
  CardDatabase,
  cardDefinitionSchema,
  loadBundledCardData,
  type CardDefinition,
} from '@tcg/card-data';
import { validateContent } from './validate.js';

const bundled = loadBundledCardData();

function databaseOf(...cards: readonly CardDefinition[]): CardDatabase {
  return new CardDatabase(cards);
}

function unitCard(overrides: Record<string, unknown> = {}): CardDefinition {
  return cardDefinitionSchema.parse({
    schemaVersion: 2,
    id: 'valid_unit',
    name: 'Valid Unit',
    type: 'unit',
    colorIdentity: ['green'],
    cost: 2,
    attack: 2,
    health: 3,
    ...overrides,
  });
}

/** Codes reported, for readable assertions. */
function codes(report: { readonly issues: readonly { readonly code: string }[] }): string[] {
  return report.issues.map((issue) => issue.code);
}

describe('content validation', () => {
  it('passes for the bundled card pool', () => {
    const report = validateContent({ database: bundled.database });
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.counts.cards).toBe(bundled.database.size);
    expect(report.counts.rulebookSections).toBeGreaterThanOrEqual(17);
  });

  it('warns, but does not fail, for keywords the engine ignores', () => {
    const report = validateContent({ database: bundled.database });
    expect(codes(report)).toContain('content/inert_keyword');
    expect(report.ok).toBe(true);
  });

  it('reports a duplicate card ID with its filename', () => {
    // CardDatabase does not deduplicate for us, so a duplicate reaches the
    // validator exactly as a bad merge would produce it.
    const report = validateContent({
      database: databaseOf(unitCard(), unitCard({ name: 'Other Unit' })),
    });
    const duplicate = report.errors.find((issue) => issue.code === 'content/duplicate_card_id');
    expect(duplicate?.message).toContain('cards/valid_unit.json');
    expect(report.ok).toBe(false);
  });

  it('rejects a card ID that breaks the naming convention', () => {
    // Constructed past the schema on purpose: this is the failure mode of a
    // hand-edited data file, and validation must catch it either way.
    const malformed = { ...unitCard(), id: 'Bad-ID' } as CardDefinition;
    const report = validateContent({ database: databaseOf(malformed) });
    const issue = report.errors.find((entry) => entry.code === 'content/invalid_card_id');
    expect(issue?.message).toMatch(/lowercase_snake_case/);
  });

  it('rejects an effect type with no explanation renderer', () => {
    const unsupported = {
      ...unitCard(),
      effects: [{ type: 'time_travel', amount: 1 }],
    } as unknown as CardDefinition;
    const report = validateContent({ database: databaseOf(unsupported) });
    const issue = report.errors.find((entry) => entry.code === 'content/missing_effect_renderer');
    expect(issue?.message).toContain('valid_unit');
    expect(issue?.message).toContain('effects[0].type');
    expect(report.ok).toBe(false);
  });

  it('rejects an unknown configuration reference in curated text', () => {
    const card = unitCard({ text: { summary: 'Costs {matchConfig.notARealSetting} energy.' } });
    const report = validateContent({ database: databaseOf(card) });
    const issue = report.errors.find((entry) => entry.code === 'content/unknown_reference');
    expect(issue?.message).toContain('notARealSetting');
    expect(issue?.path).toContain('text.summary');
  });

  it('accepts a reference that does resolve', () => {
    const card = unitCard({
      text: { summary: 'You start on {matchConfig.startingHealth} health.' },
    });
    const report = validateContent({ database: databaseOf(card) });
    expect(report.errors).toEqual([]);
  });

  it('rejects an effect clarification left behind by an edit', () => {
    const stale = {
      ...unitCard(),
      text: { effectExplanations: ['Explains a step that no longer exists.'] },
    } as CardDefinition;
    const report = validateContent({ database: databaseOf(stale) });
    const issue = report.errors.find((entry) => entry.code === 'content/stale_effect_explanation');
    expect(issue?.message).toContain('no longer exists');
  });

  it('catches the same drift at the schema boundary', () => {
    const parsed = cardDefinitionSchema.safeParse({
      schemaVersion: 2,
      id: 'drifting_card',
      name: 'Drifting Card',
      type: 'unit',
      colorIdentity: [],
      cost: 1,
      attack: 1,
      health: 1,
      text: { effectExplanations: ['a', 'b'] },
    });
    expect(parsed.success).toBe(false);
  });

  it('flags a misnamed artwork file but never a missing one', () => {
    const report = validateContent({
      database: databaseOf(unitCard()),
      artworkFiles: ['Valid-Unit.png', 'valid_unit.png', 'notes.txt'],
    });
    expect(codes(report)).toContain('content/invalid_artwork_name');
    expect(codes(report)).toContain('content/unexpected_artwork_file');
    // `valid_unit.png` matches a real card, and no card is required to have art.
    expect(report.issues.filter((issue) => issue.message.includes('valid_unit.png'))).toEqual([]);
  });

  it('warns about artwork that matches no card', () => {
    const report = validateContent({
      database: databaseOf(unitCard()),
      artworkFiles: ['deleted_card.png'],
    });
    const issue = report.warnings.find((entry) => entry.code === 'content/orphan_artwork');
    expect(issue?.message).toContain('deleted_card.png');
    expect(report.ok).toBe(true);
  });

  it('accepts a brand new data-only card with no code change at all', () => {
    const newcomer = cardDefinitionSchema.parse({
      schemaVersion: 2,
      id: 'help_test_newcomer',
      name: 'Help Test Newcomer',
      type: 'spell',
      colorIdentity: ['red'],
      cost: 3,
      displayText: 'Deal 2 damage to an enemy unit, then draw a card.',
      effects: [
        {
          type: 'deal_damage',
          amount: 2,
          target: {
            kind: 'entity',
            selector: { zone: 'battlefield', controller: 'opponent', count: 1 },
          },
        },
        { type: 'draw', player: 'self', amount: 1 },
      ],
    });

    const database = new CardDatabase([...bundled.database.all(), newcomer]);
    const report = validateContent({ database });
    expect(report.errors).toEqual([]);
    expect(database.get('help_test_newcomer')).toBeDefined();
  });
});
