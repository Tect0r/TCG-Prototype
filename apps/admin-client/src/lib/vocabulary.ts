import {
  EXPERIMENT_KINDS,
  PRESET_STATUSES,
  PRESET_TEST_STYLES,
  SOURCE_CLASSES,
  type ExperimentKind,
  type JobSpec,
  type PresetStatus,
  type PresetTestStyle,
  type SourceClass,
} from '@tcg/admin-contracts';

/**
 * How this screen prints the contract's closed vocabularies.
 *
 * A map per enumeration rather than a switch at each call site, and **total** by
 * type: a member added to `SOURCE_CLASSES` or `EXPERIMENT_KINDS` is a compile
 * error here rather than a raw token like `adaptive` appearing in a table.
 * `vocabulary.test.ts` walks each enumeration and requires a label for every
 * member, so the compiler's guarantee survives a `Record` somebody loosens.
 *
 * Nothing here decides anything. The presets carry their own `label`, `summary`
 * and `limitations` in `PRESET_REGISTRY`, and this module never writes a second
 * version of one — a limitation authored at the point of display is a limitation
 * that can be forgotten at the point of display. What is here is only the
 * wording for enumeration members the registry spells in code, which have no
 * authored label of their own.
 */

/** The six evidence classes M08 keeps distinguishable, in words. */
export const SOURCE_CLASS_LABELS: Readonly<Record<SourceClass, string>> = Object.freeze({
  ai: 'AI',
  human: 'Human',
  mixed: 'Mixed',
  precon: 'Precon',
  search: 'Search',
  adaptive: 'Adaptive',
});

/** The simulator's five experiment kinds, in words. */
export const EXPERIMENT_KIND_LABELS: Readonly<Record<ExperimentKind, string>> = Object.freeze({
  batch: 'Batch',
  search: 'Search',
  comparison: 'Comparison',
  replacement: 'Replacement',
  robustness: 'Robustness',
});

/**
 * Every `JobSpec.kind` a catalog job document can carry (M08.R3): the five
 * experiment kinds above, plus `adaptive_counter` — the one `jobSpecSchema`
 * branch that is not an `ExperimentKind` at all, deliberately, since Adaptive
 * Counter Search is not a sixth ordinary experiment kind (`catalog.ts`'s own
 * header on the discriminated union says why).
 *
 * Kept separate from `EXPERIMENT_KIND_LABELS` rather than folding
 * `adaptive_counter` into it: that record is `Record<ExperimentKind, string>`
 * and stays exactly total over the five real experiment kinds, which is what
 * lets it keep labelling the *filter* checkboxes above — `CatalogFilter.kinds`
 * is still `ExperimentKind[]`, unwidened, because a queued job's run identity
 * is what that filter reads and an adaptive run has none. A job's *own*
 * `spec.kind`, read off the document itself, is the wider domain this record
 * is total over instead.
 */
export const JOB_SPEC_KINDS = [...EXPERIMENT_KINDS, 'adaptive_counter'] as const;
export const JOB_SPEC_KIND_LABELS: Readonly<Record<JobSpec['kind'], string>> = Object.freeze({
  ...EXPERIMENT_KIND_LABELS,
  adaptive_counter: 'Adaptive Counter Search',
});

/** The four primary test styles and the three advanced templates, in words. */
export const TEST_STYLE_LABELS: Readonly<Record<PresetTestStyle, string>> = Object.freeze({
  precon_benchmark: 'Precon Benchmark',
  open_meta_search: 'Open Meta Search',
  commander_search: 'Commander Search',
  adaptive_counter_search: 'Adaptive Counter Search',
  candidate_patch_comparison: 'Candidate Patch Comparison',
  pilot_robustness: 'Pilot Robustness',
  engine_soak: 'Engine Soak',
  card_replacement: 'Card Replacement',
});

/**
 * Whether a preset can be started, in words a person can act on.
 *
 * `reserved` says *this build cannot* rather than *not yet*, because the second
 * is a promise about a future build that this one is in no position to make.
 */
export const PRESET_STATUS_LABELS: Readonly<Record<PresetStatus, string>> = Object.freeze({
  available: 'Available',
  reserved: 'Reserved — this build cannot schedule one',
});

/** Every enumeration this module claims to be total over, for its own test. */
export const LABELLED_VOCABULARIES = Object.freeze({
  sourceClass: { members: SOURCE_CLASSES, labels: SOURCE_CLASS_LABELS },
  experimentKind: { members: EXPERIMENT_KINDS, labels: EXPERIMENT_KIND_LABELS },
  jobSpecKind: { members: JOB_SPEC_KINDS, labels: JOB_SPEC_KIND_LABELS },
  testStyle: { members: PRESET_TEST_STYLES, labels: TEST_STYLE_LABELS },
  presetStatus: { members: PRESET_STATUSES, labels: PRESET_STATUS_LABELS },
});

/**
 * A list of labels, or the em dash that means "none".
 *
 * A reserved preset carries no kinds and a client that printed an empty cell
 * would leave a reader unable to tell "nothing" from "not loaded". The em dash
 * is this repository's existing answer to that question in a table.
 */
export function labelledList<T extends string>(
  members: readonly T[],
  labels: Readonly<Record<T, string>>,
): string {
  if (members.length === 0) return '—';
  return members.map((member) => labels[member]).join(', ');
}

/**
 * A byte count, in the units an operator reads a request limit in.
 *
 * Binary units, because the limit it prints is a buffer size rather than a
 * marketing figure, and the exact number is kept in parentheses: a limit is a
 * thing somebody has to compare a payload against, and `128 KiB` alone is not
 * comparable.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} bytes`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${trimNumber(kib)} KiB (${String(bytes)} bytes)`;
  return `${trimNumber(kib / 1024)} MiB (${String(bytes)} bytes)`;
}

/** A millisecond window, in seconds when it divides evenly. */
export function formatWindow(milliseconds: number): string {
  if (milliseconds % 1000 === 0) {
    const seconds = milliseconds / 1000;
    return `${String(seconds)} second${seconds === 1 ? '' : 's'}`;
  }
  return `${String(milliseconds)} ms`;
}

/**
 * How long the process has been up, from two timestamps this build was given.
 *
 * Computed from the reading's own `checkedAt` rather than from `Date.now()`, so
 * the figure a screen prints is a fact about the answer it is printing rather
 * than about how long the tab has been open since.
 */
export function formatUptime(startedAt: string, checkedAt: string): string {
  const started = Date.parse(startedAt);
  const checked = Date.parse(checkedAt);
  if (Number.isNaN(started) || Number.isNaN(checked) || checked < started) return 'unknown';
  const seconds = Math.floor((checked - started) / 1000);
  if (seconds < 60) return `${String(seconds)} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)} hour${hours === 1 ? '' : 's'}`;
  const days = Math.floor(hours / 24);
  return `${String(days)} day${days === 1 ? '' : 's'}`;
}

function trimNumber(value: number): string {
  return (Math.round(value * 10) / 10).toString();
}
