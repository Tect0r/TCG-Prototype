import {
  COLOR_INFO,
  KEYWORD_INFO,
  NEUTRAL_INFO,
  POWER_CLASS_NAMES,
  ROLE_NAMES,
  type CardDefinition,
} from '@tcg/card-data';
import { CardArt } from './CardArt.js';

/**
 * The standard rendered card frame. Artwork sits in the art well; every piece
 * of game information is live UI text, so a card stays fully readable with no
 * PNG at all (CLAUDE.md §6).
 */

export function colorBarStyle(card: CardDefinition): { background: string } {
  if (card.colorIdentity.length === 0) return { background: NEUTRAL_INFO.swatch };
  const stops = card.colorIdentity.map((color) => COLOR_INFO[color].swatch);
  if (stops.length === 1) return { background: stops[0]! };
  return { background: `linear-gradient(90deg, ${stops.join(', ')})` };
}

function typeLine(card: CardDefinition): string {
  const type = card.type.charAt(0).toUpperCase() + card.type.slice(1);
  return card.tags.length > 0 ? `${type} — ${card.tags.join(', ')}` : type;
}

interface CardFrameProps {
  readonly card: CardDefinition;
  /** Copies currently in the deck, shown as a badge when above zero. */
  readonly copies?: number;
  readonly compact?: boolean;
}

export function CardFrame({ card, copies = 0, compact = false }: CardFrameProps) {
  const hasStats = card.attack !== undefined && card.health !== undefined;

  return (
    <article className={`card-frame${compact ? ' card-frame--compact' : ''}`}>
      <div className="card-frame__colors" style={colorBarStyle(card)} aria-hidden="true" />

      <header className="card-frame__header">
        <h3 className="card-frame__name" title={card.name}>
          {card.name}
        </h3>
        <span
          className="card-frame__cost"
          aria-label={card.cost === null ? 'No energy cost' : `${card.cost} energy`}
        >
          {card.cost ?? '—'}
        </span>
      </header>

      <div className="card-frame__art-well">
        <CardArt cardId={card.id} alt="" />
        {copies > 0 && (
          <span className="card-frame__copies" aria-label={`${copies} in deck`}>
            ×{copies}
          </span>
        )}
        {card.unique && (
          <span className="card-frame__unique" title="Unique — one copy per deck">
            Unique
          </span>
        )}
      </div>

      <p className="card-frame__type">{typeLine(card)}</p>

      <div className="card-frame__text">
        {card.keywords.length > 0 && (
          <p className="card-frame__keywords">
            {card.keywords.map((keyword) => (
              <span key={keyword} className="keyword-chip" title={KEYWORD_INFO[keyword].reminder}>
                {KEYWORD_INFO[keyword].name}
              </span>
            ))}
          </p>
        )}
        {card.displayText && <p className="card-frame__rules">{card.displayText}</p>}
      </div>

      <footer className="card-frame__footer">
        <span className="card-frame__meta">
          {[
            card.role && ROLE_NAMES[card.role],
            card.powerClass && POWER_CLASS_NAMES[card.powerClass],
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
        {hasStats && (
          <span
            className="card-frame__stats"
            aria-label={`${card.attack} attack, ${card.health} health`}
          >
            {card.attack}/{card.health}
          </span>
        )}
      </footer>
    </article>
  );
}
