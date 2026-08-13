import {
  INFORMATION_MODES,
  PLAYBACK_SPEEDS,
  type InformationMode,
  type PlaybackSpeed,
} from '@tcg/spectator';

/**
 * Playback transport (rule adjustment, "Playback controls").
 *
 * Play/pause, step, restart, speed and Instant, plus the information-mode
 * switch. Every control here only changes *which precomputed frame is showing*
 * — none of them can reach the engine, the pilots or the replay, which is what
 * makes "pause, step, restart, speed change and Instant preserve event order"
 * true by construction.
 */

export interface SpectatorControlsProps {
  readonly playing: boolean;
  readonly atStart: boolean;
  readonly atEnd: boolean;
  readonly speed: PlaybackSpeed;
  readonly mode: InformationMode;
  readonly position: number;
  readonly total: number;
  /** Token stacking, on by default (M06.1/M06.3). Presentation only. */
  readonly grouping: boolean;
  readonly onGrouping: (grouping: boolean) => void;
  readonly onPlayPause: () => void;
  readonly onStep: () => void;
  readonly onRestart: () => void;
  readonly onJumpToEnd: () => void;
  readonly onSpeed: (speed: PlaybackSpeed) => void;
  readonly onMode: (mode: InformationMode) => void;
  readonly onExit: () => void;
  readonly onSave: () => void;
}

const MODE_LABELS: Readonly<Record<InformationMode, string>> = {
  normal: 'Normal Spectator',
  analysis: 'Analysis Mode',
};

export function SpectatorControls({
  playing,
  atStart,
  atEnd,
  speed,
  mode,
  position,
  total,
  grouping,
  onGrouping,
  onPlayPause,
  onStep,
  onRestart,
  onJumpToEnd,
  onSpeed,
  onMode,
  onExit,
  onSave,
}: SpectatorControlsProps) {
  return (
    <div className="spectator-controls" role="group" aria-label="Playback controls">
      <button type="button" onClick={onPlayPause} disabled={atEnd}>
        {playing ? 'Pause' : 'Play'}
      </button>
      <button type="button" onClick={onStep} disabled={atEnd}>
        Step
      </button>
      <button type="button" onClick={onRestart} disabled={atStart && !playing}>
        Restart
      </button>
      <button type="button" onClick={onJumpToEnd} disabled={atEnd}>
        Skip to result
      </button>

      <label className="spectator-controls__field">
        <span>Speed</span>
        <select
          value={speed}
          onChange={(event) => onSpeed(event.target.value as PlaybackSpeed)}
          aria-label="Playback speed"
        >
          {PLAYBACK_SPEEDS.map((option) => (
            <option key={option} value={option}>
              {option === 'instant' ? 'Instant' : option}
            </option>
          ))}
        </select>
      </label>

      <label className="spectator-controls__field">
        <span>View</span>
        <select
          value={mode}
          onChange={(event) => onMode(event.target.value as InformationMode)}
          aria-label="Information mode"
        >
          {INFORMATION_MODES.map((option) => (
            <option key={option} value={option}>
              {MODE_LABELS[option]}
            </option>
          ))}
        </select>
      </label>

      {/* The same toggle the match board carries, for the same reason: "grouping
          on and off are the same match" is an acceptance criterion, and a
          viewer has to be able to check it by watching. It changes no frame,
          no replay and no telemetry — the match was over before this screen
          rendered anything. */}
      <button
        type="button"
        className={grouping ? 'is-active' : ''}
        aria-pressed={grouping}
        onClick={() => onGrouping(!grouping)}
      >
        Stack tokens
      </button>

      <span className="spectator-controls__position" aria-live="polite">
        step {Math.max(0, position + 1)} / {total}
      </span>

      <div className="spectator-controls__spacer" />
      <button type="button" onClick={onSave}>
        Save replay
      </button>
      <button type="button" onClick={onExit}>
        New match
      </button>
    </div>
  );
}
