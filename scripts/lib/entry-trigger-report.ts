/**
 * The `report:triggers` review report, separated from its CLI shell.
 *
 * Rule adjustment §7 keeps `deployed` and `entersBattlefield` as distinct engine
 * events and **forbids** converting existing "when deployed" cards to the wider
 * trigger wholesale: each one has to be judged on its own intent. That review
 * needs a list, and this builds the list.
 *
 * It reports three groups, because a card can say "when this arrives" in three
 * different ways and only one of them is obvious:
 *
 * 1. `on_deployed` — an explicit ability, fires only when the card was played by
 *    paying its deployment cost.
 * 2. `on_entered_battlefield` — an explicit ability, fires however the card got
 *    there, including revival.
 * 3. Top-level `effects` on a permanent — the *implicit* deploy behaviour
 *    (CLAUDE.md §17 Q1). These are the easy ones to forget: nothing in the card
 *    file names a trigger at all, yet they behave exactly like group 1.
 *
 * This is a reporting tool, not a validator. It never fails a build and it never
 * proposes a change: it reports what each card currently does so a human can
 * decide whether revival should re-fire it.
 */
import { type CardSet, type CardDefinition } from '@tcg/card-data';

/** How a card asks to do something when it arrives on the battlefield. */
export type EntryForm = 'on_deployed' | 'on_entered_battlefield' | 'implicit_deploy_effects';

export interface EntryUse {
  readonly setId: string;
  readonly cardId: string;
  readonly name: string;
  readonly type: CardDefinition['type'];
  readonly form: EntryForm;
  /** Ability IDs for the explicit forms; empty for the implicit one. */
  readonly abilityIds: readonly string[];
  readonly displayText: string;
}

export const FORM_TITLES: Record<EntryForm, string> = {
  on_deployed: 'on_deployed — fires only when played for its deployment cost',
  on_entered_battlefield: 'on_entered_battlefield — fires on any arrival, including revival',
  implicit_deploy_effects: 'top-level effects — implicit deploy behaviour, no trigger named',
};

/**
 * Every entry-trigger use in `sets`, in set then file order.
 *
 * Takes validated `CardSet`s rather than the raw bundle: the raw payloads are
 * `unknown` by design, and a report that guessed at their shape would silently
 * skip a card whose data did not parse.
 */
export function collectEntryUses(sets: readonly CardSet[], setFilter: string | null): EntryUse[] {
  const uses: EntryUse[] = [];

  for (const set of sets) {
    if (setFilter && set.setId !== setFilter) continue;

    for (const card of set.cards) {
      for (const form of ['on_deployed', 'on_entered_battlefield'] as const) {
        const matching = card.abilities.filter((ability) => ability.trigger === form);
        if (matching.length === 0) continue;
        uses.push({
          setId: set.setId,
          cardId: card.id,
          name: card.name,
          type: card.type,
          form,
          abilityIds: matching.map((ability) => ability.id),
          displayText: card.displayText ?? '',
        });
      }

      // A Spell's or Reaction's top-level effects are the card resolving, not an
      // arrival — neither ever reaches the battlefield.
      const isPermanent = card.type !== 'spell' && card.type !== 'reaction';
      if (isPermanent && card.effects.length > 0) {
        uses.push({
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

  return uses;
}

/** The human-readable report, grouped by form and sorted by card ID. */
export function formatEntryReport(uses: readonly EntryUse[], setFilter: string | null): string {
  const scope = setFilter ? `set ${setFilter}` : 'all sets';
  let out = `Entry triggers in ${scope} — ${uses.length} use(s) across cards.\n`;
  out += 'Rule adjustment §7: review these card by card. Do not convert them in bulk.\n';

  for (const form of Object.keys(FORM_TITLES) as EntryForm[]) {
    const group = uses.filter((use) => use.form === form);
    out += `\n${FORM_TITLES[form]}\n  ${group.length} card(s)\n`;
    if (group.length === 0) continue;

    for (const use of [...group].sort((a, b) => a.cardId.localeCompare(b.cardId))) {
      const abilities = use.abilityIds.length > 0 ? ` [${use.abilityIds.join(', ')}]` : '';
      out += `\n  ${use.cardId}${abilities}\n`;
      out += `    ${use.name} — ${use.type}, ${use.setId}\n`;
      if (use.displayText) out += `    "${use.displayText}"\n`;
    }
  }

  return `${out}\n`;
}

/** The `--json` document. Versioned so a consumer can tell the shape apart. */
export function entryReportJson(uses: readonly EntryUse[]): string {
  return `${JSON.stringify({ schemaVersion: 1, uses }, null, 2)}\n`;
}
