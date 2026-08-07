import { useEffect, useState } from 'react';
import { cardArtUrl, nextArtworkSource, type CardId } from '@tcg/card-data';

interface CardArtProps {
  readonly cardId: CardId;
  readonly alt: string;
}

/**
 * Card artwork with the documented fallback chain: the card's own PNG, then the
 * default image, then nothing at all. The frame around this never depends on
 * the image loading, so missing art degrades to a readable text-only card.
 */
export function CardArt({ cardId, alt }: CardArtProps) {
  const [src, setSrc] = useState<string | null>(() => cardArtUrl(cardId));

  // A recycled grid tile can be handed a different card; restart the chain.
  useEffect(() => setSrc(cardArtUrl(cardId)), [cardId]);

  // Both the card art and the default image failed: render an empty art well
  // rather than an `src=""`, which browsers resolve back to the page URL.
  if (src === null) return <div className="card-art card-art--empty" aria-hidden="true" />;

  return (
    <img
      className="card-art"
      src={src}
      alt={alt}
      loading="lazy"
      decoding="async"
      draggable={false}
      onError={() =>
        setSrc((current) => (current === null ? null : nextArtworkSource(current, cardId)))
      }
    />
  );
}
