import { z } from 'zod';

import { looksLikeFilesystemPath } from './errors.js';
import { pageInfoSchema, PAGE_SIZE_MAX } from './pagination.js';
import { liveMatchContentVersionSchema, liveMatchSourceSchema } from './player-meta.js';
import {
  MAX_RESULT_COLUMNS,
  resultColumnSchema,
  resultRowSchema,
  type ResultColumn,
} from './results.js';

/**
 * How M08.24's live-match Player Meta aggregates travel, directory-keyed
 * rather than job-keyed — the same reason `./adaptive-results.ts` is:
 * `EXPERIMENT_KINDS` (`./identity.ts`) has no member for a live-match
 * aggregate either, and a Player Meta read has no `JobId` to key one by.
 *
 * `./results.ts` is still the pattern this restates: a reading is transport,
 * not a definition, and every number a table or summary carries is read back
 * out of `apps/simulator`'s own aggregation
 * (`analysis/live-match-aggregate.ts`, `analysis/live-card-evidence.ts`,
 * `analysis/clusters.ts`) at the moment it is shown — never recomputed here,
 * per ADR 0023 §2.
 *
 * Unlike an Adaptive Counter run, a Player Meta read has no single canonical
 * result document: it is a reduction over however many
 * `LiveMatchEnvelope`s a resolved root directory holds, filtered by
 * `playerMetaFilterSchema` (`./player-meta.ts`) before aggregation ever
 * runs. `playerMetaResultSourceSchema` names that shape directly —
 * how many records were read and how many were skipped as damaged or
 * unreadable — rather than reusing `adaptiveResultSourceSchema`'s
 * `{document, schemaVersion}`, which describes a single file this read
 * does not have.
 *
 * Every partition M08.24 keeps apart — `(source, contentVersion,
 * rulesVersion)` — stays apart here too: a table spans every partition a
 * filtered query found, but each row carries its own partition columns
 * rather than being scoped to one, so a caller never has to make N
 * requests to see N partitions' worth of source labels side by side, and a
 * partition is never pooled into another by virtue of appearing in the same
 * response.
 */

/* ------------------------------------------------------------------ identity */

export const playerMetaPartitionSchema = z.strictObject({
  source: liveMatchSourceSchema,
  contentVersion: liveMatchContentVersionSchema,
  /** `MatchState.rulesVersion` as it stood at match time — restated from `liveMatchProvenanceSchema`, not imported (ADR 0001). */
  rulesVersion: z.string().min(1),
});
export type PlayerMetaPartition = z.infer<typeof playerMetaPartitionSchema>;

/* --------------------------------------------------------------- the tables */

/**
 * The tables this build can serve out of a resolved Player Meta root
 * directory.
 *
 * One per evidence stream the milestone names: `commanders` is Commander
 * selection and win rate (`CommanderSelectionEntry`); `decks` and
 * `deck_matchups` are the deck-level counterparts (`DeckUsageEntry`,
 * `DeckMatchupEntry`); `clusters` and `cluster_matchups` are the strategic
 * grouping `LiveMatchClusterView` computes, kept apart from the deck tables
 * because a cluster's row shape (`centroid`-derived label, member decks) is
 * not a deck's; `cards` and `pairs` are the eligibility-aware evidence
 * `aggregateLiveCardEvidence` produces, one row per partition × Commander ×
 * card (or card pair) rather than a nested shape a result row cannot carry;
 * `duration` is one row per partition (`LiveMatchDurationStats`); and
 * `terminations` is one row per partition × termination origin
 * (`TerminationOriginCount`).
 *
 * M08.25D adds five more, all read from `aggregateLiveMatchSurrenders`
 * (`analysis/live-match-surrender.ts`, M08.24D) rather than a whole-match
 * population: `surrender_turns` and `surrender_phases` are one row per
 * partition × turn (or phase) a voluntary surrender happened on
 * (`SurrenderTurnEntry`, `SurrenderPhaseEntry`); `surrender_state` is one row
 * per partition summarizing structural state at the surrender instant —
 * never board, Health or resource numbers, which a pre-action capture does
 * not carry (`SurrenderStateSummary`'s own doc comment); `surrender_exposure_cards`
 * and `surrender_exposure_events` are one row per partition × card (or event
 * type) that appeared in a surrendering player's retained event window
 * (`SurrenderProximityEntry`), reported as *exposure*, never *cause* — the
 * same restraint `live-match-surrender.ts`'s own doc comment requires of this
 * exact computation.
 */
export const PLAYER_META_RESULT_TABLE_NAMES = [
  'commanders',
  'decks',
  'deck_matchups',
  'clusters',
  'cluster_matchups',
  'cards',
  'pairs',
  'duration',
  'terminations',
  'surrender_turns',
  'surrender_phases',
  'surrender_state',
  'surrender_exposure_cards',
  'surrender_exposure_events',
] as const;
export const playerMetaResultTableNameSchema = z.enum(PLAYER_META_RESULT_TABLE_NAMES);
export type PlayerMetaResultTableName = z.infer<typeof playerMetaResultTableNameSchema>;

/**
 * How a Player Meta reading was assembled — not which canonical document
 * produced it, because there is not one. `recordsRead` is every
 * `LiveMatchEnvelope` this reduction actually aggregated (after
 * `playerMetaFilterSchema` narrowed the set); `recordsSkipped` is every
 * match directory `readLiveMatchEnvelopes` could not read, so a reader can
 * tell "no matches" from "matches this build could not parse" apart.
 */
export const playerMetaResultSourceSchema = z.strictObject({
  recordsRead: z.number().int().min(0),
  recordsSkipped: z.number().int().min(0),
});
export type PlayerMetaResultSource = z.infer<typeof playerMetaResultSourceSchema>;

/**
 * One page of one Player Meta result table, spanning every partition a
 * filtered query found.
 *
 * Bounded exactly as `resultTableSchema` is: `pageInfoSchema` bounds the
 * rows, `MAX_RESULT_COLUMNS` bounds the width, and the same two invariants —
 * a page reports the rows it actually carries, and every cell belongs to a
 * declared column — are re-checked here rather than assumed from the
 * sibling schema.
 */
export const playerMetaResultTableSchema = z
  .strictObject({
    table: playerMetaResultTableNameSchema,
    source: playerMetaResultSourceSchema,
    columns: z.array(resultColumnSchema).min(1).max(MAX_RESULT_COLUMNS),
    rows: z.array(resultRowSchema).max(PAGE_SIZE_MAX),
    page: pageInfoSchema,
  })
  .refine(
    (value) => value.rows.length === value.page.returned,
    'A Player Meta result table must report the number of rows it carries.',
  )
  .refine(
    (value) =>
      value.rows.every((row) => Object.keys(row).every((key) => hasPlayerMetaColumn(value, key))),
    'Every cell in a Player Meta result table belongs to a declared column.',
  );
export type PlayerMetaResultTable = z.infer<typeof playerMetaResultTableSchema>;

function hasPlayerMetaColumn(
  table: { readonly columns: readonly ResultColumn[] },
  key: string,
): boolean {
  return table.columns.some(
    (column) => column.key === key || column.bounds?.low === key || column.bounds?.high === key,
  );
}

/* ----------------------------------------------------------- the summary */

/** Most partitions one summary lists side by side. Bounded like everything else this package returns. */
export const MAX_PLAYER_META_PARTITIONS = 500;

/** One partition's headline counts — enough for a dashboard to list every source/version split before fetching any table. */
export const playerMetaPartitionSummarySchema = z.strictObject({
  partition: playerMetaPartitionSchema,
  /** Every match in this partition, any outcome. Match-weighted: one grinding deck can dominate this. */
  matches: z.number().int().min(0),
  /** Distinct decks played in this partition — the unique-deck-weighted counterpart to `matches`. */
  uniqueDecks: z.number().int().min(0),
  decisiveMatches: z.number().int().min(0),
});
export type PlayerMetaPartitionSummary = z.infer<typeof playerMetaPartitionSummarySchema>;

/**
 * A filtered Player Meta query's headline reading, assembled from a
 * resolved root directory's matches at the moment it is asked for.
 *
 * Deliberately thinner than `resultSummarySchema` and even
 * `adaptiveRunSummarySchema`: there is no `jobId` or `experimentId` (a
 * Player Meta read is not addressed by either), and no single
 * `evidenceStanding` — the milestone's calibration-evidence rule attaches to
 * an Adaptive Counter or search run's own writeup, and a live-match reading
 * carries no comparable standing to report. What travels is exactly what a
 * filtered read can answer today: how the read was assembled, one summary
 * row per partition it found, which tables have rows to fetch and how many,
 * and the fixed limitations this evidence may never be cited past.
 */
export const playerMetaRunSummarySchema = z.strictObject({
  source: playerMetaResultSourceSchema,
  partitions: z.array(playerMetaPartitionSummarySchema).max(MAX_PLAYER_META_PARTITIONS),
  /** Which tables have rows to fetch, and how many. Saves a client nine empty requests. */
  tables: z
    .array(
      z.strictObject({ table: playerMetaResultTableNameSchema, rows: z.number().int().min(0) }),
    )
    .max(PLAYER_META_RESULT_TABLE_NAMES.length),
  /**
   * What this reading may never be cited past, shown beside its numbers.
   * Fixed for now rather than sourced from a registry, for the same reason
   * `adaptiveRunSummarySchema.limitations` is: there is no `JobOrigin` for a
   * directory-keyed read. Checked to be free of anything path-shaped for
   * the same reason `resultSummarySchema.limitations` is.
   */
  limitations: z
    .array(
      z
        .string()
        .min(1)
        .max(600)
        .refine(
          (value) => !value.split(/\s+/).some(looksLikeFilesystemPath),
          'A limitation names a claim, not a file.',
        ),
    )
    .max(32),
});
export type PlayerMetaRunSummary = z.infer<typeof playerMetaRunSummarySchema>;
