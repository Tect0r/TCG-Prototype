import { loadFormatCardData, resolveFormatId, type CardDatabase } from '@tcg/card-data';
import { deckFormatOf, type DeckFormatConfig } from '@tcg/deck';
import { DEFAULT_RULES_CONFIG } from '@tcg/rules-engine';
import { err, ok, type Issue, type Result } from '@tcg/shared';
import {
  effectiveLiveMatchRetention,
  liveMatchTelemetryConfigFromEnvironment,
} from './live-match-telemetry-config.js';
import { LiveMatchFileStore } from './live-match-store.js';
import { MatchServer } from './match-server.js';

export interface MultiplayerServerComposition {
  readonly server: MatchServer;
  readonly formatId: string;
  readonly deckFormat: DeckFormatConfig;
  readonly database: CardDatabase;
  readonly warnings: readonly Issue[];
  readonly liveMatchTelemetryEnabled: boolean;
}

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * Builds the production `MatchServer` the same way `main.ts` does — format
 * pool, rules config, and (M08.R9) the live-match telemetry sink — from
 * process environment. Factored out of `main.ts` so a test can drive the
 * real composition (including live-match telemetry wiring and its refusal
 * behavior) without binding a real socket. `main.ts` calls this and only
 * this to build its server; nothing here re-implements its own copy of that
 * wiring.
 */
export function composeMatchServer(
  environment: Environment,
): Result<MultiplayerServerComposition, readonly Issue[]> {
  const formatId = resolveFormatId(environment.TCG_FORMAT);
  const loaded = loadFormatCardData(formatId);
  if (!loaded.ok) return err(loaded.error);

  const telemetry = liveMatchTelemetryConfigFromEnvironment(environment);
  if (!telemetry.ok) return err(telemetry.error);

  const { database, warnings, format } = loaded.value;
  const deckFormat = deckFormatOf(format);
  const telemetryConfig = telemetry.value;

  const server = new MatchServer({
    database,
    config: DEFAULT_RULES_CONFIG,
    deckFormat,
    ...(telemetryConfig.enabled && telemetryConfig.rootDirectory !== null
      ? {
          liveMatchSink: new LiveMatchFileStore({ rootDirectory: telemetryConfig.rootDirectory }),
          liveMatchRetention: effectiveLiveMatchRetention(telemetryConfig),
        }
      : {}),
  });

  return ok({
    server,
    formatId,
    deckFormat,
    database,
    warnings,
    liveMatchTelemetryEnabled: telemetryConfig.enabled,
  });
}
