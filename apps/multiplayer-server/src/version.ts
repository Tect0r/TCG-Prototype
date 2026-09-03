/**
 * What build of this server produced a given live-match record.
 *
 * A string because `liveMatchProvenanceSchema.softwareVersion` is a string
 * (`packages/match-telemetry/src/schema.ts`): a recorded match cites the build
 * that ran it, and a citation nobody can compare to anything is not
 * provenance. The precedent is `DECK_GENERATOR_VERSION`
 * (`packages/deck-generator/src/version.ts`) — a small, hand-bumped constant
 * rather than a package version or a git hash, because neither of those
 * changes only when something a reader of an old record actually needs to
 * know about changes.
 *
 * Bump when something that shapes how a live match is *played or recorded*
 * changes in a way that would make an old record ambiguous alongside a new
 * one — not for an unrelated refactor, a new test, or a move between files.
 *
 * - `1` — M08.22C. The first build that records a live match at all.
 */
export const LIVE_MATCH_SOFTWARE_VERSION = '1';
