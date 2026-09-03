import type {
  LiveMatchEnvelope,
  LiveMatchRawEventArtifact,
  LiveMatchReplayArtifact,
} from '@tcg/match-telemetry';

/**
 * The ordinary live-match record, at whatever retention tier M08.21's policy kept
 * for this match. `rawEvent` and `replay` are `null` exactly when
 * `decideLiveMatchRetention` (M08.21B) chose not to keep that tier — their
 * presence is a retention decision already made, not a choice for a sink to
 * second-guess.
 */
export interface LiveMatchRecord {
  readonly envelope: LiveMatchEnvelope;
  readonly rawEvent: LiveMatchRawEventArtifact | null;
  readonly replay: LiveMatchReplayArtifact | null;
}

/**
 * Where a finished match's canonical record goes after the match server has
 * built it (M08.22).
 *
 * The general-purpose sibling of `BotSummarySink` (`./bot-match-summary.ts`):
 * same shape, same failure policy, a different record. `BotSummarySink` stays
 * exactly what M09.17 scoped it to — bot pacing and provenance, produced only
 * when a lobby has a bot seat — and never grows a second meaning to cover this.
 * A `LiveMatchSink` receives one record per match, of every source
 * (`human_human`, `human_ai`, `ai_ai` alike), because Player Meta needs to see
 * all of them and a live match server is the only place that record can be
 * built honestly.
 *
 * `receive` returns `void` and is called inside a `try`. A sink that throws is
 * recorded and stepped over: a match that has just ended must not fail to
 * report its own outcome because something downstream of it was unavailable.
 * This is the whole of that boundary — building the record from a finished
 * match (M08.22B) and the lifecycle that calls into it (M08.22C) are not this
 * slice's job.
 */
export interface LiveMatchSink {
  /** Names the sink in a diagnostic. Stable for the life of the implementation. */
  readonly sinkId: string;
  receive(record: LiveMatchRecord): void;
}
