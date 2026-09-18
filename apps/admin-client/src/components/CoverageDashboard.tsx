import { useState } from 'react';

import {
  CATALOG_COVERAGE_STAGES,
  type CatalogCoverageReport,
  type PlayerMetaCoverageReport,
} from '@tcg/admin-contracts';

import {
  catalogCoverageStageLabel,
  catalogStageTallyFacts,
  coverageStatusLabel,
  playerMetaObservationTally,
} from '../lib/coverage-view.js';
import { useAdminSession } from '../state/AdminContext.js';
import { Empty } from './Feedback.js';
import { FactTable } from './FactTable.js';
import { JobIdLookupPanel, PlayerMetaPartitionLookupPanel } from './LookupPanels.js';

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
  return (
    <JobIdLookupPanel<CatalogCoverageReport>
      fetch={(id) => session.catalogCoverageView(id)}
      busyLabel="Reading this run's coverage…"
      failureTitle="This run's coverage could not be shown"
    >
      {(value) => <CatalogCoverageView report={value} />}
    </JobIdLookupPanel>
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
  return (
    <PlayerMetaPartitionLookupPanel<PlayerMetaCoverageReport>
      fetch={(partition) => session.playerMetaCoverageView(partition)}
      busyLabel="Reading this partition's coverage…"
      failureTitle="This partition's coverage could not be shown"
    >
      {(value) => <PlayerMetaCoverageView report={value} />}
    </PlayerMetaPartitionLookupPanel>
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
