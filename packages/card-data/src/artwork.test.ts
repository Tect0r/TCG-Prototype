import { describe, expect, it } from 'vitest';
import {
  artworkSources,
  cardArtUrl,
  DEFAULT_FALLBACK_ART_URL,
  fallbackArtUrl,
  nextArtworkSource,
} from './artwork.js';

describe('artwork resolution', () => {
  it('derives the art URL from the card ID alone', () => {
    expect(cardArtUrl('goblin_scout')).toBe('/card-art/goblin_scout.png');
  });

  it('honours a custom base URL and trims trailing slashes', () => {
    expect(cardArtUrl('goblin_scout', { artBaseUrl: 'https://cdn.example/art/' })).toBe(
      'https://cdn.example/art/goblin_scout.png',
    );
  });

  it('offers the card art first and the default image second', () => {
    expect(artworkSources('goblin_scout')).toEqual([
      '/card-art/goblin_scout.png',
      DEFAULT_FALLBACK_ART_URL,
    ]);
  });

  it('falls back to the default image when the card art fails', () => {
    expect(nextArtworkSource('/card-art/goblin_scout.png', 'goblin_scout')).toBe(
      DEFAULT_FALLBACK_ART_URL,
    );
  });

  it('gives up after the default image also fails', () => {
    expect(nextArtworkSource(DEFAULT_FALLBACK_ART_URL, 'goblin_scout')).toBeNull();
  });

  it('recovers to the fallback when handed an unrecognised source', () => {
    expect(nextArtworkSource('data:image/png;base64,zzz', 'goblin_scout')).toBe(
      DEFAULT_FALLBACK_ART_URL,
    );
  });

  it('allows overriding the fallback image', () => {
    expect(fallbackArtUrl({ fallbackUrl: '/x.png' })).toBe('/x.png');
    expect(nextArtworkSource('/card-art/a.png', 'a', { fallbackUrl: '/x.png' })).toBe('/x.png');
  });
});
