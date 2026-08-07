import { useMemo } from 'react';
import {
  COLOR_INFO,
  NEUTRAL_INFO,
  type CardDatabase,
  type CardDefinition,
  type CardId,
} from '@tcg/card-data';
import {
  copyLimitFor,
  DEFAULT_DECK_FORMAT,
  removeUnresolvedCards,
  setCardQuantity,
  setCommander,
  validateDeck,
  type SavedDeck,
} from '@tcg/deck';
import { errorsOf, warningsOf } from '@tcg/shared';
import { CommanderPicker } from './CommanderPicker.js';
import { IssueList } from './IssueList.js';

interface DeckPanelProps {
  readonly deck: SavedDeck;
  readonly database: CardDatabase;
  readonly onChange: (deck: SavedDeck) => void;
}

interface ResolvedRow {
  readonly cardId: CardId;
  readonly quantity: number;
  readonly card: CardDefinition | undefined;
}

export function DeckPanel({ deck, database, onChange }: DeckPanelProps) {
  const report = useMemo(() => validateDeck(deck, database), [deck, database]);

  const rows = useMemo<ResolvedRow[]>(
    () =>
      deck.cards
        .map((entry) => ({
          cardId: entry.cardId,
          quantity: entry.quantity,
          card: database.get(entry.cardId),
        }))
        .sort((a, b) => {
          const costA = a.card?.cost ?? 99;
          const costB = b.card?.cost ?? 99;
          if (costA !== costB) return costA - costB;
          return (a.card?.name ?? a.cardId).localeCompare(b.card?.name ?? b.cardId);
        }),
    [deck.cards, database],
  );

  const { stats } = report;
  const errors = errorsOf(report.issues);
  const warnings = warningsOf(report.issues);
  const maxCurve = Math.max(1, ...Object.values(stats.costCurve));

  return (
    <section className="deck-panel" aria-label="Current deck">
      <CommanderPicker
        database={database}
        value={deck.commanderId}
        onChange={(commanderId) => onChange(setCommander(deck, commanderId))}
      />

      <div className="deck-panel__summary">
        <p className={`deck-panel__size${stats.totalCards === DEFAULT_DECK_FORMAT.deckSize ? ' is-complete' : ''}`}>
          <strong>{stats.totalCards}</strong> / {DEFAULT_DECK_FORMAT.deckSize} cards
        </p>
        <p className="deck-panel__identity">
          {stats.colorIdentity.length === 0 ? (
            <span className="swatch" style={{ background: NEUTRAL_INFO.swatch }} title={NEUTRAL_INFO.name} />
          ) : (
            stats.colorIdentity.map((color) => (
              <span
                key={color}
                className="swatch"
                style={{ background: COLOR_INFO[color].swatch }}
                title={COLOR_INFO[color].name}
              />
            ))
          )}
        </p>
        <p className={`deck-panel__legality${report.legal ? ' is-legal' : ''}`}>
          {report.legal ? 'Legal deck' : `${errors.length} problem${errors.length === 1 ? '' : 's'}`}
        </p>
      </div>

      <div className="deck-panel__curve" aria-label="Energy curve">
        {Array.from({ length: database.maxCost() + 1 }, (_, cost) => {
          const count = stats.costCurve[cost] ?? 0;
          return (
            <div key={cost} className="curve__column" title={`${count} card(s) at cost ${cost}`}>
              <div className="curve__bar" style={{ height: `${(count / maxCurve) * 100}%` }} />
              <span className="curve__label">{cost}</span>
            </div>
          );
        })}
      </div>

      {stats.unresolvedCardIds.length > 0 && (
        <div className="deck-panel__unresolved">
          <p>
            {stats.unresolvedCardIds.length} card ID
            {stats.unresolvedCardIds.length === 1 ? '' : 's'} in this deck no longer exist:{' '}
            {stats.unresolvedCardIds.map((id) => (
              <code key={id}>{id}</code>
            ))}
          </p>
          <button type="button" onClick={() => onChange(removeUnresolvedCards(deck, stats.unresolvedCardIds))}>
            Remove unresolved cards
          </button>
        </div>
      )}

      <ol className="deck-list">
        {rows.length === 0 && <li className="empty-state">No cards yet. Add some from the grid.</li>}
        {rows.map((row) => (
          <li key={row.cardId} className={`deck-list__row${row.card ? '' : ' is-unresolved'}`}>
            <span className="deck-list__quantity">{row.quantity}×</span>
            <span className="deck-list__cost">{row.card?.cost ?? '?'}</span>
            <span className="deck-list__name">{row.card?.name ?? row.cardId}</span>
            <span className="deck-list__buttons">
              <button
                type="button"
                aria-label={`Remove one ${row.card?.name ?? row.cardId}`}
                onClick={() => onChange(setCardQuantity(deck, row.cardId, row.quantity - 1))}
              >
                −
              </button>
              <button
                type="button"
                aria-label={`Add one ${row.card?.name ?? row.cardId}`}
                disabled={!row.card || row.quantity >= copyLimitFor(row.card)}
                onClick={() =>
                  onChange(
                    setCardQuantity(deck, row.cardId, row.quantity + 1, {
                      ...(row.card ? { limit: copyLimitFor(row.card) } : {}),
                    }),
                  )
                }
              >
                +
              </button>
            </span>
          </li>
        ))}
      </ol>

      <div className="deck-panel__validation">
        <h3>Validation</h3>
        <IssueList issues={[...errors, ...warnings]} emptyMessage="This deck is legal and ready to play." />
      </div>
    </section>
  );
}
