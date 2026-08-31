import { z } from 'zod';

import { runIdentitySchema } from './catalog.js';
import { jobIdSchema, timestampSchema } from './identity.js';

/**
 * The canonical files a finished run already wrote, offered for download
 * unchanged.
 *
 * M08.10 owes *exact downloadable JSON, CSV and Markdown artifacts*, and there
 * were two ways to owe it. The admin surface could **generate** them — serialize
 * `resultTableSchema` into CSV, render a Markdown report out of
 * `resultSummarySchema` — or it could **serve what the run wrote**. The second
 * is the only one this milestone's rules permit:
 *
 * - ADR 0023 §2 forbids the admin layer from duplicating *report meaning*. A
 *   Markdown report assembled here would be a second report, worded by a screen,
 *   drifting from `report.md` the first time the simulator changes what a report
 *   says.
 * - The locked interpretation makes the experiment directory canonical and says
 *   a catalog *may index them; it must not replace their provenance contract
 *   with an opaque database*. A generated CSV is a derivative a reader would
 *   then quote as though it were the run's own output.
 * - `experimentPaths` already fixes every one of these names, and the run
 *   already writes them. Exactness is therefore byte-for-byte rather than a
 *   claim a serializer has to keep making.
 *
 * So a download is a **read of one named document under the run's own
 * directory**, and this module is the closed list of which documents a client
 * may name.
 *
 * ## A name, never a path
 *
 * `filename` is a file *name* the way `resultSourceSchema.document` is one: the
 * directory is resolved from configuration inside the process and never travels
 * (ADR 0023 §5). A request carries `artifact`, which is an enum member; the
 * server maps it onto `experimentPaths`, and the server's own test requires
 * every member of this list to be a field of that record — so a name that
 * drifts from the layout the simulator writes is a failing test rather than a
 * missing download.
 *
 * ## What is deliberately not downloadable
 *
 * `matches.jsonl` and its header, `replays/`, `checkpoints/` and `environments/`
 * are absent. The first is an unbounded append-only stream — a run of ten
 * thousand matches is a file no browser should be handed through a JSON envelope
 * — and the last three are directories, which would need a listing endpoint and
 * therefore a second way to name something inside a run. Both belong with the
 * Match Explorer that needs them, in a shape that can stream. Their absence is
 * recorded rather than silent: nothing here pretends the raw records are gone.
 */

/** Which of the three text formats a document is, so a client can label it honestly. */
export const ARTIFACT_FORMATS = ['json', 'csv', 'markdown'] as const;
export const artifactFormatSchema = z.enum(ARTIFACT_FORMATS);
export type ArtifactFormat = z.infer<typeof artifactFormatSchema>;

export const RESULT_ARTIFACT_NAMES = [
  'manifest',
  'config',
  'summary',
  'report',
  'decks',
  'resolved_environment',
  'reference_population',
  'matchup_matrix',
  'matchup_matrix_csv',
  'card_usage',
  'card_pairs',
  'cluster_inclusion',
  'errors',
] as const;
export const resultArtifactNameSchema = z.enum(RESULT_ARTIFACT_NAMES);
export type ResultArtifactName = z.infer<typeof resultArtifactNameSchema>;

export interface ResultArtifactDefinition {
  readonly name: ResultArtifactName;
  /** The file the run wrote, by name. Never a location. */
  readonly filename: string;
  readonly format: ArtifactFormat;
  /** What a download control calls it. */
  readonly label: string;
  /** What is in it, so an operator can tell two JSON documents apart. */
  readonly summary: string;
}

const define = (definition: ResultArtifactDefinition): ResultArtifactDefinition => definition;

/**
 * Every downloadable document, with the wording a control uses beside it.
 *
 * The wording lives here rather than in the client for the reason
 * `PRESET_REGISTRY`'s limitations do: a sentence authored at the point of
 * display is a sentence that can be forgotten at the point of display, and both
 * ends of this contract need to agree about what `decks.json` is before one of
 * them offers it.
 */
export const RESULT_ARTIFACTS: Readonly<Record<ResultArtifactName, ResultArtifactDefinition>> =
  Object.freeze({
    manifest: define({
      name: 'manifest',
      filename: 'manifest.json',
      format: 'json',
      label: 'Manifest',
      summary:
        'What the run was: its identity, its seed, the content addresses of every environment ' +
        'it played in, and the counts it finished with.',
    }),
    config: define({
      name: 'config',
      filename: 'config.json',
      format: 'json',
      label: 'Configuration',
      summary: 'The exact validated configuration this run was started from.',
    }),
    summary: define({
      name: 'summary',
      filename: 'summary.json',
      format: 'json',
      label: 'Summary',
      summary: 'Every aggregate the run computed, in the simulator’s own schema.',
    }),
    report: define({
      name: 'report',
      filename: 'report.md',
      format: 'markdown',
      label: 'Report',
      summary: 'The run’s own written report, as the simulator wrote it.',
    }),
    decks: define({
      name: 'decks',
      filename: 'decks.json',
      format: 'json',
      label: 'Decks',
      summary: 'Every deck that played, with the content address each is named by.',
    }),
    resolved_environment: define({
      name: 'resolved_environment',
      filename: 'resolved-environment.json',
      format: 'json',
      label: 'Resolved environment',
      summary: 'The primary environment frozen in full: the content these numbers are about.',
    }),
    reference_population: define({
      name: 'reference_population',
      filename: 'reference-population.json',
      format: 'json',
      label: 'Reference population',
      summary:
        'The frozen population a comparison replayed in both environments. Absent from a run ' +
        'that did not use one.',
    }),
    matchup_matrix: define({
      name: 'matchup_matrix',
      filename: 'matchup-matrix.json',
      format: 'json',
      label: 'Matchup matrix',
      summary: 'The ordered matchup matrix, when the run asked for one.',
    }),
    matchup_matrix_csv: define({
      name: 'matchup_matrix_csv',
      filename: 'matchup-matrix.csv',
      format: 'csv',
      label: 'Matchup matrix (CSV)',
      summary: 'The same matrix as a spreadsheet.',
    }),
    card_usage: define({
      name: 'card_usage',
      filename: 'card-usage.csv',
      format: 'csv',
      label: 'Card usage',
      summary: 'Per-card inclusion, draw and play readings.',
    }),
    card_pairs: define({
      name: 'card_pairs',
      filename: 'card-pairs.csv',
      format: 'csv',
      label: 'Card pairs',
      summary: 'Cards that appeared together, and how those decks did.',
    }),
    cluster_inclusion: define({
      name: 'cluster_inclusion',
      filename: 'cluster-inclusion.csv',
      format: 'csv',
      label: 'Cluster inclusion',
      summary: 'Inclusion by card cluster rather than by card.',
    }),
    errors: define({
      name: 'errors',
      filename: 'errors.csv',
      format: 'csv',
      label: 'Errors',
      summary: 'Every match the run could not complete, and why.',
    }),
  });

/**
 * The media type one format is served as.
 *
 * `text/markdown` rather than `text/plain` because the run writes Markdown and
 * saying so is what makes a saved file open in the right thing; `text/csv` for
 * the same reason. All three are text, which is why an artifact travels as a
 * string rather than as base64 — none of these documents is binary, and a
 * transport that could carry bytes would be a transport that could carry a
 * replay nobody asked for.
 */
export const ARTIFACT_MEDIA_TYPES: Readonly<Record<ArtifactFormat, string>> = Object.freeze({
  json: 'application/json',
  csv: 'text/csv',
  markdown: 'text/markdown',
});

/**
 * The largest document this service will put in one answer.
 *
 * A bound rather than a stream, and a **refusal** rather than a truncation. A
 * matchup matrix over two thousand searched decks is four million cells; a
 * partial CSV of it would be an artifact somebody could quote, and there is no
 * honest way to mark a spreadsheet as incomplete once it has been saved to a
 * disk. So an oversized document is named, its size is reported, and the run's
 * own copy stays where it is.
 */
export const MAX_ARTIFACT_BYTES = 4_194_304;

/**
 * One artifact, with the provenance that says which run it came out of.
 *
 * The identity travels **with the file** rather than only beside it on a screen.
 * A download is the one thing on this surface that leaves the browser, and a
 * `card-usage.csv` in somebody's downloads folder with no record of which run,
 * which seed and which content produced it is the second copy of evidence this
 * milestone keeps refusing. A client that saves the file names it after the run,
 * which is what `suggestedFilename` is for.
 */
export const resultArtifactSchema = z
  .strictObject({
    jobId: jobIdSchema,
    artifact: resultArtifactNameSchema,
    /** The name the run wrote it under. */
    filename: z.string().min(1).max(64),
    /** The name a client should save it as: the run's identity, then the file. */
    suggestedFilename: z.string().min(1).max(160),
    format: artifactFormatSchema,
    mediaType: z.string().min(1).max(64),
    byteLength: z.number().int().min(0).max(MAX_ARTIFACT_BYTES),
    content: z.string().max(MAX_ARTIFACT_BYTES),
    identity: runIdentitySchema,
    /** When this service read it, so a saved copy is dated by the read rather than the run. */
    readAt: timestampSchema,
  })
  .refine(
    (value) => value.mediaType === ARTIFACT_MEDIA_TYPES[value.format],
    'An artifact is served as the media type its format names.',
  )
  .refine(
    (value) => value.filename === RESULT_ARTIFACTS[value.artifact].filename,
    'An artifact carries the file name its definition fixes.',
  );
export type ResultArtifact = z.infer<typeof resultArtifactSchema>;

/**
 * What one run actually has, so a screen offers thirteen controls or fewer.
 *
 * A listing of its own rather than a field on `resultSummarySchema`, and the
 * reason is the case this tranche exists to handle honestly: a summary is
 * **refused** when it is corrupt, absent, or written by a build whose
 * calibration standing did not exist yet, and folding availability into it would
 * make an unreadable summary hide the raw evidence as well. The raw records are
 * exactly what a person needs when the reading fails, so they are reachable by a
 * route that does not go through the reading.
 *
 * `present: false` rows travel rather than being filtered out, for the reason a
 * refused precon does in `contentCatalogSchema`: a reader who cannot tell *this
 * run wrote no matchup matrix* from *this build forgot to offer it* has been
 * told nothing.
 */
export const resultArtifactListingSchema = z.strictObject({
  jobId: jobIdSchema,
  identity: runIdentitySchema,
  artifacts: z
    .array(
      z.strictObject({
        artifact: resultArtifactNameSchema,
        format: artifactFormatSchema,
        present: z.boolean(),
        /** The size on disk, or `null` when the run wrote no such document. */
        byteLength: z.number().int().min(0).nullable(),
        /** True when it exists and is larger than this service will send. */
        tooLarge: z.boolean(),
      }),
    )
    .length(RESULT_ARTIFACT_NAMES.length),
  readAt: timestampSchema,
});
export type ResultArtifactListing = z.infer<typeof resultArtifactListingSchema>;

/**
 * The name a saved copy carries: the experiment, the job, then the file.
 *
 * Built here so both ends spell it the same way, and built out of identifiers
 * only — an experiment slug and a job ID are both restricted alphabets with no
 * separator in them, so the result cannot become a path however it is used.
 */
export function suggestedArtifactFilename(
  experimentId: string,
  jobId: string,
  artifact: ResultArtifactName,
): string {
  return `${experimentId}-${jobId}-${RESULT_ARTIFACTS[artifact].filename}`;
}
