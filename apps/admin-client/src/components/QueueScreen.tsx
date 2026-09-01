import { useCallback, useEffect, useRef, useState } from 'react';

import {
  operatorActionsFor,
  type BatchDetail,
  type BatchId,
  type CatalogBatchView,
  type CatalogJobView,
  type JobId,
  type OperatorJobAction,
} from '@tcg/admin-contracts';

import { Busy, Empty, Failure } from './Feedback.js';
import {
  BATCH_STATUS_WORDING,
  JOB_ACTION_WORDING,
  JOB_STATUS_LEGEND,
  JOB_STATUS_WORDING,
  ORDER_IS_NOT_STATE,
  START_BATCH_CONFIRM,
  WITHDRAW_WORDING,
  formatDuration,
  matchProgressText,
  moveInOrder,
  remainingTime,
  stageText,
  type ActionWording,
} from '../lib/queue-view.js';
import { useAdminSession } from '../state/AdminContext.js';
import type { AdminFailure } from '../net/transport.js';

/**
 * The queue: what has been built, what order it is in, what is running, and the
 * four verbs an operator has over it.
 *
 * ## Two halves, and the batch's own state decides which one is on screen
 *
 * A **draft** is being assembled. Its jobs can be duplicated, withdrawn and
 * reordered, and none of them will run — the orchestrator's fill loop reads the
 * batch's state before it starts anything, so the hold is a property of the
 * process rather than a promise this screen makes. Starting the batch settles
 * the order and releases it, and that is the one control here with a
 * confirmation about consequences rather than about a mistake.
 *
 * Everything after that is **watching**. The controls become the lifecycle's own
 * four verbs, the ordering controls disappear because the store would refuse
 * them, and the rows start reporting progress read from each run's own canonical
 * directory.
 *
 * ## Reordering is buttons, and drag is not implemented at all
 *
 * The milestone asks for accessible controls *where drag is an enhancement and
 * never the only control*. Move-up and move-down buttons are that control: they
 * are in the tab order, they are announced, they work with a keyboard alone, and
 * they need no pointer. Adding drag on top would have been an enhancement and it
 * is deliberately not here — an interaction with no test that can prove it is
 * reachable is a liability, and the tranche's acceptance asks for **keyboard**
 * reordering.
 *
 * The whole order is sent on every move, never the move itself. A client that
 * said *swap rows two and three* would be describing a batch as it was when the
 * button was drawn; the server compares the order against the membership it
 * holds and refuses a set that has gained or lost a job, so a second screen that
 * duplicated something is a readable refusal rather than a silent overwrite.
 *
 * ## The poll is the screen's, and it exists only while something is running
 *
 * `AdminSession` deliberately holds no queue state and starts no timer. The
 * cadence belongs here because it depends on what is being shown: a draft
 * nobody has started polls nothing at all, and a batch with running work asks
 * `jobProgress` — the cheap endpoint, built for exactly this — for each job that
 * is still in flight. The poll never raises the shell's busy flag, because
 * nobody asked for it.
 */

/** How often a batch with work in flight re-reads its jobs. */
export const QUEUE_POLL_MS = 2_000;

interface QueueScreenProps {
  /** Injected in tests so a poll is a decision rather than a wait. */
  readonly pollMs?: number;
}

export function QueueScreen({ pollMs = QUEUE_POLL_MS }: QueueScreenProps) {
  const session = useAdminSession();

  const [batches, setBatches] = useState<readonly CatalogBatchView[] | null>(null);
  const [listFailure, setListFailure] = useState<AdminFailure | null>(null);
  const [selected, setSelected] = useState<BatchId | null>(null);
  const [detail, setDetail] = useState<BatchDetail | null>(null);
  const [detailFailure, setDetailFailure] = useState<AdminFailure | null>(null);
  const [actionFailure, setActionFailure] = useState<AdminFailure | null>(null);
  const [pending, setPending] = useState<Confirmation | null>(null);

  const loadBatches = useCallback(async (): Promise<void> => {
    const answer = await session.listBatches();
    if (!answer.ok) {
      setListFailure(answer.failure);
      return;
    }
    setListFailure(null);
    setBatches(answer.value.items);
    setSelected((current) => current ?? answer.value.items[0]?.batchId ?? null);
  }, [session]);

  const loadDetail = useCallback(
    async (batchId: BatchId): Promise<void> => {
      const answer = await session.batchDetail(batchId);
      if (!answer.ok) {
        setDetailFailure(answer.failure);
        setDetail(null);
        return;
      }
      setDetailFailure(null);
      setDetail(answer.value);
    },
    [session],
  );

  useEffect(() => {
    void loadBatches();
  }, [loadBatches]);

  useEffect(() => {
    if (selected === null) return;
    void loadDetail(selected);
  }, [selected, loadDetail]);

  /**
   * Re-reads the selected batch while any of its jobs is still in flight.
   *
   * The condition is derived from the jobs rather than from the batch: a batch
   * spells `running` until every member settles, but the moment nothing is
   * un-terminal there is nothing left to watch, and a timer that kept firing
   * would be a tab keeping a lab process busy all day.
   */
  const watching =
    detail !== null &&
    detail.jobs.some((job) => !['completed', 'failed', 'cancelled'].includes(job.status));

  const detailRef = useRef(detail);
  detailRef.current = detail;

  useEffect(() => {
    if (!watching || selected === null || pollMs <= 0) return;
    let live = true;
    const timer = setInterval(() => {
      void (async () => {
        const current = detailRef.current;
        if (current === null) return;
        const readings = await Promise.all(
          current.jobs.map(async (job) => session.jobProgress(job.jobId)),
        );
        if (!live) return;
        setDetail((held) => (held === null ? held : applyReadings(held, readings)));
      })();
    }, pollMs);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [watching, selected, pollMs, session]);

  const refresh = useCallback(async (): Promise<void> => {
    await loadBatches();
    if (selected !== null) await loadDetail(selected);
  }, [loadBatches, loadDetail, selected]);

  /** Runs a mutation, replaces the detail with what the server answered, and reports a refusal. */
  const run = useCallback(
    async (
      work: () => Promise<{ ok: true; value: BatchDetail } | { ok: false; failure: AdminFailure }>,
    ) => {
      const answer = await work();
      if (!answer.ok) {
        setActionFailure(answer.failure);
        // Re-read, because a refusal usually means this screen was working from
        // an ordering somebody else changed, and leaving the stale one on screen
        // would make the next attempt fail the same way.
        if (selected !== null) await loadDetail(selected);
        return;
      }
      setActionFailure(null);
      setDetail(answer.value);
      await loadBatches();
    },
    [loadBatches, loadDetail, selected],
  );

  const jobAction = useCallback(
    async (jobId: JobId, action: OperatorJobAction): Promise<void> => {
      const answer = await session.jobAction(jobId, action);
      if (!answer.ok) {
        setActionFailure(answer.failure);
      } else {
        setActionFailure(null);
      }
      if (selected !== null) await loadDetail(selected);
      await loadBatches();
    },
    [session, selected, loadBatches, loadDetail],
  );

  const ask = (confirmation: Confirmation): void => {
    setPending(confirmation);
  };

  /**
   * Turns a completed Commander Search batch into a scheduled finalist
   * championship (M08.15), then selects the new batch — `loadDetail` follows
   * from the `selected` effect above, exactly the way selecting any other
   * batch loads its detail.
   */
  const scheduleChampionship = useCallback(
    async (
      batchId: BatchId,
      settings: { finalistsPerCommander: number; gamesPerPairing: number; seed: string },
    ): Promise<void> => {
      const answer = await session.scheduleChampionship(batchId, settings);
      if (!answer.ok) {
        setActionFailure(answer.failure);
        return;
      }
      setActionFailure(null);
      await loadBatches();
      setSelected(answer.value.batch.batchId);
    },
    [session, loadBatches],
  );

  return (
    <div className="queue">
      <p className="panel__note queue__ordering-note">{ORDER_IS_NOT_STATE}</p>

      <section className="panel" aria-labelledby="queue-batches">
        <h2 id="queue-batches">Test batches</h2>
        <p className="panel__note">
          Newest last, in the order this catalog created them. A batch that is still a{' '}
          <strong>draft</strong> has never run: its jobs are held until somebody starts it.
        </p>
        {listFailure !== null && (
          <Failure
            title="The batch listing could not be read"
            failure={listFailure}
            onRetry={() => void loadBatches()}
          />
        )}
        {batches === null && listFailure === null && <Busy label="Asking what this lab holds…" />}
        {batches !== null && batches.length === 0 && (
          <Empty>
            This catalog holds no test batches yet. New Test Batch is where one is configured.
          </Empty>
        )}
        {batches !== null && batches.length > 0 && (
          <ul className="queue__batches">
            {batches.map((batch) => (
              <li key={batch.batchId}>
                <button
                  type="button"
                  className={batch.batchId === selected ? 'is-current' : ''}
                  aria-current={batch.batchId === selected ? 'true' : undefined}
                  onClick={() => {
                    setActionFailure(null);
                    setSelected(batch.batchId);
                  }}
                >
                  <span className="queue__batch-label">{batch.label}</span>
                  <span className="queue__badge" data-status={batch.status}>
                    {BATCH_STATUS_WORDING[batch.status].label}
                  </span>
                  <span className="queue__batch-count">
                    {batch.jobIds.length} {batch.jobIds.length === 1 ? 'job' : 'jobs'}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {detailFailure !== null && (
        <Failure
          title="That batch could not be read"
          failure={detailFailure}
          onRetry={() => void refresh()}
        />
      )}

      {detail !== null && (
        <BatchPanel
          detail={detail}
          actionFailure={actionFailure}
          onDismissFailure={() => {
            setActionFailure(null);
          }}
          onRefresh={() => void refresh()}
          onAsk={ask}
          onJobAction={(jobId, action) => void jobAction(jobId, action)}
          onReorder={(jobIds) => {
            void run(async () => session.reorderBatch(detail.batch.batchId, jobIds));
          }}
          onDuplicate={(jobId) => {
            void run(async () => session.duplicateJob(jobId));
          }}
          onScheduleChampionship={(batchId, settings) => {
            void scheduleChampionship(batchId, settings);
          }}
        />
      )}

      {pending !== null && (
        <ConfirmDialog
          confirmation={pending}
          onCancel={() => {
            setPending(null);
          }}
          onConfirm={() => {
            const held = pending;
            setPending(null);
            if (held.kind === 'start') {
              void run(async () => session.startBatch(held.batchId));
            } else {
              void jobAction(held.jobId, held.action);
            }
          }}
        />
      )}

      <StatusLegend />
    </div>
  );
}

/* --------------------------------------------------------------- the batch */

interface BatchPanelProps {
  readonly detail: BatchDetail;
  readonly actionFailure: AdminFailure | null;
  readonly onDismissFailure: () => void;
  readonly onRefresh: () => void;
  readonly onAsk: (confirmation: Confirmation) => void;
  readonly onJobAction: (jobId: JobId, action: OperatorJobAction) => void;
  readonly onReorder: (jobIds: readonly JobId[]) => void;
  readonly onDuplicate: (jobId: JobId) => void;
  readonly onScheduleChampionship: (
    batchId: BatchId,
    settings: { finalistsPerCommander: number; gamesPerPairing: number; seed: string },
  ) => void;
}

function BatchPanel({
  detail,
  actionFailure,
  onDismissFailure,
  onRefresh,
  onAsk,
  onJobAction,
  onReorder,
  onDuplicate,
  onScheduleChampionship,
}: BatchPanelProps) {
  const { batch, jobs } = detail;
  const editable = batch.status === 'draft';
  const order = jobs.map((job) => job.jobId);
  const searchJobs = jobs.filter(isCommanderSearchJob);
  // Mirrors `ChampionshipScheduler`'s own precondition exactly: every Commander
  // Search job in this batch has completed. Checked on the jobs rather than on
  // `batch.status`, because a batch can hold other work alongside a Commander
  // Search and the search half can finish well before the whole batch does.
  const canScheduleChampionship =
    searchJobs.length > 0 && searchJobs.every((job) => job.status === 'completed');

  return (
    <section className="panel" aria-labelledby="queue-batch-detail">
      <h2 id="queue-batch-detail">{batch.label}</h2>
      <p className="queue__batch-state">
        <span className="queue__badge" data-status={batch.status}>
          {BATCH_STATUS_WORDING[batch.status].label}
        </span>{' '}
        {BATCH_STATUS_WORDING[batch.status].meaning}
      </p>

      {actionFailure !== null && (
        <Failure
          title="The lab refused that"
          failure={actionFailure}
          onRetry={onDismissFailure}
          retryLabel="Dismiss"
        />
      )}

      {editable ? (
        <p className="builder__actions">
          <button
            type="button"
            onClick={() => {
              onAsk({ kind: 'start', batchId: batch.batchId });
            }}
          >
            Start this batch
          </button>{' '}
          <span className="panel__note">
            Nothing in this batch has run. Starting it settles the order below and releases every
            job that has not been withdrawn.
          </span>
        </p>
      ) : (
        <p className="builder__actions">
          <button type="button" onClick={onRefresh}>
            Read this batch again
          </button>{' '}
          <span className="panel__note">
            The order is settled. Jobs are offered to a worker in the order below, under this
            lab&rsquo;s own bound.
          </span>
        </p>
      )}

      {canScheduleChampionship && (
        <ChampionshipScheduleForm batchId={batch.batchId} onSchedule={onScheduleChampionship} />
      )}

      {jobs.length === 0 ? (
        <Empty>This batch holds no jobs.</Empty>
      ) : (
        <ol className="queue__jobs">
          {jobs.map((job, index) => (
            <li key={job.jobId}>
              <JobRow
                job={job}
                position={index}
                total={jobs.length}
                editable={editable}
                onAsk={onAsk}
                onJobAction={onJobAction}
                onDuplicate={onDuplicate}
                onMove={(to) => {
                  onReorder(moveInOrder(order, index, to));
                }}
              />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/** Whether a job came from `commander_search`, the only preset a championship can be scheduled from. */
function isCommanderSearchJob(job: CatalogJobView): boolean {
  return job.origin.kind === 'preset' && job.origin.presetId === 'commander_search';
}

interface ChampionshipScheduleFormProps {
  readonly batchId: BatchId;
  readonly onSchedule: (
    batchId: BatchId,
    settings: { finalistsPerCommander: number; gamesPerPairing: number; seed: string },
  ) => void;
}

/**
 * The one control `commander_search`'s own `deferredStages` entry points at:
 * every search in this completed batch has finished, so its frozen finalist
 * championship — named but not schedulable when the batch was built — can now
 * be scheduled (M08.15).
 *
 * The three settings are asked for here rather than recovered from the
 * original choice, because nothing durable remembers it: `enqueuePreset`'s
 * decisions are a one-time answer to that request, not a stored record, so a
 * request that needs them again supplies them again.
 */
function ChampionshipScheduleForm({ batchId, onSchedule }: ChampionshipScheduleFormProps) {
  const [finalistsPerCommander, setFinalistsPerCommander] = useState(3);
  const [gamesPerPairing, setGamesPerPairing] = useState(4);
  const [seed, setSeed] = useState(`${batchId}-championship`);

  return (
    <form
      className="panel__subsection"
      aria-labelledby="schedule-championship"
      onSubmit={(event) => {
        event.preventDefault();
        onSchedule(batchId, { finalistsPerCommander, gamesPerPairing, seed });
      }}
    >
      <h3 id="schedule-championship">Schedule the finalist championship</h3>
      <p className="panel__note">
        Every Commander Search job in this batch has finished. Scheduling selects sufficiently
        distinct finalists per Commander from their own archives, freezes them, and creates a new
        draft batch with one fresh-seed, mirrored round-robin job — left for you to review and
        start.
      </p>
      <label>
        Finalists per Commander
        <input
          type="number"
          min={1}
          max={8}
          value={finalistsPerCommander}
          onChange={(event) => {
            setFinalistsPerCommander(Number(event.target.value));
          }}
        />
      </label>
      <label>
        Games per pairing
        <input
          type="number"
          min={1}
          max={200}
          value={gamesPerPairing}
          onChange={(event) => {
            setGamesPerPairing(Number(event.target.value));
          }}
        />
      </label>
      <label>
        Seed
        <input
          type="text"
          value={seed}
          onChange={(event) => {
            setSeed(event.target.value);
          }}
        />
      </label>
      <button type="submit">Schedule championship</button>
    </form>
  );
}

/* ----------------------------------------------------------------- one job */

interface JobRowProps {
  readonly job: CatalogJobView;
  readonly position: number;
  readonly total: number;
  readonly editable: boolean;
  readonly onAsk: (confirmation: Confirmation) => void;
  readonly onJobAction: (jobId: JobId, action: OperatorJobAction) => void;
  readonly onDuplicate: (jobId: JobId) => void;
  readonly onMove: (to: number) => void;
}

function JobRow({
  job,
  position,
  total,
  editable,
  onAsk,
  onJobAction,
  onDuplicate,
  onMove,
}: JobRowProps) {
  const wording = JOB_STATUS_WORDING[job.status];
  const actions = operatorActionsFor(job.status);
  const stage = stageText(job.progress);
  const left = remainingTime(job);
  const withdrawn = editable && job.status === 'cancelled';

  return (
    <article
      className="queue__job"
      data-status={job.status}
      aria-label={`${job.label}, ${wording.label}`}
    >
      <header className="queue__job-head">
        <span className="queue__position">{position + 1}</span>
        <span className="queue__job-label">{job.label}</span>
        <span className="queue__badge" data-status={job.status}>
          {wording.label}
        </span>
      </header>

      <p className="queue__job-meaning">{withdrawn ? WITHDRAWN_MEANING : wording.meaning}</p>

      <dl className="queue__facts">
        <div>
          <dt>Matches</dt>
          <dd>{matchProgressText(job.progress)}</dd>
        </div>
        <div>
          <dt>Stage</dt>
          <dd>{stage ?? 'This job declares no stages, so every match is in one run.'}</dd>
        </div>
        <div>
          <dt>Elapsed</dt>
          <dd>
            {job.progress.elapsedMs === null
              ? 'Nothing has been timed for this job yet.'
              : `${formatDuration(job.progress.elapsedMs)} of measured run time, summed across attempts.`}
          </dd>
        </div>
        <div>
          <dt>Remaining</dt>
          <dd>
            {left.available ? (
              <>
                <strong>{left.text}</strong> <span className="queue__basis">{left.basis}</span>
              </>
            ) : (
              <span className="queue__unavailable">Not available. {left.reason}</span>
            )}
          </dd>
        </div>
        <div>
          <dt>Run</dt>
          <dd>
            <code>{job.spec.experimentId}</code> · seed <code>{job.spec.seed}</code>
            {job.execution !== null && (
              <>
                {' '}
                · {job.execution.attempts} {job.execution.attempts === 1 ? 'attempt' : 'attempts'},{' '}
                {job.execution.workers} {job.execution.workers === 1 ? 'worker' : 'workers'}
              </>
            )}
          </dd>
        </div>
      </dl>

      {job.failure !== null && (
        <p className="queue__job-failure" role="note">
          <code>{job.failure.code}</code> {job.failure.message}
        </p>
      )}

      <div className="queue__job-actions">
        {editable && (
          <>
            <button
              type="button"
              disabled={position === 0}
              onClick={() => {
                onMove(position - 1);
              }}
            >
              Move up
            </button>
            <button
              type="button"
              disabled={position === total - 1}
              onClick={() => {
                onMove(position + 1);
              }}
            >
              Move down
            </button>
            <button
              type="button"
              onClick={() => {
                onDuplicate(job.jobId);
              }}
            >
              Duplicate
            </button>
          </>
        )}
        {actions.map((action) => {
          const verb: ActionWording =
            editable && action === 'cancel' ? WITHDRAW_WORDING : JOB_ACTION_WORDING[action];
          return (
            <button
              key={action}
              type="button"
              onClick={() => {
                if (verb.confirm === null) {
                  onJobAction(job.jobId, action);
                  return;
                }
                onAsk({ kind: 'job', jobId: job.jobId, action, label: job.label, verb });
              }}
            >
              {verb.label}
            </button>
          );
        })}
      </div>
    </article>
  );
}

const WITHDRAWN_MEANING =
  'Withdrawn before this batch was started, so it will never run. It stays listed here because nothing in this lab deletes a record.';

/* ---------------------------------------------------------- confirmations */

type Confirmation =
  | { readonly kind: 'start'; readonly batchId: BatchId }
  | {
      readonly kind: 'job';
      readonly jobId: JobId;
      readonly action: OperatorJobAction;
      readonly label: string;
      readonly verb: ActionWording;
    };

/**
 * A confirmation that says what will happen, not "are you sure".
 *
 * It appears only for the two things this screen can do that cannot be undone
 * from it — cancelling or withdrawing a job, and starting a batch — and the text
 * is the wording module's rather than this component's, so a test can assert the
 * consequence was stated without asserting a sentence a component author chose.
 *
 * `role="alertdialog"` with a label and a description, and the focus moves to the
 * confirming control, so a keyboard operator is put where the decision is instead
 * of having to find it.
 */
function ConfirmDialog({
  confirmation,
  onCancel,
  onConfirm,
}: {
  readonly confirmation: Confirmation;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  const accept = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    accept.current?.focus();
  }, []);

  const question =
    confirmation.kind === 'start' ? START_BATCH_CONFIRM : (confirmation.verb.confirm ?? '');
  const title =
    confirmation.kind === 'start' ? 'Start this batch?' : `${confirmation.verb.label} this job?`;

  return (
    <div
      className="queue__confirm"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="queue-confirm-title"
      aria-describedby="queue-confirm-body"
    >
      <h3 id="queue-confirm-title">{title}</h3>
      <p id="queue-confirm-body">{question}</p>
      <p className="builder__actions">
        <button type="button" ref={accept} onClick={onConfirm}>
          {confirmation.kind === 'start' ? 'Start it' : confirmation.verb.label}
        </button>{' '}
        <button type="button" onClick={onCancel}>
          Leave it alone
        </button>
      </p>
    </div>
  );
}

/* --------------------------------------------------------------- the legend */

/**
 * Every lifecycle state a job can be in, named on the page whether or not one is
 * in it right now.
 *
 * The milestone's *every lifecycle state visible and named*, taken literally: a
 * legend that only listed the states currently on screen would leave an operator
 * meeting `interrupted` for the first time at the worst possible moment. It is
 * built from `JOB_STATUSES` itself, so a state added to the table appears here
 * the day it is added.
 */
function StatusLegend() {
  return (
    <section className="panel" aria-labelledby="queue-legend">
      <h2 id="queue-legend">What each state means</h2>
      <table className="facts">
        <caption className="visually-hidden">Every state a job in this queue can be in</caption>
        <tbody>
          {JOB_STATUS_LEGEND.map((entry) => (
            <tr key={entry.status}>
              <th scope="row">
                <span className="queue__badge" data-status={entry.status}>
                  {entry.label}
                </span>
              </th>
              <td>
                <span className="facts__value">{entry.meaning}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/* ---------------------------------------------------------------- the poll */

/**
 * Folds a round of `jobProgress` readings into the detail already on screen.
 *
 * Only `status` and `progress` are replaced, because those are the only two
 * fields the progress endpoint answers with — it is deliberately not the whole
 * job document, so that a screen polling three running jobs is not re-sending an
 * unchanged spec, origin and annotation block every two seconds. A reading that
 * failed leaves its row exactly as it was: a poll that dropped a job on one
 * refused request would make a hiccup look like a queue emptying.
 */
function applyReadings(
  detail: BatchDetail,
  readings: readonly (
    | {
        ok: true;
        value: {
          jobId: JobId;
          status: CatalogJobView['status'];
          progress: CatalogJobView['progress'];
        };
      }
    | { ok: false }
  )[],
): BatchDetail {
  const byId = new Map(
    readings.filter((reading) => reading.ok).map((reading) => [reading.value.jobId, reading.value]),
  );
  return {
    ...detail,
    jobs: detail.jobs.map((job) => {
      const reading = byId.get(job.jobId);
      return reading === undefined
        ? job
        : { ...job, status: reading.status, progress: reading.progress };
    }),
  };
}
