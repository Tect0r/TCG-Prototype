import { useMemo, useState } from 'react';
import {
  COLOR_INFO,
  NEUTRAL_INFO,
  preconsForFormat,
  type CardDatabase,
  type CardDefinition,
  type ColorId,
  type PreconDefinition,
} from '@tcg/card-data';
import { reviewPrecon, type DeckFormatConfig } from '@tcg/deck';
import { useDialog } from './help/useDialog.js';
import { IssueList } from './IssueList.js';
import { useAppActions, useCardDatabase, useDeckFormat } from '../state/AppContext.js';

/**
 * The built-in precons, as starting points in the deck builder.
 *
 * Precons are content, not fixtures: this panel lists whatever
 * `content/precons/` declares for the *active* format, addressed by permanent
 * ID. It never edits one — "use this deck" copies it into an ordinary saved
 * deck (ADR 0016 §3) — and it never hides a problem: a precon that cannot be
 * played here is still listed, with the reasons, rather than filtered away.
 */

interface PreconRow {
  readonly cardId: string;
  readonly card: CardDefinition | undefined;
}

/** Cheapest first, then alphabetical: the order a deck list is normally read in. */
function sortRows(cardIds: readonly string[], database: CardDatabase): PreconRow[] {
  return cardIds
    .map((cardId) => ({ cardId, card: database.get(cardId) }))
    .sort((a, b) => {
      const costA = a.card?.cost ?? 99;
      const costB = b.card?.cost ?? 99;
      if (costA !== costB) return costA - costB;
      return (a.card?.name ?? a.cardId).localeCompare(b.card?.name ?? b.cardId);
    });
}

function Swatches({ colors }: { readonly colors: readonly ColorId[] }) {
  if (colors.length === 0) {
    return (
      <span
        className="swatch"
        style={{ background: NEUTRAL_INFO.swatch }}
        title={NEUTRAL_INFO.name}
      />
    );
  }
  return (
    <>
      {colors.map((color) => (
        <span
          key={color}
          className="swatch"
          style={{ background: COLOR_INFO[color].swatch }}
          title={COLOR_INFO[color].name}
        />
      ))}
    </>
  );
}

function PreconDetail({
  precon,
  database,
  format,
}: {
  readonly precon: PreconDefinition;
  readonly database: CardDatabase;
  readonly format: DeckFormatConfig;
}) {
  const review = useMemo(() => reviewPrecon(precon, database, format), [precon, database, format]);
  const commander = database.get(precon.commanderId);
  const rows = useMemo(() => sortRows(precon.cardIds, database), [precon, database]);

  return (
    <div className="precons__detail">
      <h3>{precon.name}</h3>
      <p className="precons__strategy">{precon.strategy}</p>
      <p className="precons__ids" data-testid="precon-ids">
        <code>{precon.id}</code>
        <code>{precon.formatId}</code>
      </p>

      <div className="precons__commander">
        <h4>Commander</h4>
        {commander ? (
          <p>
            <span className="precons__cost">{commander.cost}</span>
            <span className="precons__name">{commander.name}</span>
            <Swatches colors={commander.colorIdentity} />
          </p>
        ) : (
          <p className="precons__missing">
            <code>{precon.commanderId}</code> is not in this pool.
          </p>
        )}
      </div>

      <h4>
        Deck list <span data-testid="precon-size">{precon.cardIds.length} cards</span>
      </h4>
      <ol className="precons__list" aria-label={`${precon.name} deck list`}>
        {rows.map((row) => (
          <li key={row.cardId} className={row.card ? '' : 'is-unresolved'}>
            <span className="precons__cost">{row.card?.cost ?? '?'}</span>
            <span className="precons__name">{row.card?.name ?? row.cardId}</span>
            <span className="precons__type">{row.card?.type ?? 'unknown card'}</span>
          </li>
        ))}
      </ol>

      <div className="precons__validation">
        <h4>Legality</h4>
        <IssueList
          issues={review.issues}
          emptyMessage="Ready to play: every card resolves in this format and is implemented."
        />
      </div>
    </div>
  );
}

export interface PreconBrowserProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

export function PreconBrowser({ open, onClose }: PreconBrowserProps) {
  const database = useCardDatabase();
  const format = useDeckFormat();
  const actions = useAppActions();
  const panelRef = useDialog(open, onClose);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Scoped by format, so a development fixture deck can never appear beside
  // Wave 1 — the same rule the card pool itself is built with (M01.1), and the
  // same shared list the lobby picker and the match server use (M03.2).
  const precons = useMemo(() => preconsForFormat(format.formatId), [format.formatId]);

  const selected = precons.find((precon) => precon.id === selectedId) ?? precons[0];

  if (!open) return null;

  return (
    <div className="rulebook__backdrop" role="presentation">
      <div
        className="precons"
        role="dialog"
        aria-modal="true"
        aria-label="Precon decks"
        tabIndex={-1}
        ref={panelRef}
      >
        <header className="precons__header">
          <h2>Precon decks</h2>
          <p className="precons__subtitle">
            Built-in starting points for <code>{format.formatId}</code>. Copying one makes an
            ordinary deck you can edit; the precon itself never changes.
          </p>
          <button type="button" onClick={onClose} aria-label="Close the precon browser">
            Close
          </button>
        </header>

        {precons.length === 0 ? (
          <p className="precons__empty">
            No built-in precons are published for <code>{format.formatId}</code>.
          </p>
        ) : (
          <div className="precons__body">
            <nav className="precons__index" aria-label="Available precons">
              <ul>
                {precons.map((precon) => (
                  <li key={precon.id}>
                    <button
                      type="button"
                      className={precon.id === selected?.id ? 'is-active' : ''}
                      aria-pressed={precon.id === selected?.id}
                      onClick={() => setSelectedId(precon.id)}
                    >
                      <span className="precons__name">{precon.name}</span>
                      <Swatches colors={database.get(precon.commanderId)?.colorIdentity ?? []} />
                    </button>
                  </li>
                ))}
              </ul>
            </nav>

            {selected && <PreconDetail precon={selected} database={database} format={format} />}
          </div>
        )}

        {selected && (
          <footer className="precons__footer">
            <button
              type="button"
              className="primary"
              onClick={() => {
                actions.copyPrecon(selected);
                onClose();
              }}
            >
              Copy “{selected.name}” to a new deck
            </button>
          </footer>
        )}
      </div>
    </div>
  );
}
