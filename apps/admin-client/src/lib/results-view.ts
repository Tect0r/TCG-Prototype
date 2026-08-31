import {
  type CatalogFilterInput,
  type ExperimentKind,
  type ExperimentPurpose,
  type JobStatus,
  type SourceClass,
} from '@tcg/admin-contracts';

/**
 * The Results screen's own filter state, and the one conversion it owns: what a
 * person typed into what the catalog's `listJobs` actually reads.
 *
 * Kept as a pure module rather than component state alone, for the reason
 * `queue-view.ts` gives about wording: a conversion tested here is a conversion
 * a component cannot get subtly wrong under a future edit, and the milestone's
 * own acceptance list names *filter* as something a test has to cover.
 *
 * ## Why dates are strings here and instants on the wire
 *
 * `catalogFilterSchema.createdAfter`/`createdBefore` are `timestampSchema` — a
 * full ISO instant with a time and a zone — because that is what a job's own
 * `timestamps.createdAt` is stamped with. An HTML `<input type="date">` answers
 * `YYYY-MM-DD`, a calendar day with no time at all. `toCatalogFilterInput` is the
 * one place that turns a day into an inclusive range: the start of that day in
 * UTC through its last millisecond, so an operator filtering "created on the
 * 24th" sees every run stamped that day rather than being surprised by a
 * timezone this screen never asked about.
 *
 * ## Why a precon or a Commander is chosen from a list, and a content hash is typed
 *
 * The content catalog publishes precons and Commanders, so a filter for either
 * is a selection over a list the connection already has — the same source
 * `BuilderScreen` reads its own controls from. A content hash is not published
 * anywhere a screen can list it; it is copied out of a result an operator is
 * already looking at, so the control for it is a text field rather than a menu
 * with nothing to populate it.
 */
export interface ResultsFilterState {
  readonly status: readonly JobStatus[];
  readonly purpose: ExperimentPurpose | null;
  readonly sourceClasses: readonly SourceClass[];
  readonly kinds: readonly ExperimentKind[];
  readonly baseline: boolean | null;
  readonly preconIds: readonly string[];
  readonly commanderIds: readonly string[];
  /** Pasted from a result's own provenance. Empty means unset. */
  readonly fullContentHash: string;
  /** `YYYY-MM-DD` from a date input, or `''` for unset. */
  readonly createdAfter: string;
  readonly createdBefore: string;
}

export const EMPTY_RESULTS_FILTER: ResultsFilterState = Object.freeze({
  status: [],
  purpose: null,
  sourceClasses: [],
  kinds: [],
  baseline: null,
  preconIds: [],
  commanderIds: [],
  fullContentHash: '',
  createdAfter: '',
  createdBefore: '',
});

/** Whether the filter narrows anything at all, so a screen can say "showing everything". */
export function resultsFilterIsEmpty(state: ResultsFilterState): boolean {
  return (
    state.status.length === 0 &&
    state.purpose === null &&
    state.sourceClasses.length === 0 &&
    state.kinds.length === 0 &&
    state.baseline === null &&
    state.preconIds.length === 0 &&
    state.commanderIds.length === 0 &&
    state.fullContentHash.trim() === '' &&
    state.createdAfter === '' &&
    state.createdBefore === ''
  );
}

export function toCatalogFilterInput(state: ResultsFilterState): CatalogFilterInput {
  const hash = state.fullContentHash.trim();
  return {
    status: [...state.status],
    purpose: state.purpose,
    sourceClasses: [...state.sourceClasses],
    kinds: [...state.kinds],
    baseline: state.baseline,
    preconIds: [...state.preconIds],
    commanderIds: [...state.commanderIds],
    fullContentHash: hash === '' ? null : hash,
    createdAfter: state.createdAfter === '' ? null : `${state.createdAfter}T00:00:00.000Z`,
    createdBefore: state.createdBefore === '' ? null : `${state.createdBefore}T23:59:59.999Z`,
  };
}

/** Toggles one member of a multi-select field, without repeating it. */
export function toggled<T>(current: readonly T[], value: T): readonly T[] {
  return current.includes(value) ? current.filter((entry) => entry !== value) : [...current, value];
}
