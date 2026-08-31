import { useCallback, useEffect, useState } from 'react';

import {
  EXPERIMENT_KINDS,
  EXPERIMENT_PURPOSES,
  JOB_STATUSES,
  PAGE_SIZE_DEFAULT,
  SOURCE_CLASSES,
  type Annotations,
  type CatalogJobView,
  type ExperimentKind,
  type ExperimentPurpose,
  type JobId,
  type JobStatus,
  type ResultArtifactListing,
  type ResultArtifactName,
  type ResultSummary,
  type SourceClass,
} from '@tcg/admin-contracts';

import { downloadArtifact } from '../lib/download.js';
import {
  EMPTY_RESULTS_FILTER,
  resultsFilterIsEmpty,
  toCatalogFilterInput,
  toggled,
  type ResultsFilterState,
} from '../lib/results-view.js';
import { JOB_STATUS_WORDING } from '../lib/queue-view.js';
import { EXPERIMENT_KIND_LABELS, SOURCE_CLASS_LABELS } from '../lib/vocabulary.js';
import { useAdminSession, useAdminState } from '../state/AdminContext.js';
import type { AdminFailure } from '../net/transport.js';
import { Busy, Empty, Failure } from './Feedback.js';
import { FactTable, type Fact } from './FactTable.js';

/**
 * The result catalog: every job this catalog has ever created, completed or
 * not, browsable by what it is rather than only by what queue it sat in.
 *
 * ## Filtering asks the catalog, not the browser
 *
 * `catalogFilterSchema` is the whole selection rule, and this screen offers a
 * control for every field it names — status, purpose, source, kind, baseline, a
 * precon, a Commander, a content hash and a created-date range. Applying a
 * filter is a deliberate act, matching the rest of this application's habit of
 * not re-asking on every keystroke: an operator ticks boxes, then asks.
 *
 * ## A detail view is three independent readings, because they fail independently
 *
 * Selecting a row does not open "the result" as one object. It opens **three**:
 * the job itself (already in hand from the listing), `resultSummary` (which is
 * refused rather than served when a run has no calibration standing, a corrupt
 * summary, or nothing written yet), and `resultArtifacts` (which lists every
 * canonical document by name, present or not, so an operator can still recover
 * raw evidence a summary refused to interpret). Each renders its own failure —
 * the `Failure` component prints exactly what the service said, so an
 * unsupported schema and a missing calibration standing read as the two
 * different facts they are rather than one grey "no data".
 *
 * ## A download is the run's own bytes, never a rendering of them
 *
 * `resultArtifact` returns the exact document the run wrote; this screen's only
 * job is to hand it to the browser under the run's own suggested name.
 *
 * ## Notes, tags and baseline are annotations, never a rewrite of the run
 *
 * `setJobAnnotations` is the only mutation this screen makes, and it can express
 * nothing else — there is no field here that reaches into an experiment
 * directory, which is what makes "mark as baseline never mutates canonical
 * output" a fact about the request shape rather than a promise about this code.
 */
export function ResultsScreen() {
  const session = useAdminSession();
  const state = useAdminState();
  const content = state.content.status === 'ready' ? state.content.value : null;

  const [filter, setFilter] = useState<ResultsFilterState>(EMPTY_RESULTS_FILTER);
  const [applied, setApplied] = useState<ResultsFilterState>(EMPTY_RESULTS_FILTER);
  const [items, setItems] = useState<readonly CatalogJobView[] | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [listFailure, setListFailure] = useState<AdminFailure | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selected, setSelected] = useState<JobId | null>(null);

  const search = useCallback(
    async (next: ResultsFilterState): Promise<void> => {
      setApplied(next);
      setItems(null);
      setListFailure(null);
      const answer = await session.listJobs(toCatalogFilterInput(next), {
        limit: PAGE_SIZE_DEFAULT,
        cursor: null,
      });
      if (!answer.ok) {
        setListFailure(answer.failure);
        return;
      }
      setItems(answer.value.items);
      setTotal(answer.value.page.total);
      setCursor(answer.value.page.nextCursor);
    },
    [session],
  );

  useEffect(() => {
    void search(EMPTY_RESULTS_FILTER);
    // Only on mount: every later listing is the result of "Show results" or
    // "Show more", both explicit acts, so the catalog is not re-asked for every
    // checkbox a person ticks before they are done choosing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadMore = useCallback(async (): Promise<void> => {
    if (cursor === null) return;
    setLoadingMore(true);
    const answer = await session.listJobs(toCatalogFilterInput(applied), {
      limit: PAGE_SIZE_DEFAULT,
      cursor,
    });
    setLoadingMore(false);
    if (!answer.ok) {
      setListFailure(answer.failure);
      return;
    }
    setItems((held) => [...(held ?? []), ...answer.value.items]);
    setCursor(answer.value.page.nextCursor);
  }, [session, applied, cursor]);

  return (
    <div className="results">
      <FilterPanel
        content={content}
        filter={filter}
        onChange={setFilter}
        onApply={() => void search(filter)}
        onClear={() => {
          setFilter(EMPTY_RESULTS_FILTER);
          void search(EMPTY_RESULTS_FILTER);
        }}
      />

      <section className="panel" aria-labelledby="results-list">
        <h2 id="results-list">
          {resultsFilterIsEmpty(applied) ? 'Every job in this catalog' : 'Matching jobs'}
        </h2>
        {total !== null && (
          <p className="panel__note">
            {total} {total === 1 ? 'job matches' : 'jobs match'} this filter.
          </p>
        )}

        {listFailure !== null && (
          <Failure
            title="This listing could not be read"
            failure={listFailure}
            onRetry={() => void search(applied)}
          />
        )}
        {items === null && listFailure === null && <Busy label="Asking the catalog…" />}
        {items !== null && items.length === 0 && (
          <Empty>No job in this catalog matches this filter.</Empty>
        )}
        {items !== null && items.length > 0 && (
          <ul className="results__rows">
            {items.map((job) => (
              <li key={job.jobId}>
                <button
                  type="button"
                  className={job.jobId === selected ? 'is-current' : ''}
                  aria-current={job.jobId === selected ? 'true' : undefined}
                  onClick={() => {
                    setSelected(job.jobId);
                  }}
                >
                  <span className="results__row-label">{job.label}</span>
                  <span className="queue__badge" data-status={job.status}>
                    {JOB_STATUS_WORDING[job.status].label}
                  </span>
                  <span className="results__row-note">
                    {EXPERIMENT_KIND_LABELS[job.spec.kind]} ·{' '}
                    {SOURCE_CLASS_LABELS[job.sourceClasses[0] ?? 'ai']}
                    {job.sourceClasses.length > 1
                      ? ` +${String(job.sourceClasses.length - 1)}`
                      : ''}{' '}
                    · created {job.timestamps.createdAt}
                    {job.annotations.baseline ? ' · baseline' : ''}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {cursor !== null && (
          <p className="builder__actions">
            <button type="button" onClick={() => void loadMore()} disabled={loadingMore}>
              {loadingMore ? 'Reading more…' : 'Show more'}
            </button>
          </p>
        )}
      </section>

      {selected !== null && (
        <ResultDetail
          key={selected}
          job={items?.find((job) => job.jobId === selected) ?? null}
          jobId={selected}
          onAnnotated={(updated) => {
            setItems(
              (held) => held?.map((job) => (job.jobId === updated.jobId ? updated : job)) ?? held,
            );
          }}
        />
      )}
    </div>
  );
}

/* -------------------------------------------------------------------- filter */

interface FilterPanelProps {
  readonly content: {
    readonly precons: readonly { preconId: string; name: string; commanderId: string }[];
  } | null;
  readonly filter: ResultsFilterState;
  readonly onChange: (next: ResultsFilterState) => void;
  readonly onApply: () => void;
  readonly onClear: () => void;
}

function FilterPanel({ content, filter, onChange, onApply, onClear }: FilterPanelProps) {
  const commanders = content
    ? [...new Map(content.precons.map((precon) => [precon.commanderId, precon.commanderId])).keys()]
    : [];

  return (
    <section className="panel" aria-labelledby="results-filter">
      <h2 id="results-filter">Filter</h2>
      <p className="panel__note">
        Every field below narrows the listing below it; choosing more than one value in a field
        matches any of them. Nothing here changes until you ask.
      </p>

      <div className="results__filter-grid">
        <fieldset>
          <legend>Status</legend>
          {JOB_STATUSES.map((status: JobStatus) => (
            <label key={status} className="results__check">
              <input
                type="checkbox"
                checked={filter.status.includes(status)}
                onChange={() => {
                  onChange({ ...filter, status: toggled(filter.status, status) });
                }}
              />
              {JOB_STATUS_WORDING[status].label}
            </label>
          ))}
        </fieldset>

        <fieldset>
          <legend>Exploration or validation</legend>
          <label className="results__check">
            <input
              type="radio"
              name="results-purpose"
              checked={filter.purpose === null}
              onChange={() => {
                onChange({ ...filter, purpose: null });
              }}
            />
            Either
          </label>
          {EXPERIMENT_PURPOSES.map((purpose: ExperimentPurpose) => (
            <label key={purpose} className="results__check">
              <input
                type="radio"
                name="results-purpose"
                checked={filter.purpose === purpose}
                onChange={() => {
                  onChange({ ...filter, purpose });
                }}
              />
              {purpose === 'exploration' ? 'Exploration' : 'Validation'}
            </label>
          ))}
        </fieldset>

        <fieldset>
          <legend>Source</legend>
          {SOURCE_CLASSES.map((source: SourceClass) => (
            <label key={source} className="results__check">
              <input
                type="checkbox"
                checked={filter.sourceClasses.includes(source)}
                onChange={() => {
                  onChange({ ...filter, sourceClasses: toggled(filter.sourceClasses, source) });
                }}
              />
              {SOURCE_CLASS_LABELS[source]}
            </label>
          ))}
        </fieldset>

        <fieldset>
          <legend>Type</legend>
          {EXPERIMENT_KINDS.map((kind: ExperimentKind) => (
            <label key={kind} className="results__check">
              <input
                type="checkbox"
                checked={filter.kinds.includes(kind)}
                onChange={() => {
                  onChange({ ...filter, kinds: toggled(filter.kinds, kind) });
                }}
              />
              {EXPERIMENT_KIND_LABELS[kind]}
            </label>
          ))}
        </fieldset>

        <fieldset>
          <legend>Baseline</legend>
          <label className="results__check">
            <input
              type="radio"
              name="results-baseline"
              checked={filter.baseline === null}
              onChange={() => {
                onChange({ ...filter, baseline: null });
              }}
            />
            Either
          </label>
          <label className="results__check">
            <input
              type="radio"
              name="results-baseline"
              checked={filter.baseline === true}
              onChange={() => {
                onChange({ ...filter, baseline: true });
              }}
            />
            Baseline only
          </label>
          <label className="results__check">
            <input
              type="radio"
              name="results-baseline"
              checked={filter.baseline === false}
              onChange={() => {
                onChange({ ...filter, baseline: false });
              }}
            />
            Not a baseline
          </label>
        </fieldset>

        {content !== null && content.precons.length > 0 && (
          <fieldset>
            <legend>Precon</legend>
            {content.precons.map((precon) => (
              <label key={precon.preconId} className="results__check">
                <input
                  type="checkbox"
                  checked={filter.preconIds.includes(precon.preconId)}
                  onChange={() => {
                    onChange({ ...filter, preconIds: toggled(filter.preconIds, precon.preconId) });
                  }}
                />
                {precon.name}
              </label>
            ))}
          </fieldset>
        )}

        {commanders.length > 0 && (
          <fieldset>
            <legend>Commander</legend>
            {commanders.map((commanderId) => (
              <label key={commanderId} className="results__check">
                <input
                  type="checkbox"
                  checked={filter.commanderIds.includes(commanderId)}
                  onChange={() => {
                    onChange({
                      ...filter,
                      commanderIds: toggled(filter.commanderIds, commanderId),
                    });
                  }}
                />
                <code>{commanderId}</code>
              </label>
            ))}
          </fieldset>
        )}

        <fieldset>
          <legend>Created</legend>
          <label className="builder__field">
            After
            <input
              type="date"
              value={filter.createdAfter}
              onChange={(event) => {
                onChange({ ...filter, createdAfter: event.target.value });
              }}
            />
          </label>
          <label className="builder__field">
            Before
            <input
              type="date"
              value={filter.createdBefore}
              onChange={(event) => {
                onChange({ ...filter, createdBefore: event.target.value });
              }}
            />
          </label>
        </fieldset>

        <fieldset>
          <legend>Content hash</legend>
          <label className="builder__field">
            Exact content address
            <input
              type="text"
              value={filter.fullContentHash}
              placeholder="pasted from a result's own provenance"
              onChange={(event) => {
                onChange({ ...filter, fullContentHash: event.target.value });
              }}
            />
          </label>
        </fieldset>
      </div>

      <p className="builder__actions">
        <button type="button" onClick={onApply}>
          Show results
        </button>{' '}
        <button
          type="button"
          onClick={() => {
            onClear();
          }}
        >
          Clear filters
        </button>
      </p>
    </section>
  );
}

/* -------------------------------------------------------------------- detail */

interface ResultDetailProps {
  readonly jobId: JobId;
  /** The row from the listing, when it is still on screen. */
  readonly job: CatalogJobView | null;
  readonly onAnnotated: (job: CatalogJobView) => void;
}

function ResultDetail({ jobId, job, onAnnotated }: ResultDetailProps) {
  const session = useAdminSession();
  const [summary, setSummary] = useState<
    | { readonly ok: true; readonly value: ResultSummary }
    | { readonly ok: false; readonly failure: AdminFailure }
    | null
  >(null);
  const [artifacts, setArtifacts] = useState<
    | { readonly ok: true; readonly value: ResultArtifactListing }
    | { readonly ok: false; readonly failure: AdminFailure }
    | null
  >(null);
  const [downloadFailure, setDownloadFailure] = useState<AdminFailure | null>(null);

  useEffect(() => {
    let live = true;
    void session.resultSummary(jobId).then((answer) => {
      if (live) setSummary(answer);
    });
    void session.resultArtifacts(jobId).then((answer) => {
      if (live) setArtifacts(answer);
    });
    return () => {
      live = false;
    };
  }, [session, jobId]);

  const download = useCallback(
    async (artifact: ResultArtifactName) => {
      const answer = await session.resultArtifact(jobId, artifact);
      if (!answer.ok) {
        setDownloadFailure(answer.failure);
        return;
      }
      setDownloadFailure(null);
      downloadArtifact(
        answer.value.suggestedFilename,
        answer.value.mediaType,
        answer.value.content,
      );
    },
    [session, jobId],
  );

  return (
    <section className="panel" aria-labelledby="results-detail">
      <h2 id="results-detail">{job?.label ?? jobId}</h2>

      {job !== null && <JobFacts job={job} />}

      <h3>Evidence</h3>
      {summary === null && <Busy label="Reading this run's summary…" />}
      {summary !== null && !summary.ok && (
        <Failure
          title="This run's summary could not be shown"
          failure={summary.failure}
          onRetry={() => {
            void session.resultSummary(jobId).then(setSummary);
          }}
        />
      )}
      {summary !== null && summary.ok && <SummaryFacts summary={summary.value} />}

      <h3>Downloads</h3>
      {downloadFailure !== null && (
        <Failure
          title="That document could not be downloaded"
          failure={downloadFailure}
          onRetry={() => {
            setDownloadFailure(null);
          }}
          retryLabel="Dismiss"
        />
      )}
      {artifacts === null && <Busy label="Reading which documents this run wrote…" />}
      {artifacts !== null && !artifacts.ok && (
        <Failure title="This run's documents could not be listed" failure={artifacts.failure} />
      )}
      {artifacts !== null && artifacts.ok && (
        <ul className="results__artifacts">
          {artifacts.value.artifacts.map((entry) => (
            <li key={entry.artifact}>
              {entry.present ? (
                entry.tooLarge ? (
                  <span>
                    <code>{entry.artifact}</code> — {entry.byteLength} bytes, too large to download
                    here.
                  </span>
                ) : (
                  <button type="button" onClick={() => void download(entry.artifact)}>
                    Download {entry.artifact} ({entry.format})
                  </button>
                )
              ) : (
                <span className="results__artifact-absent">
                  <code>{entry.artifact}</code> — this run wrote none.
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {job !== null && <AnnotationsForm job={job} onSaved={onAnnotated} />}
    </section>
  );
}

function JobFacts({ job }: { readonly job: CatalogJobView }) {
  const facts: Fact[] = [
    {
      label: 'Status',
      value: JOB_STATUS_WORDING[job.status].label,
      note: JOB_STATUS_WORDING[job.status].meaning,
    },
    { label: 'Purpose', value: job.purpose === 'exploration' ? 'Exploration' : 'Validation' },
    {
      label: 'Source',
      value: job.sourceClasses.map((source) => SOURCE_CLASS_LABELS[source]).join(', '),
    },
    { label: 'Type', value: EXPERIMENT_KIND_LABELS[job.spec.kind] },
    { label: 'Experiment', value: <code>{job.spec.experimentId}</code> },
    { label: 'Seed', value: <code>{job.spec.seed}</code> },
    { label: 'Configuration hash', value: <code>{job.spec.configHash}</code> },
    { label: 'Created', value: job.timestamps.createdAt },
    {
      label: 'Origin',
      value:
        job.origin.kind === 'preset'
          ? `Preset ${job.origin.presetId}, stage ${job.origin.stageId}`
          : 'A hand-assembled configuration',
    },
  ];
  return <FactTable caption="What this job is" facts={facts} />;
}

/**
 * Provenance, denominators and the evidence-claim standing — the milestone's own
 * result rules, rendered exactly rather than summarised.
 */
function SummaryFacts({ summary }: { readonly summary: ResultSummary }) {
  const facts: Fact[] = [
    { label: 'Experiment', value: <code>{summary.identity.experimentId}</code> },
    { label: 'Seed', value: <code>{summary.identity.seed}</code> },
    {
      label: 'Software commit',
      value:
        summary.identity.softwareCommit === null ? (
          'Not recorded'
        ) : (
          <code>{summary.identity.softwareCommit}</code>
        ),
    },
    {
      label: 'Environments',
      value: summary.identity.environments
        .map((environment) => environment.environmentId)
        .join(', '),
    },
    { label: 'Manifest schema version', value: summary.identity.manifestSchemaVersion },
    {
      label: 'Read from',
      value: `${summary.source.document} (schema ${String(summary.source.schemaVersion)})`,
    },
    { label: 'Matches played', value: summary.denominators.matches },
    { label: 'Matches usable', value: summary.denominators.usableMatches },
    { label: 'Matches abnormal', value: summary.denominators.abnormalMatches },
    { label: 'Matches failed', value: summary.denominators.failedMatches },
    { label: 'Matches resumed', value: summary.denominators.resumedMatches },
    {
      label: 'Evidence standing',
      value: summary.evidence.standing,
      note: summary.evidence.promotionRequires,
    },
  ];
  return (
    <>
      <FactTable caption="Provenance, completion quality and evidence standing" facts={facts} />
      {summary.evidence.reasons.length > 0 && (
        <ul className="results__limitations" role="note">
          {summary.evidence.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      )}
      {summary.limitations.length > 0 && (
        <>
          <h4>Limitations</h4>
          <ul className="results__limitations" role="note">
            {summary.limitations.map((limitation) => (
              <li key={limitation}>{limitation}</li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

/* --------------------------------------------------------------- annotations */

interface AnnotationsFormProps {
  readonly job: CatalogJobView;
  readonly onSaved: (job: CatalogJobView) => void;
}

/**
 * Notes, tags and a baseline mark — stored beside the run, never inside it.
 *
 * `setJobAnnotationsRequestSchema` carries no field that reaches an experiment
 * directory, which is what makes that promise a fact about the wire rather than
 * a habit of this form.
 */
function AnnotationsForm({ job, onSaved }: AnnotationsFormProps) {
  const session = useAdminSession();
  const [tags, setTags] = useState(job.annotations.tags.join(', '));
  const [note, setNote] = useState(job.annotations.note);
  const [baseline, setBaseline] = useState(job.annotations.baseline);
  const [failure, setFailure] = useState<AdminFailure | null>(null);
  const [saving, setSaving] = useState(false);

  const save = useCallback(async () => {
    setSaving(true);
    const annotations: Annotations = {
      tags: tags
        .split(',')
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0),
      note,
      baseline,
    };
    const answer = await session.setJobAnnotations(job.jobId, annotations);
    setSaving(false);
    if (!answer.ok) {
      setFailure(answer.failure);
      return;
    }
    setFailure(null);
    onSaved(answer.value);
  }, [session, job.jobId, tags, note, baseline, onSaved]);

  return (
    <>
      <h3>Notes, tags and baseline</h3>
      <p className="panel__note">
        Kept beside this run in the catalog. Marking a baseline never changes the run's own
        canonical output — there is no request this form can send that reaches it.
      </p>
      {failure !== null && (
        <Failure title="This could not be saved" failure={failure} onRetry={() => void save()} />
      )}
      <label className="builder__field">
        Tags, separated by commas
        <input
          type="text"
          value={tags}
          onChange={(event) => {
            setTags(event.target.value);
          }}
        />
      </label>
      <label className="builder__field">
        Note
        <textarea
          value={note}
          onChange={(event) => {
            setNote(event.target.value);
          }}
        />
      </label>
      <label className="results__check">
        <input
          type="checkbox"
          checked={baseline}
          onChange={(event) => {
            setBaseline(event.target.checked);
          }}
        />
        Mark as baseline
      </label>
      <p className="builder__actions">
        <button type="button" onClick={() => void save()} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </p>
    </>
  );
}
