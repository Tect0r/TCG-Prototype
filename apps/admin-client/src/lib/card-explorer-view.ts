import type { CardExplorerEligibilityStatus, ResultRow } from '@tcg/admin-contracts';

import { formatPercent } from './dashboard-view.js';
import type { Fact } from '../components/FactTable.js';

/**
 * M08.26C — the Card Explorer panel's pure helpers, the same split
 * `deck-explorer-view.ts` draws between formatting/derivation and the
 * component that renders it.
 *
 * Unlike the Deck Explorer, this view has no reused Player Meta table to
 * fall back on for its own inclusion/partner/contributing evidence — those
 * arrays are `cardExplorerViewSchema`'s own shape, so this file's helpers
 * format them directly rather than delegating to `player-meta-view.ts`. Only
 * `experimentEvidence.row` is a raw `ResultRow` (reused verbatim from the
 * job's own `'cards'` table, per `card-explorer.ts`'s doc comment), so
 * `resultRowFacts` renders it generically — key/value, no column metadata —
 * because this view was never given one.
 */

const ELIGIBILITY_LABELS: Readonly<Record<CardExplorerEligibilityStatus, string>> = {
  played: 'Played',
  held: 'Held',
  unusable: 'Unusable',
};

/** An eligibility status, in words. */
export function cardExplorerEligibilityLabel(status: CardExplorerEligibilityStatus): string {
  return ELIGIBILITY_LABELS[status];
}

/** A nullable 0–1 rate — `null` only when its cell's own eligibility rule forces it (never a fabricated zero). */
export function formatCardExplorerRate(rate: number | null): string {
  return rate === null ? 'Not applicable — structurally ineligible' : formatPercent(rate);
}

/** One raw result row rendered as generic facts — no column metadata is available for it here. */
export function resultRowFacts(row: ResultRow): Fact[] {
  return Object.entries(row).map(([key, value]) => ({
    label: key,
    value: value === null ? 'Not measured' : String(value),
  }));
}
