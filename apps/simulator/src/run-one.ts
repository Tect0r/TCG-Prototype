import type { PilotSpec } from '@tcg/bot-interface';
import type { Environment } from './environment.js';
import type { MatchLimits } from './run-match.js';
import { runMatch } from './run-match.js';
import { toMatchDeck, type SimDeck } from './deck-search/deck.js';
import type { WorkerJob } from './workers/protocol.js';
import {
  TELEMETRY_SCHEMA_VERSION,
  type MatchRecord,
  type ReplayBundle,
} from './telemetry/schema.js';

/**
 * Runs one scheduled match and, when asked, packages its replay.
 *
 * Shared verbatim by the sequential path and by the worker threads. There is
 * exactly one code path from "a scheduled match" to "a record", which is what
 * makes worker-count equivalence a structural property rather than something
 * two implementations have to agree on (CLAUDE.md §13.7).
 */

export interface RunOneOptions {
  readonly experimentId: string;
  readonly environment: Environment;
  readonly decks: readonly SimDeck[];
  readonly pilots: readonly PilotSpec[];
  readonly limits: MatchLimits;
  readonly retention: { readonly keepLogs: boolean; readonly keepDecisions: boolean };
  readonly softwareCommit: string | null;
  readonly job: WorkerJob;
}

export interface RunOneResult {
  readonly record: MatchRecord;
  readonly replay: ReplayBundle | null;
}

export async function runOne(options: RunOneOptions): Promise<RunOneResult> {
  const { job } = options;

  const outcome = await runMatch({
    experimentId: options.experimentId,
    environment: options.environment,
    matchId: job.matchId,
    orderKey: job.orderKey,
    deckPairId: job.deckPairId,
    variantKey: job.variantKey,
    gameIndex: job.gameIndex,
    orientation: job.orientation,
    seeds: job.seeds,
    limits: options.limits,
    softwareCommit: options.softwareCommit,
    seats: job.seats.map((seat) => {
      const deck = options.decks[seat.deckIndex];
      const pilot = options.pilots[seat.pilotIndex];
      if (!deck)
        throw new Error(`Schedule referenced deck index ${seat.deckIndex}, which is absent.`);
      if (!pilot) {
        throw new Error(`Schedule referenced pilot index ${seat.pilotIndex}, which is absent.`);
      }
      return {
        playerId: seat.playerId,
        deckId: deck.id,
        deckHash: deck.hash,
        deck: toMatchDeck(deck),
        pilot,
      };
    }),
  });

  // This is the memory boundary for a large run (CLAUDE.md §13.14): the match's
  // logs exist for the duration of the match, and only a sampled or abnormal
  // match keeps them past this point. An abnormal match always does, which is
  // only possible because the logs were collected before the classification.
  const keepReplay = job.keepReplay || outcome.abnormal || options.retention.keepLogs;
  if (!keepReplay) return { record: outcome.record, replay: null };

  const replay: ReplayBundle = {
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    matchId: job.matchId,
    record: { ...outcome.record, replayPath: `replays/${job.matchId}.json` },
    environment: options.environment.config,
    decks: job.seats.map((seat) => options.decks[seat.deckIndex] ?? null),
    pilots: job.seats.map((seat) => options.pilots[seat.pilotIndex] ?? null),
    actions: [...outcome.actions],
    events: [...outcome.events],
    // Per-decision pilot diagnostics are the bulkiest part of a bundle and are
    // only worth the bytes when something went wrong or the run asked for them.
    decisions: options.retention.keepDecisions || outcome.abnormal ? [...outcome.decisions] : [],
  };

  return { record: replay.record, replay };
}
