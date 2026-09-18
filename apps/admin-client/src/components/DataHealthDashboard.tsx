import { useState } from 'react';

import {
  type CatalogDataHealthReport,
  type CatalogReplicateDisagreementEntry,
  type DataHealthFlagBucket,
  type PlayerMetaDataHealthReport,
  type PlayerMetaMatchRecord,
} from '@tcg/admin-contracts';

import {
  catalogDataHealthFacts,
  flagEntryLabel,
  playerMetaDataHealthFacts,
} from '../lib/data-health-view.js';
import { useAdminSession } from '../state/AdminContext.js';
import { Empty } from './Feedback.js';
import { FactTable } from './FactTable.js';
import { JobIdLookupPanel, PlayerMetaPartitionLookupPanel } from './LookupPanels.js';

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
  return (
    <JobIdLookupPanel<CatalogDataHealthReport>
      fetch={(id) => session.catalogDataHealthView(id)}
      busyLabel="Reading this run's data health…"
      failureTitle="This run's data health could not be shown"
    >
      {(value) => <CatalogDataHealthView report={value} />}
    </JobIdLookupPanel>
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
  return (
    <PlayerMetaPartitionLookupPanel<PlayerMetaDataHealthReport>
      fetch={(partition) => session.playerMetaDataHealthView(partition)}
      busyLabel="Reading this partition's data health…"
      failureTitle="This partition's data health could not be shown"
    >
      {(value) => <PlayerMetaDataHealthView report={value} />}
    </PlayerMetaPartitionLookupPanel>
  );
}

function PlayerMetaDataHealthView({ report }: { readonly report: PlayerMetaDataHealthReport }) {
  if (report.unavailableReason !== null) {
    return <Empty>Data health unavailable for this partition: {report.unavailableReason}</Empty>;
  }
  return (
    <>
      {report.truncatedReason !== null && (
        <p className="dashboard__truncation" role="note">
          {report.truncatedReason}
        </p>
      )}
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
