/* eslint-disable no-console */
import { CURRENT_VERSIONS } from '@tcg/protocol';
import { DEFAULT_RULES_CONFIG } from '@tcg/rules-engine';
import { composeMatchServer } from './compose.js';
import { startWebSocketServer } from './ws-adapter.js';

/**
 * Development entry point.
 *
 * Lobbies and matches live in memory only. Restarting the process ends every
 * match in progress — a deliberate limitation for this phase, recorded in
 * docs/project-status.md rather than solved with a database (CLAUDE.md §11).
 */
const port = Number.parseInt(process.env.PORT ?? '8787', 10);
const host = process.env.HOST ?? '127.0.0.1';

// The server validates decks against one format's pool, not the bundled
// universe: a development fixture must be rejected here even though it is still
// in the content bundle (M01.1). `TCG_FORMAT` selects another format —
// `development` for the fixture set — and is the only way to leave the shipping
// format. Live-match telemetry (M08.R9) is validated the same way: an invalid
// or half-configured `TCG_LIVE_MATCH_TELEMETRY_*` value refuses startup rather
// than silently running without telemetry.
const composed = composeMatchServer(process.env);
if (!composed.ok) {
  for (const issue of composed.error) console.error(`[compose] ${issue.code}: ${issue.message}`);
  throw new Error('Cannot start: the multiplayer server composition failed validation.');
}

const { server, formatId, deckFormat, database, warnings, liveMatchTelemetryEnabled } = composed.value;
for (const warning of warnings) console.warn(`[card-data] ${warning.code}: ${warning.message}`);

startWebSocketServer(server, { port, host })
  .then((transport) => {
    console.log(`Match server listening on ws://${host}:${transport.port}`);
    console.log(
      `Format: ${formatId} (${deckFormat.deckSize} cards${deckFormat.singleton ? ', singleton' : ''}).`,
    );
    console.log(`Cards in the legal pool: ${database.size}`);
    console.log(`Versions: ${JSON.stringify(CURRENT_VERSIONS)}`);
    console.log(
      `Disconnect grace: ${DEFAULT_RULES_CONFIG.disconnectGraceSeconds}s. State is in memory; restarting ends live matches.`,
    );
    console.log(`Live-match telemetry: ${liveMatchTelemetryEnabled ? 'enabled' : 'disabled'}.`);
  })
  .catch((error: unknown) => {
    console.error('Failed to start the match server:', error);
    process.exitCode = 1;
  });
