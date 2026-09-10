import { useCallback, useState } from 'react';

import {
  jobIdSchema,
  LIVE_MATCH_SOURCES,
  liveMatchContentVersionSchema,
  type CatalogDataHealthReport,
  type CatalogReplicateDisagreementEntry,
  type DataHealthFlagBucket,
  type JobId,
  type LiveMatchSource,
  type PlayerMetaDataHealthReport,
  type PlayerMetaMatchRecord,
  type PlayerMetaPartition,
} from '@tcg/admin-contracts';

import {
  catalogDataHealthFacts,
  flagEntryLabel,
  playerMetaDataHealthFacts,
} from '../lib/data-health-view.js';
import type { AdminOutcome } from '../net/transport.js';
import { useAdminSession } from '../state/AdminContext.js';
import { Busy, Empty, Failure } from './Feedback.js';
import { FactTable } from './FactTable.js';

/**
 * M08.27D — the Data Health panel: can this run's or partition's numbers be
 * trusted, and where the answer is no, why not, for one catalog run or one
 * Player Meta partition.
 *
 * **Two domains, never merged**, mirroring `CoverageDashboard`'s own split:
 * the Catalog tab is entered by a `jobId`, the Player Meta tab by the exact
 * `(source, contentVersion, rulesVersion)` partition — there is no filter
 * form here, only the exact partition, because `computePlayerMetaDataHealth`
 * answers one partition at a time.
 *
 * Every category is shown either measured or `Unavailable` with its reason —
 * see `data-health-view.ts`'s own doc comment — never a fabricated zero.
 */

type DataHealthDomain = 'catalog' | 'player_meta';

export function DataHealthPanel() {
  const [domain, setDomain] = useState<DataHealthDomain>('catalog');
  return (
    <section className="panel" aria-labelledby="data-health">
      <h2 id="data-health">Data Health</h2>
      <p className="panel__note">
        Corrupt or skipped records, failures, abnormal and stalled matches, exclusions, replicate
        disagreement, seat bias, pilot sensitivity, unsupported mechanics and deterministic replay
        status — for one catalog run or one Player Meta partition.
      </p>
      <div className="results__tabs" role="tablist" aria-label="Data Health domain">
        <button
          type="button"
          role="tab"
          aria-pressed={domain === 'catalog'}
          onClick={() => {
            setDomain('catalog');
          }}
        >
          Catalog run
        </button>
        <button
          type="button"
          role="tab"
          aria-pressed={domain === 'player_meta'}
          onClick={() => {
            setDomain('player_meta');
          }}
        >
          Player Meta partition
        </button>
      </div>
      {domain === 'catalog' ? <CatalogDataHealthPanel /> : <PlayerMetaDataHealthPanel />}
    </section>
  );
}

function CatalogDataHealthPanel() {
  const session = useAdminSession();
  const [input, setInput] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<JobId | null>(null);
  const [report, setReport] = useState<AdminOutcome<CatalogDataHealthReport> | null>(null);

  const open = useCallback(
    (id: JobId) => {
      setJobId(id);
      setReport(null);
      void session.catalogDataHealthView(id).then(setReport);
    },
    [session],
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

      {jobId !== null && report === null && <Busy label="Reading this run's data health…" />}
      {report !== null && !report.ok && (
        <Failure
          title="This run's data health could not be shown"
          failure={report.failure}
          onRetry={() => {
            if (jobId !== null) open(jobId);
          }}
        />
      )}
      {report !== null && report.ok && <CatalogDataHealthView report={report.value} />}
    </>
  );
}

function CatalogDataHealthView({ report }: { readonly report: CatalogDataHealthReport }) {
  if (report.unavailableReason !== null) {
    return <Empty>Data health unavailable for this run: {report.unavailableReason}</Empty>;
  }
  return (
    <>
      <FactTable caption="Data Health summary" facts={catalogDataHealthFacts(report)} />
      <RecoveredRecordsTable
        caption="Recovered records"
        entries={report.recoveredRecords.entries}
        columns={{ key: (entry) => `line ${entry.line}`, reason: (entry) => entry.reason }}
      />
      <FlagEntriesTable caption="Exclusions" bucket={report.exclusions} />
      <ReplicateDisagreementTable entries={report.replicateDisagreement.entries} />
      <FlagEntriesTable caption="Seat bias" bucket={report.seatBias} />
      <FlagEntriesTable caption="Pilot sensitivity" bucket={report.pilotSensitivity} />
      <FlagEntriesTable caption="Unsupported mechanics" bucket={report.unsupportedMechanics} />
    </>
  );
}

function PlayerMetaDataHealthPanel() {
  const session = useAdminSession();
  const [source, setSource] = useState<LiveMatchSource>(LIVE_MATCH_SOURCES[0]);
  const [contentVersionInput, setContentVersionInput] = useState('1');
  const [rulesVersionInput, setRulesVersionInput] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [partition, setPartition] = useState<PlayerMetaPartition | null>(null);
  const [report, setReport] = useState<AdminOutcome<PlayerMetaDataHealthReport> | null>(null);

  const open = useCallback(
    (next: PlayerMetaPartition) => {
      setPartition(next);
      setReport(null);
      void session.playerMetaDataHealthView(next).then(setReport);
    },
    [session],
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

      {partition !== null && report === null && (
        <Busy label="Reading this partition's data health…" />
      )}
      {report !== null && !report.ok && (
        <Failure
          title="This partition's data health could not be shown"
          failure={report.failure}
          onRetry={() => {
            if (partition !== null) open(partition);
          }}
        />
      )}
      {report !== null && report.ok && <PlayerMetaDataHealthView report={report.value} />}
    </>
  );
}

function PlayerMetaDataHealthView({ report }: { readonly report: PlayerMetaDataHealthReport }) {
  if (report.unavailableReason !== null) {
    return <Empty>Data health unavailable for this partition: {report.unavailableReason}</Empty>;
  }
  return (
    <>
      <FactTable caption="Data Health summary" facts={playerMetaDataHealthFacts(report)} />
      <MatchRecordsTable caption="Recovered records" entries={report.recoveredRecords.entries} />
      <MatchRecordsTable caption="Exclusions" entries={report.exclusions.entries} />
      <ReplicateDisagreementTable entries={report.replicateDisagreement.entries} />
      <FlagEntriesTable caption="Seat bias" bucket={report.seatBias} />
      <FlagEntriesTable caption="Pilot sensitivity" bucket={report.pilotSensitivity} />
      <FlagEntriesTable caption="Unsupported mechanics" bucket={report.unsupportedMechanics} />
    </>
  );
}

/* --------------------------------------------------------------- detail tables */

function RecoveredRecordsTable<T>({
  caption,
  entries,
  columns,
}: {
  readonly caption: string;
  readonly entries: readonly T[];
  readonly columns: { readonly key: (entry: T) => string; readonly reason: (entry: T) => string };
}) {
  if (entries.length === 0) return null;
  return (
    <div className="dashboard__heatmap-wrap">
      <table className="dashboard__bars">
        <caption className="visually-hidden">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">{caption}</th>
            <th scope="col">Reason</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry, index) => (
            <tr key={index}>
              <td>{columns.key(entry)}</td>
              <td>{columns.reason(entry)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MatchRecordsTable({
  caption,
  entries,
}: {
  readonly caption: string;
  readonly entries: readonly PlayerMetaMatchRecord[];
}) {
  if (entries.length === 0) return null;
  return (
    <div className="dashboard__heatmap-wrap">
      <table className="dashboard__bars">
        <caption className="visually-hidden">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Match</th>
            <th scope="col">Reason</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.matchId}>
              <td>{entry.matchId}</td>
              <td>{entry.reason}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FlagEntriesTable({
  caption,
  bucket,
}: {
  readonly caption: string;
  readonly bucket: DataHealthFlagBucket;
}) {
  if (bucket.entries.length === 0) return null;
  return (
    <div className="dashboard__heatmap-wrap">
      <table className="dashboard__bars">
        <caption className="visually-hidden">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">{caption}</th>
          </tr>
        </thead>
        <tbody>
          {bucket.entries.map((entry, index) => (
            <tr key={index}>
              <td>{flagEntryLabel(entry)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ReplicateDisagreementTable({
  entries,
}: {
  readonly entries: readonly CatalogReplicateDisagreementEntry[];
}) {
  if (entries.length === 0) return null;
  return (
    <div className="dashboard__heatmap-wrap">
      <table className="dashboard__bars">
        <caption className="visually-hidden">Replicate disagreement</caption>
        <thead>
          <tr>
            <th scope="col">Definition</th>
            <th scope="col">Between-replicate variation</th>
            <th scope="col">Replicates</th>
            <th scope="col">Share delta</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.definitionId}>
              <td>{entry.definitionId}</td>
              <td>{entry.betweenReplicateVariation}</td>
              <td>{entry.replicates}</td>
              <td>{entry.shareDelta}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
