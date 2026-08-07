# ADR 0004 — Artwork resolution and the card frame

**Status:** accepted · **Date:** 2026-08-07

## Context

Dropping a correctly named PNG into the artwork folder must require no data and
no code change, and missing artwork — which is the normal case during
development — must never produce a broken UI.

## Decision

### Discovery by ID

Artwork lives at `assets/card-art/<card_id>.png` and is resolved purely from the
card ID. There is no artwork field on `CardDefinition`, no manifest, and no
build-time index — any of which would reintroduce a step to forget.

Vite's `publicDir` points at the repo-level `assets/` folder, so the file is
served at `/card-art/<card_id>.png` in dev and copied verbatim into `dist/` on
build. The URL prefix is a parameter (`ArtworkResolverOptions`), so a CDN can be
swapped in later without touching components.

### Fallback chain

`artworkSources(cardId)` returns an ordered list, and `nextArtworkSource` walks
it on failure:

1. `/card-art/<card_id>.png`
2. `/defaults/default_card.png`
3. `null` — render an empty art well

Step 3 matters: setting `src=""` makes browsers re-request the page URL, which
is both a wasted request and a confusing image. The component renders a styled
empty div instead.

These are pure functions in `card-data`, so the chain is unit-tested without a
DOM, and the component test only has to verify it is wired up.

### The PNG is never the card

The frame renders name, energy cost, type line, tags, keywords, rules text,
role, power class and the statline as **live DOM**. Artwork occupies an art well
inside the frame. A card with no image is fully readable and fully functional —
covered by a test that fails both image loads and then asserts the name, type
line and statline are still present.

Standard art size is `768 × 1024 px`. `scripts/generate-placeholder-art.mjs`
emits the default image and a few sample arts at that size using only
`node:zlib`, so demonstrating the pipeline costs no image dependency.

## Consequences

- Adding art for a card is a file copy. Nothing else.
- Renaming a card's display name never breaks its artwork, because artwork
  follows the permanent ID.
- Card IDs appear in served URLs. They are non-secret by design.
