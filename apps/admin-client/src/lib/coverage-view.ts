import {
  CATALOG_COVERAGE_STAGES,
  type CatalogCardCoverage,
  type CatalogCoverageStage,
  type CoverageStatus,
  type PlayerMetaCardCoverage,
} from '@tcg/admin-contracts';

import type { Fact } from '../components/FactTable.js';

/**
 * M08.27C — the Coverage panel's pure helpers, the same split every other
 * explorer's `*-view.ts` draws between formatting/derivation and the
 * component that renders it.
 *
 * `coverage.ts`'s own status is intentionally three-valued and never a
 * fabricated number (see that file's doc comment); every helper here keeps
 * that distinction visible rather than collapsing `unavailable` into
 * `not_reached`.
 */

const STATUS_LABELS: Readonly<Record<CoverageStatus, string>> = {
  reached: 'Reached',
  not_reached: 'Not reached',
  unavailable: 'Unavailable',
};

/** A coverage status, in words. */
export function coverageStatusLabel(status: CoverageStatus): string {
  return STATUS_LABELS[status];
}

const CATALOG_STAGE_LABELS: Readonly<Record<CatalogCoverageStage, string>> = {
  eligibility: 'Eligibility',
  inclusion: 'Inclusion',
  draw: 'Draw',
  play: 'Play',
  activation: 'Activation',
  trigger: 'Trigger',
};

/** A catalog funnel stage, in words. */
export function catalogCoverageStageLabel(stage: CatalogCoverageStage): string {
  return CATALOG_STAGE_LABELS[stage];
}

/** A count per status, always naming all three even when a count is zero. */
export type CoverageTally = Readonly<Record<CoverageStatus, number>>;

function emptyTally(): { reached: number; not_reached: number; unavailable: number } {
  return { reached: 0, not_reached: 0, unavailable: 0 };
}

/** How many cards in this report landed at each status, for one catalog stage. */
export function catalogStageTally(cards: readonly CatalogCardCoverage[], stage: CatalogCoverageStage): CoverageTally {
  const tally = emptyTally();
  for (const card of cards) tally[card[stage]] += 1;
  return tally;
}

/** How many cards in this report landed at each observation status (Player Meta domain). */
export function playerMetaObservationTally(cards: readonly PlayerMetaCardCoverage[]): CoverageTally {
  const tally = emptyTally();
  for (const card of cards) tally[card.observation] += 1;
  return tally;
}

/** Every catalog stage's tally, as `Fact`s for a summary `FactTable`. */
export function catalogStageTallyFacts(cards: readonly CatalogCardCoverage[]): Fact[] {
  return CATALOG_COVERAGE_STAGES.map((stage) => {
    const tally = catalogStageTally(cards, stage);
    return {
      label: catalogCoverageStageLabel(stage),
      value: `${tally.reached} reached, ${tally.not_reached} not reached, ${tally.unavailable} unavailable`,
    };
  });
}
