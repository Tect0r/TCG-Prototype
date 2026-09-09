import { z } from 'zod';

import { comparisonDecisionSchema } from './comparison.js';
import { jobIdSchema } from './identity.js';
import { playerMetaPartitionSchema } from './player-meta-results.js';
import { resultColumnSchema, resultRowSchema } from './results.js';

/**
 * M08.27B — the version-delta transport.
 *
 * `./comparison.ts` classifies a baseline/candidate pair; nothing here
 * recomputes that classification, and every table below carries the
 * `ComparisonDecision` it was built under rather than assuming its caller
 * already knows it. A `refused` decision means the smallest defensible
 * payload — no columns, no rows — because M08.27A's whole point is that
 * refused pairs are never quietly compared (`comparisonDeltaTableSchema`'s
 * own refinement below makes that unspellable, not just documented).
 *
 * **Two domains stay two domains here too**, exactly as `./comparison.ts`
 * keeps them apart: `deck_matchups`, `commander_matchups`, `card_inclusion`,
 * `duration`, `terminations` and `deck_family` are catalog-domain, keyed by
 * two `JobId`s; `surrender_turns`, `surrender_phases` and `surrender_state`
 * are Player Meta-domain, keyed by two `PlayerMetaPartition`s.
 * `comparisonDeltaIdentitySchema` is a discriminated union rather than one
 * shape with both fields optional, so a catalog delta table can no more
 * carry a `PlayerMetaPartition` than `decideCatalogEnvironmentComparison`
 * can be handed one.
 *
 * **Deck-family is not a separate mechanism.** No table, field or constant
 * named "deck family" exists anywhere else in this repository — the
 * milestone names the concept, but nothing before this file defines it. The
 * `decks` table already carries two identities for the same row
 * (`apps/admin-server/src/service/results.ts`'s `deckShape`):
 * `deckHash`, content-addressed and expected to move whenever compared
 * content differs, and `deckId`, the caller-authored slot identity a deck
 * source assigns once (`deck.id` in `apps/simulator/src/deck-source.ts`)
 * and which a re-run of the same experiment configuration against
 * different content keeps stable. So "deck-family appearance or
 * disappearance" is exactly the generic keyed delta below, applied to the
 * `decks` table with `deckId` as the key instead of `deckHash` — a row
 * present on only one side *is* an appearance or disappearance, and needs
 * no bespoke shape of its own. `presence` on every keyed table is that
 * signal made explicit rather than left for a caller to infer from a
 * missing row.
 *
 * **Surrender-pattern is scoped to structure, not exposure.**
 * `apps/simulator/src/analysis/live-match-surrender.ts`'s own doc comment
 * already draws a line between surrender *state* (phase, combat, reaction
 * window, pending choice — structural facts about the moment of surrender)
 * and surrender *exposure* (which cards or event types were recently seen
 * beforehand — a claim closer to cause). This file's `surrender_turns`,
 * `surrender_phases` and `surrender_state` delta tables diff the state
 * side only; the exposure tables (`surrender_exposure_cards`,
 * `surrender_exposure_events`) are left out of this slice's scope rather
 * than silently folded in, because an exposure-rate delta is a materially
 * different question (a comparison of recency-weighted evidence, not a
 * count) that deserves its own named decision if the milestone wants it.
 *
 * **The Player Meta `compatible`-unreachability gap, accepted as-is.**
 * `./comparison.ts`'s file doc comment already names this precisely: under
 * today's Player Meta telemetry, `decidePlayerMetaComparison` can return
 * `refused` or `deliberately_different` but never `compatible`, because
 * `(contentVersion, rulesVersion)` cannot distinguish a balance-only card
 * change from no change at all. M08.27B computes deltas from whatever
 * verdict `decidePlayerMetaComparison` returns — it does not change which
 * verdicts are reachable. Every `surrender_*` delta this build can produce
 * is therefore `deliberately_different` (declared) or `refused`; that is a
 * property of the gate, not a defect in this file, and fixing the gate
 * itself (giving Player Meta a finer-grained content signal) is out of
 * scope for a slice titled "compute deltas."
 *
 * **No bounds on a delta.** A keyed metric that came from an `interval`
 * column (a Wilson-bounded rate) is diffed on its point estimate and its
 * support only — `baseline<Key>`, `candidate<Key>`, `delta<Key>`,
 * `baseline<Key>Games`, `candidate<Key>Games` — never a new low/high pair.
 * Subtracting two independent Wilson intervals is not itself a Wilson
 * interval, and fabricating one here would be exactly the kind of
 * statistic `@tcg/simulator` is the sole owner of computing (this file's
 * companion in `apps/admin-server` never reimplements one either).
 *
 * **Missing-metric behavior matches the rest of this package.** A metric
 * present on only one side reads `null` on the other with `0` support
 * (`spreadRateOrInsufficient`'s convention), and `delta<Key>` is `null`
 * whenever either side is `null` — never a fabricated point difference
 * against a zero-observation side.
 */

/** The named delta tables this build computes. */
export const COMPARISON_DELTA_TABLE_NAMES = [
  'deck_matchups',
  'commander_matchups',
  'card_inclusion',
  'duration',
  'terminations',
  'deck_family',
  'surrender_turns',
  'surrender_phases',
  'surrender_state',
] as const;
export const comparisonDeltaTableNameSchema = z.enum(COMPARISON_DELTA_TABLE_NAMES);
export type ComparisonDeltaTableName = z.infer<typeof comparisonDeltaTableNameSchema>;

/** The catalog-domain subset — matched against two `JobId`s. */
export const CATALOG_COMPARISON_DELTA_TABLES = [
  'deck_matchups',
  'commander_matchups',
  'card_inclusion',
  'duration',
  'terminations',
  'deck_family',
] as const;

/** The Player Meta-domain subset — matched against two `PlayerMetaPartition`s. */
export const PLAYER_META_COMPARISON_DELTA_TABLES = [
  'surrender_turns',
  'surrender_phases',
  'surrender_state',
] as const;

/**
 * Which two things were compared. A discriminated union rather than one
 * shape with both pairs optional, so a caller cannot hand a catalog table a
 * Player Meta identity or the reverse — `comparisonDeltaTableSchema`'s
 * refinement below still checks the pairing holds, since a union member's
 * own presence is not enough to prove it was matched to the right table.
 */
export const comparisonDeltaIdentitySchema = z.discriminatedUnion('domain', [
  z.strictObject({
    domain: z.literal('catalog'),
    baselineJobId: jobIdSchema,
    candidateJobId: jobIdSchema,
  }),
  z.strictObject({
    domain: z.literal('player_meta'),
    baseline: playerMetaPartitionSchema,
    candidate: playerMetaPartitionSchema,
  }),
]);
export type ComparisonDeltaIdentity = z.infer<typeof comparisonDeltaIdentitySchema>;

/** Most rows one delta table may carry. The same order of magnitude as `MAX_PLAYER_META_PARTITIONS` and the result-table page cap, for the same "bounded, not unlimited" reason. */
export const MAX_COMPARISON_DELTA_ROWS = 2000;

/**
 * Most columns one delta table may carry — wider than `MAX_RESULT_COLUMNS`
 * on purpose. A delta table fans each source column out into up to five of
 * its own (`baseline<Key>`, `candidate<Key>`, `delta<Key>` and a support pair
 * for an interval metric), so a source table already at the 48-column result
 * cap needs headroom well past it, not the same cap reapplied.
 */
export const MAX_COMPARISON_DELTA_COLUMNS = 250;

const catalogTableNames: readonly string[] = CATALOG_COMPARISON_DELTA_TABLES;

export const comparisonDeltaTableSchema = z
  .strictObject({
    table: comparisonDeltaTableNameSchema,
    identity: comparisonDeltaIdentitySchema,
    decision: comparisonDecisionSchema,
    columns: z.array(resultColumnSchema).max(MAX_COMPARISON_DELTA_COLUMNS),
    rows: z.array(resultRowSchema).max(MAX_COMPARISON_DELTA_ROWS),
  })
  .refine(
    (value) =>
      catalogTableNames.includes(value.table)
        ? value.identity.domain === 'catalog'
        : value.identity.domain === 'player_meta',
    {
      message:
        'A catalog delta table needs a catalog identity; a Player Meta delta table needs a Player Meta identity.',
      path: ['identity'],
    },
  )
  .refine(
    (value) => value.decision.kind !== 'refused' || (value.columns.length === 0 && value.rows.length === 0),
    {
      message: 'A refused comparison must carry no computed columns or rows: nothing was diffed.',
      path: ['decision'],
    },
  )
  .refine(
    (value) =>
      value.rows.every((row) => Object.keys(row).every((key) => value.columns.some((c) => c.key === key))),
    { message: 'Every cell must belong to a declared column.', path: ['rows'] },
  );
export type ComparisonDeltaTable = z.infer<typeof comparisonDeltaTableSchema>;
