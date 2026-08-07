import type { CardDefinition } from '@tcg/card-data';
import { CardFrame } from './CardFrame.js';

export interface CardGridEntry {
  readonly card: CardDefinition;
  readonly copies: number;
  /** Why this card cannot be added right now, if it cannot. */
  readonly blockedReason: string | null;
}

interface CardGridProps {
  readonly entries: readonly CardGridEntry[];
  readonly onAdd: (card: CardDefinition) => void;
  readonly onRemove: (card: CardDefinition) => void;
  readonly emptyMessage: string;
}

export function CardGrid({ entries, onAdd, onRemove, emptyMessage }: CardGridProps) {
  if (entries.length === 0) {
    return <p className="empty-state">{emptyMessage}</p>;
  }

  return (
    <ul className="card-grid">
      {entries.map(({ card, copies, blockedReason }) => (
        <li key={card.id} className="card-grid__item">
          <CardFrame card={card} copies={copies} />
          <div className="card-grid__actions">
            <button
              type="button"
              onClick={() => onRemove(card)}
              disabled={copies === 0}
              aria-label={`Remove one ${card.name}`}
            >
              −
            </button>
            <button
              type="button"
              className="primary"
              onClick={() => onAdd(card)}
              disabled={blockedReason !== null}
              title={blockedReason ?? undefined}
              aria-label={`Add one ${card.name}`}
            >
              + Add
            </button>
          </div>
          {blockedReason && <p className="card-grid__blocked">{blockedReason}</p>}
        </li>
      ))}
    </ul>
  );
}
