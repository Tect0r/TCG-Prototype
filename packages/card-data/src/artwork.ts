import type { CardId } from './schema/primitives.js';

/**
 * Artwork is discovered purely by card ID, so dropping a correctly named PNG
 * into the art folder needs no data or code change (CLAUDE.md §6).
 *
 * On disk:   assets/card-art/<card_id>.png
 * Served at: <artBaseUrl>/<card_id>.png
 */
export const CARD_ART_ASPECT_RATIO = 768 / 1024;
export const CARD_ART_WIDTH_PX = 768;
export const CARD_ART_HEIGHT_PX = 1024;

export const DEFAULT_ART_BASE_URL = '/card-art';
export const DEFAULT_FALLBACK_ART_URL = '/defaults/default_card.png';

export interface ArtworkResolverOptions {
  readonly artBaseUrl?: string;
  readonly fallbackUrl?: string;
}

/** Candidate URL for a card's own artwork. May or may not exist. */
export function cardArtUrl(cardId: CardId, options: ArtworkResolverOptions = {}): string {
  const base = (options.artBaseUrl ?? DEFAULT_ART_BASE_URL).replace(/\/+$/, '');
  return `${base}/${cardId}.png`;
}

export function fallbackArtUrl(options: ArtworkResolverOptions = {}): string {
  return options.fallbackUrl ?? DEFAULT_FALLBACK_ART_URL;
}

/**
 * Ordered sources to try. The renderer walks this list on load failure, so a
 * missing or broken PNG degrades to the default image instead of a broken UI.
 */
export function artworkSources(
  cardId: CardId,
  options: ArtworkResolverOptions = {},
): readonly [string, string] {
  return [cardArtUrl(cardId, options), fallbackArtUrl(options)];
}

/**
 * Given the source that just failed, returns the next one to try, or `null`
 * when the fallback itself failed and the UI should render a text-only frame.
 */
export function nextArtworkSource(
  failedSource: string,
  cardId: CardId,
  options: ArtworkResolverOptions = {},
): string | null {
  const sources = artworkSources(cardId, options);
  const index = sources.indexOf(failedSource);
  if (index === -1) return sources[1];
  return sources[index + 1] ?? null;
}
