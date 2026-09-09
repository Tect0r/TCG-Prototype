import { useCallback, useState } from 'react';

import {
  CATALOG_COVERAGE_STAGES,
  jobIdSchema,
  LIVE_MATCH_SOURCES,
  liveMatchContentVersionSchema,
  type CatalogCoverageReport,
  type JobId,
  type LiveMatchSource,
  type PlayerMetaCoverageReport,
  type PlayerMetaPartition,
} from '@tcg/admin-contracts';

import {
  catalogCoverageStageLabel,
  catalogStageTallyFacts,
  coverageStatusLabel,
  playerMetaObservationTally,
} from '../lib/coverage-view.js';
import type { AdminOutcome } from '../net/transport.js';
import { useAdminSession } from '../state/AdminContext.js';
import { Busy, Empty, Failure } from './Feedback.js';
import { FactTable } from './FactTable.js';

/**
 * M08.27C — the Coverage panel: how much of the whole card and mechanic
 * vocabulary a format admits was actually exercised, and where it was not,
 * why not, for one catalog run or one Player Meta partition.
 *
 * **Two domains, never merged**, mirroring `coverage.ts`'s own split: the
 * Catalog tab is entered by a `jobId` (the same "type an identifier"
 * required-ID pattern `AdaptiveRunPanel` uses, since a coverage report has no
 * catalog row to select from), the Player Meta tab by the exact
 * `(source, contentVersion, rulesVersion)` partition `playerMetaPartitionSchema`
 * names — there is no filter form here, only the exact partition, because
 * `computePlayerMetaCoverage` answers one partition at a time.
 *
 * Every card and mechanic status is shown three-valued
 * (`reached`/`not_reached`/`unavailable`), never collapsed into a
 * pass/fail count — see `coverage-view.ts`'s own doc comment.
 */

type CoverageDomain = 'catalog' | 'player_meta';

export function CoveragePanel() {
  const [domain, setDomain] = useState<CoverageDomain>('catalog');
  return (
    <section className="panel" aria-labelledby="coverage">
      <h2 id="coverage">Coverage</h2>
      <p className="panel__note">
        Of the whole card and mechanic vocabulary this format admits, how much did this run or
        partition actually exercise — and where it did not, why not.
      </p>
      <div className="results__tabs" role="tablist" aria-label="Coverage domain">
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
      {domain === 'catalog' ? <CatalogCoveragePanel /> : <PlayerMetaCoveragePanel />}
    </section>
  );
}

function CatalogCoveragePanel() {
  const session = useAdminSession();
  const [input, setInput] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<JobId | null>(null);
  const [report, setReport] = useState<AdminOutcome<CatalogCoverageReport> | null>(null);

  const open = useCallback(
    (id: JobId) => {
      setJobId(id);
      setReport(null);
      void session.catalogCoverageView(id).then(setReport);
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

      {jobId !== null && report === null && <Busy label="Reading this run's coverage…" />}
      {report !== null && !report.ok && (
        <Failure
          title="This run's coverage could not be shown"
          failure={report.failure}
          onRetry={() => {
            if (jobId !== null) open(jobId);
          }}
        />
      )}
      {report !== null && report.ok && <CatalogCoverageView report={report.value} />}
    </>
  );
}

function CatalogCoverageView({ report }: { readonly report: CatalogCoverageReport }) {
  if (report.unavailableReason !== null) {
    return <Empty>Coverage unavailable for this run: {report.unavailableReason}</Empty>;
  }
  return (
    <>
      <FactTable caption="Coverage by stage" facts={catalogStageTallyFacts(report.cards)} />
      <CatalogCardsTable cards={report.cards} />
      <CatalogMechanicsTable mechanics={report.mechanics} />
    </>
  );
}

function CatalogCardsTable({ cards }: { readonly cards: CatalogCoverageReport['cards'] }) {
  if (cards.length === 0) return <Empty>No card is in this run's whole vocabulary.</Empty>;
  return (
    <div className="dashboard__heatmap-wrap">
      <table className="dashboard__bars">
        <caption className="visually-hidden">Card coverage by stage</caption>
        <thead>
          <tr>
            <th scope="col">Card</th>
            {CATALOG_COVERAGE_STAGES.map((stage) => (
              <th scope="col" key={stage}>
                {catalogCoverageStageLabel(stage)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {cards.map((card) => (
            <tr key={card.cardId}>
              <td>{card.cardId}</td>
              {CATALOG_COVERAGE_STAGES.map((stage) => (
                <td key={stage}>{coverageStatusLabel(card[stage])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CatalogMechanicsTable({
  mechanics,
}: {
  readonly mechanics: CatalogCoverageReport['mechanics'];
}) {
  if (mechanics.length === 0) return <Empty>No mechanic is in this format's vocabulary.</Empty>;
  return (
    <div className="dashboard__heatmap-wrap">
      <table className="dashboard__bars">
        <caption className="visually-hidden">Mechanic coverage</caption>
        <thead>
          <tr>
            <th scope="col">Mechanic</th>
            <th scope="col">Cards using</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {mechanics.map((mechanic) => (
            <tr key={mechanic.mechanicKey}>
              <td>{mechanic.mechanicKey}</td>
              <td>{mechanic.cardsUsing}</td>
              <td>
                {coverageStatusLabel(mechanic.status)}
                {mechanic.unavailableReason !== null && ` — ${mechanic.unavailableReason}`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PlayerMetaCoveragePanel() {
  const session = useAdminSession();
  const [source, setSource] = useState<LiveMatchSource>(LIVE_MATCH_SOURCES[0]);
  const [contentVersionInput, setContentVersionInput] = useState('1');
  const [rulesVersionInput, setRulesVersionInput] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [partition, setPartition] = useState<PlayerMetaPartition | null>(null);
  const [report, setReport] = useState<AdminOutcome<PlayerMetaCoverageReport> | null>(null);

  const open = useCallback(
    (next: PlayerMetaPartition) => {
      setPartition(next);
      setReport(null);
      void session.playerMetaCoverageView(next).then(setReport);
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
        <Busy label="Reading this partition's coverage…" />
      )}
      {report !== null && !report.ok && (
        <Failure
          title="This partition's coverage could not be shown"
          failure={report.failure}
          onRetry={() => {
            if (partition !== null) open(partition);
          }}
        />
      )}
      {report !== null && report.ok && <PlayerMetaCoverageView report={report.value} />}
    </>
  );
}

function PlayerMetaCoverageView({ report }: { readonly report: PlayerMetaCoverageReport }) {
  if (report.unavailableReason !== null) {
    return <Empty>Coverage unavailable for this partition: {report.unavailableReason}</Empty>;
  }
  if (report.cards.length === 0) {
    return <Empty>No card was observed in this partition.</Empty>;
  }
  const tally = playerMetaObservationTally(report.cards);
  return (
    <>
      <FactTable
        caption="Observation coverage"
        facts={[
          {
            label: 'Observation',
            value: `${tally.reached} reached, ${tally.not_reached} not reached, ${tally.unavailable} unavailable`,
          },
        ]}
      />
      <div className="dashboard__heatmap-wrap">
        <table className="dashboard__bars">
          <caption className="visually-hidden">Card observation coverage</caption>
          <thead>
            <tr>
              <th scope="col">Card</th>
              <th scope="col">Observation</th>
            </tr>
          </thead>
          <tbody>
            {report.cards.map((card) => (
              <tr key={card.cardId}>
                <td>{card.cardId}</td>
                <td>
                  {coverageStatusLabel(card.observation)}
                  {card.unavailableReason !== null && ` — ${card.unavailableReason}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
