/**
 * The simulator's content-addressing entry point.
 *
 * The primitives themselves moved to `@tcg/deck-generator` in M09.8, because
 * deck identity is part of what a generated deck *is* and the generator had to
 * take it with it. This module stays because the simulator hashes far more than
 * decks — environments, configurations, match records, schedules — and every one
 * of those addresses has to be taken by the same function as every other, or two
 * runs that agree on their content would disagree on its name.
 *
 * Re-exported rather than reimplemented for exactly that reason: one
 * implementation, one `HASH_VERSION`, no way for the two to drift.
 */

export {
  HASH_VERSION,
  canonicalJson,
  deckHash,
  digest,
  digestOf,
  type HashableDeck,
} from '@tcg/deck-generator';
