/* eslint-disable no-console */
import { loadFormatCardData, resolveFormatId } from '@tcg/card-data';
import { deckFormatOf } from '@tcg/deck';
import { CURRENT_VERSIONS } from '@tcg/protocol';
import { DEFAULT_RULES_CONFIG } from '@tcg/rules-engine';
import { MatchServer } from './match-server.js';
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
// format.
const formatId = resolveFormatId(process.env.TCG_FORMAT);
const loaded = loadFormatCardData(formatId);
if (!loaded.ok) {
  for (const issue of loaded.error) console.error(`[card-data] ${issue.code}: ${issue.message}`);
  throw new Error(`Cannot start: format "${formatId}" did not resolve to a usable card pool.`);
}

const { database, warnings, format } = loaded.value;
for (const warning of warnings) console.warn(`[card-data] ${warning.code}: ${warning.message}`);

const deckFormat = deckFormatOf(format);
const server = new MatchServer({ database, config: DEFAULT_RULES_CONFIG, deckFormat });

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
  })
  .catch((error: unknown) => {
    console.error('Failed to start the match server:', error);
    process.exitCode = 1;
  });
