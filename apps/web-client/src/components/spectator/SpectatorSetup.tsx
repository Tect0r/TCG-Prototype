import { useMemo, useState } from 'react';
import {
  randomSeed,
  resolveSpectatorSetup,
  spectatorPrecons,
  SPECTATOR_PILOT_IDS,
  type SpectatorSetup as SetupConfig,
  type SpectatorSetupSeat,
} from '@tcg/spectator';
import type { PilotId } from '@tcg/bot-interface';

/**
 * The AI Spectator entry point: choose seats, decks, pilots and a seed, then
 * start (rule adjustment, "Match setup").
 *
 * Everything here is a *configuration*, not a match. Nothing is simulated until
 * Start is pressed, and the seed is visible and editable before then — which is
 * what makes "the same seed and deck configuration reproduce the same match"
 * something a user can actually use rather than an internal property.
 */

export interface SpectatorSetupProps {
  readonly busy: boolean;
  readonly onStart: (setup: SetupConfig) => void;
  /** Loads a previously saved replay instead of playing a new match. */
  readonly onLoadReplay: (json: string) => void;
  readonly error: string | null;
}

const PLAYER_COUNTS = [2, 3, 4] as const;

export function SpectatorSetup({ busy, onStart, onLoadReplay, error }: SpectatorSetupProps) {
  const precons = useMemo(() => spectatorPrecons(), []);
  const [seed, setSeed] = useState<string>(() => randomSeed());
  const [playerCount, setPlayerCount] = useState<number>(4);
  const [allowIncomplete, setAllowIncomplete] = useState(false);
  const [seats, setSeats] = useState<SpectatorSetupSeat[]>(() =>
    Array.from({ length: 4 }, (_, index) => ({
      preconId: precons[index % Math.max(1, precons.length)]?.id ?? '',
      pilotId: (SPECTATOR_PILOT_IDS[index % SPECTATOR_PILOT_IDS.length] ?? 'value') as PilotId,
    })),
  );

  const active = seats.slice(0, playerCount);
  const setup: SetupConfig = {
    seed,
    seats: active,
    ...(allowIncomplete ? { developerAllowIncompleteCards: true } : {}),
  };
  const resolved = resolveSpectatorSetup(setup);
  const problems = resolved.problems;
  // Whether the override is doing anything *for this configuration*, which is
  // not the same as whether the box is ticked.
  const overriding = resolved.incompleteCards.length > 0;

  const updateSeat = (index: number, patch: Partial<SpectatorSetupSeat>): void => {
    setSeats((current) =>
      current.map((seat, seatIndex) => (seatIndex === index ? { ...seat, ...patch } : seat)),
    );
  };

  return (
    <section className="spectator-setup" aria-label="AI Spectator setup">
      <header className="spectator-setup__header">
        <h2>AI Spectator</h2>
        <p className="spectator-setup__lede">
          Watch two to four bots play a complete match at a readable pace. Nothing here affects your
          saved decks or an online game.
        </p>
      </header>

      <div className="spectator-setup__row">
        <label htmlFor="spectator-players">Players</label>
        <select
          id="spectator-players"
          value={playerCount}
          onChange={(event) => setPlayerCount(Number(event.target.value))}
          disabled={busy}
        >
          {PLAYER_COUNTS.map((count) => (
            <option key={count} value={count}>
              {count} bots
            </option>
          ))}
        </select>

        <label htmlFor="spectator-seed">Seed</label>
        <input
          id="spectator-seed"
          value={seed}
          onChange={(event) => setSeed(event.target.value)}
          disabled={busy}
          spellCheck={false}
        />
        <button type="button" onClick={() => setSeed(randomSeed())} disabled={busy}>
          Randomise
        </button>
      </div>

      <ol className="spectator-setup__seats">
        {active.map((seat, index) => (
          <li key={index} className="spectator-setup__seat">
            <span className="spectator-setup__seat-label">Bot {index + 1}</span>
            <label className="spectator-setup__field">
              <span>Precon</span>
              <select
                value={seat.preconId}
                onChange={(event) => updateSeat(index, { preconId: event.target.value })}
                disabled={busy}
                aria-label={`Bot ${index + 1} precon`}
              >
                {precons.map((precon) => (
                  <option key={precon.id} value={precon.id}>
                    {precon.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="spectator-setup__field">
              <span>Strategy</span>
              <select
                value={seat.pilotId}
                onChange={(event) => updateSeat(index, { pilotId: event.target.value as PilotId })}
                disabled={busy}
                aria-label={`Bot ${index + 1} strategy`}
              >
                {SPECTATOR_PILOT_IDS.map((pilotId) => (
                  <option key={pilotId} value={pilotId}>
                    {pilotId.replace(/_/g, ' ')}
                  </option>
                ))}
              </select>
            </label>
          </li>
        ))}
      </ol>

      {/* Duplicates are allowed on purpose: watching one precon against itself
          is a legitimate way to look at a mirror. */}
      <p className="spectator-setup__note">The same precon may be given to more than one bot.</p>

      {/* The override is offered here rather than hidden behind a build flag so
          a developer can reach it — and cannot reach it without reading what it
          costs (M01.2). It never relaxes deck legality, only completeness. */}
      <label className="spectator-setup__override">
        <input
          type="checkbox"
          checked={allowIncomplete}
          onChange={(event) => setAllowIncomplete(event.target.checked)}
          disabled={busy}
        />
        <span>Developer: run decks containing cards that are not implemented yet</span>
      </label>

      {problems.length > 0 && (
        <ul className="spectator-setup__problems" role="alert">
          {problems.map((problem) => (
            <li key={problem.seatIndex}>
              Bot {problem.seatIndex + 1}: {problem.message}
            </li>
          ))}
        </ul>
      )}

      {overriding && (
        <div className="spectator-setup__invalid" role="alert">
          <strong>Results invalid.</strong> These decks contain cards whose printed behaviour is not
          implemented yet. The match will run, but what happens is not what those cards say, so it
          is not evidence about the game.
          <ul>
            {resolved.incompleteCards.map((seat) => (
              <li key={seat.seatIndex}>
                Bot {seat.seatIndex + 1}: {seat.cardIds.join(', ')}
              </li>
            ))}
          </ul>
        </div>
      )}
      {error && (
        <p className="spectator-setup__problems" role="alert">
          {error}
        </p>
      )}

      <div className="spectator-setup__actions">
        <button
          type="button"
          className="spectator-setup__start"
          onClick={() => onStart(setup)}
          disabled={busy || problems.length > 0}
        >
          {busy ? 'Playing the match…' : 'Start Match'}
        </button>

        <label className="spectator-setup__load">
          <span>Load a saved replay</span>
          <input
            type="file"
            accept="application/json,.json"
            disabled={busy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              void file.text().then(onLoadReplay);
              // Clear, so re-picking the same file fires again.
              event.target.value = '';
            }}
          />
        </label>
      </div>
    </section>
  );
}
