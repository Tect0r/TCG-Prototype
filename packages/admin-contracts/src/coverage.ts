import { z } from 'zod';

import { contentIdSchema } from './content.js';
import { jobIdSchema } from './identity.js';
import { playerMetaPartitionSchema } from './player-meta-results.js';

/**
 * M08.27C — the coverage-model transport.
 *
 * A coverage report answers one question a result table cannot: *of the whole
 * card and mechanic vocabulary a format admits, how much of it did this run
 * actually exercise, and where it did not, why not.* `./results.ts`'s `cards`
 * table already reports the numbers for a card that appeared in the run; this
 * file's whole reason to exist is the cards that did not — M08.12 seeds a
 * run's card aggregate only from decks that ran at least one copy, so a card
 * absent from every deck has no row there at all, and a table with no row for
 * something is silent about it rather than honest about it.
 *
 * **Two domains, never merged**, the same split `./comparison-deltas.ts`
 * draws and for the same reason: a catalog run (`CoverageIdentity` `catalog`,
 * keyed by `JobId`) is simulated play against one resolved, content-addressed
 * `CardDatabase`; a Player Meta partition (`CoverageIdentity` `player_meta`,
 * keyed by `PlayerMetaPartition`) is human play against whatever this build
 * has bundled today (`currentLiveMatchCardDatabases`'s own honesty limit).
 * The milestone's own scope note calls human telemetry "another observation
 * source, not an automatic balance score" — so `observation` is the one
 * stage a Player Meta identity reports, and it is not recomputed from a
 * catalog run's numbers or blended with them.
 *
 * **Eight named stages in the milestone, seven measured here.** `target` is
 * deferred: no telemetry counter records a targeting decision anywhere in
 * `@tcg/simulator` today (`DEAD_HAND_CATEGORIES`'s `no_legal_target` records
 * a card's dead-hand *reason*, never a per-target outcome), so a `target`
 * stage here could only ever report `unavailable` for the whole vocabulary —
 * a constant, not a measurement. Recorded as an open gap rather than
 * implemented as a constant column; a future slice adds a real targeting
 * counter before this stage can mean anything.
 *
 * **The mechanic vocabulary is `@tcg/card-data`'s support registry, not a
 * free-form tag.** `MECHANIC_SUPPORT_LIST` names every kind of thing a card
 * can do (effect, static effect, trigger, keyword, condition, value, cost) and
 * already carries its own `telemetry` support level per entry; this file
 * restates `kind`/`id` as plain strings rather than importing
 * `@tcg/card-data`'s `MechanicKind` (ADR 0001 — this package has no
 * dependency on card data, only `@tcg/shared` and `zod`), the same choice
 * `./player-meta-results.ts` already makes for `rulesVersion`.
 *
 * **Status is three-valued, never a fabricated number.** `reached` is
 * genuine positive evidence; `not_reached` is a genuine negative — the stage
 * was measurable and never happened; `unavailable` is the honest third
 * option when the run's own data cannot support an answer either way
 * (no resolved environment, no seated Commander, a field a pre-instrumentation
 * schema version never recorded, or — for a mechanic — zero cards in this
 * database's vocabulary carrying it at all). `unavailableReasons` exists
 * precisely so `unavailable` is never a bare enum value with no way to know
 * why, mirroring `LiveCardEvidence.unavailableReason` and
 * `ComparisonDeltaTable`'s refused-decision convention.
 */

export const COVERAGE_STATUSES = ['reached', 'not_reached', 'unavailable'] as const;
export const coverageStatusSchema = z.enum(COVERAGE_STATUSES);
export type CoverageStatus = z.infer<typeof coverageStatusSchema>;

/** The catalog-domain funnel stages this build can genuinely measure. `target` is deferred (see file doc comment). */
export const CATALOG_COVERAGE_STAGES = [
  'eligibility',
  'inclusion',
  'draw',
  'play',
  'activation',
  'trigger',
] as const;
export const catalogCoverageStageSchema = z.enum(CATALOG_COVERAGE_STAGES);
export type CatalogCoverageStage = z.infer<typeof catalogCoverageStageSchema>;

/** The Player Meta-domain stage: human observation, kept apart from catalog play (see file doc comment). */
export const PLAYER_META_COVERAGE_STAGES = ['observation'] as const;
export const playerMetaCoverageStageSchema = z.enum(PLAYER_META_COVERAGE_STAGES);
export type PlayerMetaCoverageStage = z.infer<typeof playerMetaCoverageStageSchema>;

export const coverageIdentitySchema = z.discriminatedUnion('domain', [
  z.strictObject({ domain: z.literal('catalog'), jobId: jobIdSchema }),
  z.strictObject({ domain: z.literal('player_meta'), partition: playerMetaPartitionSchema }),
]);
export type CoverageIdentity = z.infer<typeof coverageIdentitySchema>;

/** One card's status at every catalog stage, over the run's whole deckable-plus-Commander vocabulary — not only the cards its own `cards` table rows. */
export const catalogCardCoverageSchema = z.strictObject({
  cardId: contentIdSchema,
  eligibility: coverageStatusSchema,
  inclusion: coverageStatusSchema,
  draw: coverageStatusSchema,
  play: coverageStatusSchema,
  activation: coverageStatusSchema,
  trigger: coverageStatusSchema,
  /** Present only for the stages above reported `unavailable` on this card. */
  unavailableReasons: z.partialRecord(catalogCoverageStageSchema, z.string()),
});
export type CatalogCardCoverage = z.infer<typeof catalogCardCoverageSchema>;

/** One mechanic's coverage — never per-stage, since no telemetry counter is scoped to one mechanic; see `./coverage.ts`'s companion service doc comment for how `status` is decided. */
export const catalogMechanicCoverageSchema = z.strictObject({
  kind: z.string().min(1),
  id: z.string().min(1),
  /** `${kind}:${id}`, `@tcg/card-data`'s `mechanicKey` restated, not imported. */
  mechanicKey: z.string().min(1),
  /** How many cards in this run's whole vocabulary use this mechanic (`mechanicsUsedBy`). Can be 0 — the milestone requires every `MECHANIC_KINDS` member listed, including ones today's data never uses. */
  cardsUsing: z.number().int().min(0),
  status: coverageStatusSchema,
  unavailableReason: z.string().nullable(),
});
export type CatalogMechanicCoverage = z.infer<typeof catalogMechanicCoverageSchema>;

export const catalogCoverageReportSchema = z.strictObject({
  identity: z.strictObject({ domain: z.literal('catalog'), jobId: jobIdSchema }),
  cards: z.array(catalogCardCoverageSchema),
  mechanics: z.array(catalogMechanicCoverageSchema),
  /** Set, with `cards`/`mechanics` empty, exactly when this run's resolved environment or summary could not be read — never a partial guess (mirrors `LiveCardEvidence.unavailableReason`). */
  unavailableReason: z.string().nullable(),
});
export type CatalogCoverageReport = z.infer<typeof catalogCoverageReportSchema>;

/** One card's observation status within one Player Meta partition. */
export const playerMetaCardCoverageSchema = z.strictObject({
  cardId: contentIdSchema,
  observation: coverageStatusSchema,
  unavailableReason: z.string().nullable(),
});
export type PlayerMetaCardCoverage = z.infer<typeof playerMetaCardCoverageSchema>;

export const playerMetaCoverageReportSchema = z.strictObject({
  identity: z.strictObject({
    domain: z.literal('player_meta'),
    partition: playerMetaPartitionSchema,
  }),
  cards: z.array(playerMetaCardCoverageSchema),
  /** Set, with `cards` empty, exactly when no card database could be resolved for this partition (`currentLiveMatchCardDatabases`'s mixed-format or unbundled-format refusal). */
  unavailableReason: z.string().nullable(),
});
export type PlayerMetaCoverageReport = z.infer<typeof playerMetaCoverageReportSchema>;
