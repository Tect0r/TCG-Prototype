/* eslint-disable no-console */
import { loadBundledCardData } from '@tcg/card-data';
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

const { database, warnings } = loadBundledCardData();
for (const warning of warnings) console.warn(`[card-data] ${warning.code}: ${warning.message}`);

const server = new MatchServer({ database, config: DEFAULT_RULES_CONFIG });

startWebSocketServer(server, { port, host })
  .then((transport) => {
    console.log(`Match server listening on ws://${host}:${transport.port}`);
    console.log(`Cards loaded: ${database.size}`);
    console.log(`Versions: ${JSON.stringify(CURRENT_VERSIONS)}`);
    console.log(
      `Disconnect grace: ${DEFAULT_RULES_CONFIG.disconnectGraceSeconds}s. State is in memory; restarting ends live matches.`,
    );
  })
  .catch((error: unknown) => {
    console.error('Failed to start the match server:', error);
    process.exitCode = 1;
  });
