import { useCallback, useState, type ReactNode } from 'react';

import {
  jobIdSchema,
  LIVE_MATCH_SOURCES,
  liveMatchContentVersionSchema,
  type JobId,
  type LiveMatchSource,
  type PlayerMetaPartition,
} from '@tcg/admin-contracts';

import type { AdminOutcome } from '../net/transport.js';
import { OutcomeView } from './Feedback.js';

/**
 * The two "type an identifier, then read the result" shells Coverage and
 * Data Health each restated, form and all, for their catalog and Player Meta
 * tabs (M08.R22): a `jobId` typed into a form for a catalog run, or the
 * exact `(source, contentVersion, rulesVersion)` partition typed into one
 * for Player Meta. Both dashboards need this because a coverage or
 * data-health report has no catalog row to pick from, unlike every
 * list-backed panel elsewhere.
 *
 * What is shared is the wiring — the form, the pending identifier, and the
 * `OutcomeView` boundary it opens onto; what stays local is what each caller
 * fetches and how it renders a settled report, via `fetch` and `children`.
 */

interface JobIdLookupPanelProps<T> {
  readonly fetch: (id: JobId) => Promise<AdminOutcome<T>>;
  readonly busyLabel: string;
  readonly failureTitle: string;
  readonly children: (value: T) => ReactNode;
}

export function JobIdLookupPanel<T>({
  fetch,
  busyLabel,
  failureTitle,
  children,
}: JobIdLookupPanelProps<T>) {
  const [input, setInput] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<JobId | null>(null);
  const [report, setReport] = useState<AdminOutcome<T> | null>(null);

  const open = useCallback(
    (id: JobId) => {
      setJobId(id);
      setReport(null);
      void fetch(id).then(setReport);
    },
    [fetch],
  );

  return (
    <>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const parsed = jobIdSchema.safeParse(input.trim());
          if (!parsed.success) {
            setFormError(parsed.error.issues[0]?.message ?? 'Not a valid job ID.');
            return;
          }
          setFormError(null);
          open(parsed.data);
        }}
      >
        <label className="builder__field">
          Job ID
          <input
            type="text"
            value={input}
            placeholder="job_..."
            onChange={(event) => {
              setInput(event.target.value);
            }}
          />
        </label>
        <p className="builder__actions">
          <button type="submit">Open</button>
        </p>
        {formError !== null && (
          <p className="dashboard__truncation" role="alert">
            {formError}
          </p>
        )}
      </form>

      <OutcomeView
        outcome={report}
        requested={jobId !== null}
        busyLabel={busyLabel}
        failureTitle={failureTitle}
        onRetry={() => {
          if (jobId !== null) open(jobId);
        }}
      >
        {children}
      </OutcomeView>
    </>
  );
}

interface PlayerMetaPartitionLookupPanelProps<T> {
  readonly fetch: (partition: PlayerMetaPartition) => Promise<AdminOutcome<T>>;
  readonly busyLabel: string;
  readonly failureTitle: string;
  readonly children: (value: T) => ReactNode;
}

export function PlayerMetaPartitionLookupPanel<T>({
  fetch,
  busyLabel,
  failureTitle,
  children,
}: PlayerMetaPartitionLookupPanelProps<T>) {
  const [source, setSource] = useState<LiveMatchSource>(LIVE_MATCH_SOURCES[0]);
  const [contentVersionInput, setContentVersionInput] = useState('1');
  const [rulesVersionInput, setRulesVersionInput] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [partition, setPartition] = useState<PlayerMetaPartition | null>(null);
  const [report, setReport] = useState<AdminOutcome<T> | null>(null);

  const open = useCallback(
    (next: PlayerMetaPartition) => {
      setPartition(next);
      setReport(null);
      void fetch(next).then(setReport);
    },
    [fetch],
  );

  return (
    <>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const parsedVersion = liveMatchContentVersionSchema.safeParse(
            Number(contentVersionInput),
          );
          if (!parsedVersion.success) {
            setFormError(parsedVersion.error.issues[0]?.message ?? 'Not a valid content version.');
            return;
          }
          const rulesVersion = rulesVersionInput.trim();
          if (rulesVersion === '') {
            setFormError('Rules version is required.');
            return;
          }
          setFormError(null);
          open({ source, contentVersion: parsedVersion.data, rulesVersion });
        }}
      >
        <label className="builder__field">
          Source
          <select
            value={source}
            onChange={(event) => {
              setSource(event.target.value as LiveMatchSource);
            }}
          >
            {LIVE_MATCH_SOURCES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label className="builder__field">
          Content version
          <input
            type="number"
            min={1}
            value={contentVersionInput}
            onChange={(event) => {
              setContentVersionInput(event.target.value);
            }}
          />
        </label>
        <label className="builder__field">
          Rules version
          <input
            type="text"
            value={rulesVersionInput}
            placeholder="1.0.0"
            onChange={(event) => {
              setRulesVersionInput(event.target.value);
            }}
          />
        </label>
        <p className="builder__actions">
          <button type="submit">Open</button>
        </p>
        {formError !== null && (
          <p className="dashboard__truncation" role="alert">
            {formError}
          </p>
        )}
      </form>

      <OutcomeView
        outcome={report}
        requested={partition !== null}
        busyLabel={busyLabel}
        failureTitle={failureTitle}
        onRetry={() => {
          if (partition !== null) open(partition);
        }}
      >
        {children}
      </OutcomeView>
    </>
  );
}
