import { useCallback, useState } from 'react';

import {
  contentIdSchema,
  jobIdSchema,
  type CardExplorerContributingDeck,
  type CardExplorerContributingMatch,
  type CardExplorerInclusion,
  type CardExplorerPartner,
  type CardExplorerUnavailablePartition,
  type CardExplorerView,
  type JobId,
} from '@tcg/admin-contracts';

import {
  cardExplorerEligibilityLabel,
  formatCardExplorerRate,
  resultRowFacts,
} from '../lib/card-explorer-view.js';
import type { AdminOutcome } from '../net/transport.js';
import { useAdminSession } from '../state/AdminContext.js';
import { Busy, Empty, Failure } from './Feedback.js';
import { FactTable } from './FactTable.js';

/**
 * M08.26C — the Card Explorer: one card's eligible-inclusion and partner
 * evidence across live matches, plus draw/play/dead-hand evidence from one
 * named job when a `jobId` is given.
 *
 * Entered the same way the Deck Explorer is — by typing an identifier — a
 * card read has neither a `JobId` nor a catalog row to select from. See
 * `card-explorer.ts` (`@tcg/admin-contracts`) for why replacements are not
 * part of this view: that evidence has no structured, queryable form
 * anywhere yet, and is recorded as the deliberately deferred next question
 * rather than invented here.
 */
export function CardExplorerPanel() {
  const session = useAdminSession();
  const [cardInput, setCardInput] = useState('');
  const [jobInput, setJobInput] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [cardId, setCardId] = useState<string | null>(null);
  const [view, setView] = useState<AdminOutcome<CardExplorerView> | null>(null);

  const open = useCallback(
    (nextCardId: string, jobId: JobId | null) => {
      setCardId(nextCardId);
      setView(null);
      void session.cardExplorerView(nextCardId, jobId).then(setView);
    },
    [session],
  );

  return (
    <section className="panel" aria-labelledby="card-explorer">
      <h2 id="card-explorer">Card Explorer</h2>
      <p className="panel__note">
        Enter the card ID to inspect. Eligible-inclusion and partner evidence is read across every
        live match this server finds; naming a job additionally cross-checks its own draw/play/
        dead-hand evidence for this card.
      </p>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          const parsedCard = contentIdSchema.safeParse(cardInput.trim());
          if (!parsedCard.success) {
            setFormError(parsedCard.error.issues[0]?.message ?? 'Not a valid card ID.');
            return;
          }
          let jobId: JobId | null = null;
          if (jobInput.trim() !== '') {
            const parsedJob = jobIdSchema.safeParse(jobInput.trim());
            if (!parsedJob.success) {
              setFormError(parsedJob.error.issues[0]?.message ?? 'Not a valid job ID.');
              return;
            }
            jobId = parsedJob.data;
          }
          setFormError(null);
          open(parsedCard.data, jobId);
        }}
      >
        <label className="builder__field">
          Card ID
          <input
            type="text"
            value={cardInput}
            placeholder="arcane_snare"
            onChange={(event) => {
              setCardInput(event.target.value);
            }}
          />
        </label>
        <label className="builder__field">
          Job ID (optional, for draw/play/dead-hand evidence)
          <input
            type="text"
            value={jobInput}
            placeholder="job_..."
            onChange={(event) => {
              setJobInput(event.target.value);
            }}
          />
        </label>
        <p className="builder__actions">
          <button type="submit">Open</button>
        </p>
      </form>
      {formError !== null && (
        <p className="feedback feedback--failure" role="alert">
          {formError}
        </p>
      )}

      {view === null && cardId !== null && <Busy label="Reading this card's evidence…" />}
      {view !== null && !view.ok && (
        <Failure
          title="This card could not be shown"
          failure={view.failure}
          onRetry={() => {
            if (cardId === null) return;
            open(cardId, null);
          }}
        />
      )}
      {view !== null && view.ok && <CardExplorerView view={view.value} />}
    </section>
  );
}

function CardExplorerView({ view }: { readonly view: CardExplorerView }) {
  return (
    <>
      <InclusionsView inclusions={view.inclusions} />
      <PartnersView partners={view.partners} />
      <UnavailablePartitionsView partitions={view.unavailablePartitions} />
      <ExperimentEvidenceView view={view} />
      <ContributingDecksView decks={view.contributingDecks} />
      <ContributingMatchesView matches={view.contributingMatches} />
    </>
  );
}

function InclusionsView({
  inclusions,
}: {
  readonly inclusions: readonly CardExplorerInclusion[];
}) {
  if (inclusions.length === 0) {
    return <Empty>No live match this server finds includes this card under any Commander.</Empty>;
  }
  return (
    <div className="dashboard__heatmap-wrap">
      <table className="dashboard__bars">
        <caption className="visually-hidden">Eligible inclusion by Commander and partition</caption>
        <thead>
          <tr>
            <th scope="col">Commander</th>
            <th scope="col">Status</th>
            <th scope="col">By matches</th>
            <th scope="col">By unique decks</th>
            <th scope="col">Source</th>
          </tr>
        </thead>
        <tbody>
          {inclusions.map((entry, index) => (
            <tr key={index}>
              <td>{entry.commanderId}</td>
              <td>{cardExplorerEligibilityLabel(entry.status)}</td>
              <td>
                {formatCardExplorerRate(entry.inclusion)} ({entry.matchesIncluding}/
                {entry.commanderMatches})
              </td>
              <td>
                {formatCardExplorerRate(entry.inclusionByUniqueDeck)} ({entry.decksIncluding}/
                {entry.uniqueDecks})
              </td>
              <td>
                {entry.observedIn.source} · content v{entry.observedIn.contentVersion} · rules{' '}
                {entry.observedIn.rulesVersion}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PartnersView({ partners }: { readonly partners: readonly CardExplorerPartner[] }) {
  if (partners.length === 0) {
    return <Empty>No live match this server finds pairs this card with another.</Empty>;
  }
  return (
    <div className="dashboard__heatmap-wrap">
      <table className="dashboard__bars">
        <caption className="visually-hidden">Partner cards</caption>
        <thead>
          <tr>
            <th scope="col">Commander</th>
            <th scope="col">Partner card</th>
            <th scope="col">By matches</th>
            <th scope="col">By unique decks</th>
          </tr>
        </thead>
        <tbody>
          {partners.map((entry, index) => (
            <tr key={index}>
              <td>{entry.commanderId}</td>
              <td>{entry.partnerCardId}</td>
              <td>
                {formatCardExplorerRate(entry.support)} ({entry.matchesIncludingBoth})
              </td>
              <td>
                {formatCardExplorerRate(entry.supportByUniqueDeck)} ({entry.decksIncludingBoth})
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function UnavailablePartitionsView({
  partitions,
}: {
  readonly partitions: readonly CardExplorerUnavailablePartition[];
}) {
  if (partitions.length === 0) return null;
  return (
    <ul className="results__limitations" role="note">
      {partitions.map((entry, index) => (
        <li key={index}>
          {entry.observedIn.source} · content v{entry.observedIn.contentVersion}: {entry.reason}
        </li>
      ))}
    </ul>
  );
}

function ExperimentEvidenceView({ view }: { readonly view: CardExplorerView }) {
  if (view.experimentEvidence === null) {
    return (
      <p className="panel__note" role="note">
        Draw/play/dead-hand evidence: not checked — name a job ID above to cross-check this card
        against its own replayed evidence.
      </p>
    );
  }
  if (view.experimentEvidence.row === null) {
    return (
      <Empty>
        Draw/play/dead-hand evidence: checked — the named job&apos;s own <code>cards</code> table
        has no row for this card.
      </Empty>
    );
  }
  return (
    <FactTable
      caption="Draw/play/dead-hand evidence"
      facts={resultRowFacts(view.experimentEvidence.row)}
    />
  );
}

function ContributingDecksView({
  decks,
}: {
  readonly decks: readonly CardExplorerContributingDeck[];
}) {
  if (decks.length === 0) {
    return <Empty>No contributing deck recorded for this card.</Empty>;
  }
  return (
    <div className="dashboard__heatmap-wrap">
      <table className="dashboard__bars">
        <caption className="visually-hidden">Contributing decks</caption>
        <thead>
          <tr>
            <th scope="col">Deck hash</th>
            <th scope="col">Commander</th>
          </tr>
        </thead>
        <tbody>
          {decks.map((entry) => (
            <tr key={entry.deckHash}>
              <td>{entry.deckHash}</td>
              <td>{entry.commanderId}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ContributingMatchesView({
  matches,
}: {
  readonly matches: readonly CardExplorerContributingMatch[];
}) {
  if (matches.length === 0) {
    return <Empty>No contributing match recorded for this card.</Empty>;
  }
  return (
    <div className="dashboard__heatmap-wrap">
      <table className="dashboard__bars">
        <caption className="visually-hidden">Contributing matches</caption>
        <thead>
          <tr>
            <th scope="col">Match</th>
            <th scope="col">Deck hash</th>
            <th scope="col">Commander</th>
          </tr>
        </thead>
        <tbody>
          {matches.map((entry) => (
            <tr key={entry.matchId}>
              <td>{entry.matchId}</td>
              <td>{entry.deckHash}</td>
              <td>{entry.commanderId}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
