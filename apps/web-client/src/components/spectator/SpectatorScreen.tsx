import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_RULES_CONFIG, type PlayerId } from '@tcg/rules-engine';
import {
  cardPoolHash,
  checkReplayCompatibility,
  replayFormatVersion,
  resolveSpectatorSetup,
  runSpectatorMatch,
  setupProvenance,
  spectatorDatabase,
  spectatorReplaySchema,
  SPECTATOR_REPLAY_VERSION,
  SpectatorPlayback,
  stepDelayMs,
  type InformationMode,
  type PlaybackSpeed,
  type SpectatorReplay,
  type SpectatorSetup as SetupConfig,
} from '@tcg/spectator';
import { SpectatorBoard } from './SpectatorBoard.js';
import { SpectatorControls } from './SpectatorControls.js';
import { SpectatorSetup } from './SpectatorSetup.js';
import { SpectatorSummary } from './SpectatorSummary.js';

/**
 * AI Spectator mode (rule adjustment, Part 2).
 *
 * The flow the update prescribes, in order: configure seats, run the
 * authoritative match at full speed, then reveal the finished replay through the
 * UI at playback speed.
 *
 * Nothing here participates in the match. By the time this component shows
 * anything, the match is over and recorded — so a viewer changing speed,
 * pausing, or switching to Analysis Mode is changing what is *displayed* and
 * provably nothing else.
 */

type Phase = 'setup' | 'running' | 'watching';

export function SpectatorScreen() {
  const database = useMemo(() => spectatorDatabase(), []);
  const poolHash = useMemo(() => cardPoolHash(database), [database]);

  const [phase, setPhase] = useState<Phase>('setup');
  const [replay, setReplay] = useState<SpectatorReplay | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [position, setPosition] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<PlaybackSpeed>('1x');
  const [mode, setMode] = useState<InformationMode>('normal');

  const playback = useMemo(
    () =>
      replay ? new SpectatorPlayback(replay, { database, config: DEFAULT_RULES_CONFIG }) : null,
    [replay, database],
  );

  const total = playback?.groupCount ?? 0;
  const atEnd = position >= total - 1;
  const frame = playback?.frameAt(position) ?? null;

  /* ------------------------------------------------------------- the timer */

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (!playing || !playback || atEnd) return;

    const delay = stepDelayMs(playback.groups[position + 1], speed);
    // The only place a clock touches anything, and all it does is choose when
    // to increment an index into a list that already exists.
    timer.current = setTimeout(() => setPosition((current) => current + 1), delay);

    return () => {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [playing, playback, position, speed, atEnd]);

  useEffect(() => {
    if (atEnd) setPlaying(false);
  }, [atEnd]);

  /* ------------------------------------------------------------- starting */

  const start = useCallback(
    (setup: SetupConfig) => {
      const resolved = resolveSpectatorSetup(setup, { database });
      if (resolved.problems.length > 0) {
        setError(resolved.problems.map((problem) => problem.message).join(' '));
        return;
      }
      setError(null);
      setPhase('running');

      // Yield a frame first so the "playing the match…" state actually paints
      // before the run blocks the main thread.
      void Promise.resolve()
        .then(() =>
          runSpectatorMatch({
            seed: setup.seed,
            seats: resolved.seats,
            database,
            config: DEFAULT_RULES_CONFIG,
            cardDataHash: poolHash,
            // Derived from the resolved setup, never from the checkbox: a run
            // that contained an unimplemented card says so for good.
            provenance: setupProvenance(resolved),
          }),
        )
        .then((result) => {
          setReplay(result);
          setPosition(-1);
          setPlaying(true);
          setPhase('watching');
        })
        .catch((cause: unknown) => {
          setError(cause instanceof Error ? cause.message : String(cause));
          setPhase('setup');
        });
    },
    [database, poolHash],
  );

  const loadReplay = useCallback(
    (json: string) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(json);
      } catch {
        setError('That file is not valid JSON.');
        return;
      }
      const result = spectatorReplaySchema.safeParse(parsed);
      if (!result.success) {
        // A replay from an earlier build is refused, not migrated (M04.1): its
        // telemetry was recorded before the shared board measurements existed,
        // and re-deriving them here would present numbers under the identity of
        // a build that never asserted them. Said as its own message, because
        // "this is not a replay" would be untrue and unhelpful.
        const version = replayFormatVersion(parsed);
        setError(
          version !== null && version !== SPECTATOR_REPLAY_VERSION
            ? `That replay is format version ${version}; this build records version ` +
                `${SPECTATOR_REPLAY_VERSION}. An older replay is refused rather than played ` +
                'back approximately.'
            : `That file is not a spectator replay: ${result.error.issues[0]?.message ?? ''}`,
        );
        return;
      }
      // An incompatible replay is refused outright. Playing it back "as well as
      // we can" would show a match that never happened.
      const problems = checkReplayCompatibility(result.data, {
        rulesVersion: DEFAULT_RULES_CONFIG.version,
        cardDataHash: poolHash,
      });
      if (problems.length > 0) {
        setError(
          'That replay was recorded against a different build and cannot be played back: ' +
            problems
              .map(
                (problem) =>
                  `${problem.field} was ${problem.found}, this build is ${problem.expected}`,
              )
              .join('; '),
        );
        return;
      }
      setError(null);
      setReplay(result.data);
      setPosition(-1);
      setPlaying(false);
      setPhase('watching');
    },
    [poolHash],
  );

  const save = useCallback(() => {
    if (!replay) return;
    const blob = new Blob([JSON.stringify(replay, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${replay.matchId}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }, [replay]);

  /* --------------------------------------------------------------- render */

  if (phase !== 'watching' || !replay || !playback || !frame) {
    return (
      <SpectatorSetup
        busy={phase === 'running'}
        onStart={start}
        onLoadReplay={loadReplay}
        error={error}
      />
    );
  }

  const visibleHands: Record<PlayerId, readonly string[]> = {};
  for (const seat of replay.seats) {
    visibleHands[seat.playerId] = playback.handFor(frame, seat.playerId, mode);
  }

  const highlight = new Set(frame.group?.highlightInstanceIds ?? []);
  const decision = mode === 'analysis' ? playback.decisionFor(frame.group) : null;
  const log = playback.logUpTo(position);

  return (
    <div className="spectator">
      {/* Persistent, not dismissible, and above the board: a viewer must never
          be able to look at this match without knowing it does not count. */}
      {!replay.provenance.resultsValid && (
        <div className="spectator__invalid" role="alert">
          <strong>Results invalid.</strong> This match was run under the developer override, with
          cards whose printed behaviour is not implemented yet. What happens here is not what those
          cards say, so it is not evidence about the game.
          <ul>
            {replay.provenance.incompleteCards.map((seat) => (
              <li key={seat.playerId}>
                {replay.seats.find((entry) => entry.playerId === seat.playerId)?.name ??
                  seat.playerId}
                : {seat.cardIds.join(', ')}
              </li>
            ))}
          </ul>
        </div>
      )}

      <SpectatorControls
        playing={playing}
        atStart={position <= -1}
        atEnd={atEnd}
        speed={speed}
        mode={mode}
        position={position}
        total={total}
        onPlayPause={() => setPlaying((current) => !current)}
        onStep={() => {
          setPlaying(false);
          setPosition((current) => Math.min(current + 1, total - 1));
        }}
        onRestart={() => {
          setPlaying(false);
          setPosition(-1);
        }}
        onJumpToEnd={() => {
          setPlaying(false);
          setPosition(total - 1);
        }}
        onSpeed={setSpeed}
        onMode={setMode}
        onExit={() => {
          setPlaying(false);
          setReplay(null);
          setPhase('setup');
        }}
        onSave={save}
      />

      <p className="spectator__status" aria-live="polite">
        Turn {frame.state.turn} · {frame.state.phase.replace(/_/g, ' ')} ·{' '}
        {replay.seats.find((seat) => seat.playerId === frame.state.activePlayerId)?.name ??
          frame.state.activePlayerId}
        {frame.state.reactionWindow && !frame.state.reactionWindow.closed && (
          <>
            {' '}
            · priority:{' '}
            {replay.seats.find(
              (seat) =>
                seat.playerId ===
                frame.state.reactionWindow?.priorityOrder[frame.state.reactionWindow.priorityIndex],
            )?.name ?? '—'}
          </>
        )}
      </p>

      <p className="spectator__caption">{frame.group?.summary ?? 'The match is about to begin.'}</p>

      <SpectatorBoard
        state={frame.state}
        seats={replay.seats}
        database={database}
        mode={mode}
        visibleHands={visibleHands}
        highlight={highlight}
      />

      {decision && (
        <section className="spectator__decision" aria-label="Bot decision">
          <h4>Why</h4>
          <p>
            {replay.seats.find((seat) => seat.playerId === decision.playerId)?.name ??
              decision.playerId}{' '}
            chose <code>{decision.chosenKey ?? 'an action'}</code> from {decision.candidateCount}{' '}
            candidate(s){decision.usedFallback ? ' (fallback after a pilot failure)' : ''}.
          </p>
          {decision.scores.length > 0 && (
            <ol className="spectator__scores">
              {[...decision.scores]
                .sort((left, right) => right.score - left.score)
                .slice(0, 6)
                .map((entry) => (
                  <li
                    key={entry.key}
                    className={entry.key === decision.chosenKey ? 'is-chosen' : ''}
                  >
                    <code>{entry.key}</code> <span>{entry.score.toFixed(2)}</span>
                  </li>
                ))}
            </ol>
          )}
          {decision.notes.length > 0 && (
            <ul className="spectator__notes">
              {decision.notes.map((note, index) => (
                <li key={index}>{note}</li>
              ))}
            </ul>
          )}
        </section>
      )}

      <ol className="spectator__log" aria-label="Match log">
        {log.map((group) => (
          <li key={group.index} className={group.index === position ? 'is-current' : ''}>
            {group.summary}
          </li>
        ))}
      </ol>

      {atEnd && <SpectatorSummary replay={replay} />}
    </div>
  );
}
