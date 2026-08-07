import { createServer, type Server as HttpServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { encode } from '@tcg/protocol';
import type { MatchServer, ServerConnection } from './match-server.js';

/**
 * The only file that knows about sockets. Everything protocol-shaped lives in
 * `MatchServer`, so the transport can be swapped (or bypassed entirely in
 * tests) without touching game logic.
 */
export interface WebSocketTransport {
  readonly port: number;
  close(): Promise<void>;
}

export interface StartOptions {
  readonly port?: number;
  readonly host?: string;
}

export function startWebSocketServer(
  matchServer: MatchServer,
  options: StartOptions = {},
): Promise<WebSocketTransport> {
  const http: HttpServer = createServer((request, response) => {
    // A tiny health endpoint keeps "is it running?" answerable without a client.
    if (request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'ok', lobbies: matchServer.lobbyCount }));
      return;
    }
    response.writeHead(404).end();
  });

  const sockets = new WebSocketServer({ server: http });
  let nextConnectionId = 0;

  sockets.on('connection', (socket: WebSocket) => {
    nextConnectionId += 1;
    const connection: ServerConnection = {
      id: `conn_${nextConnectionId}`,
      send(message) {
        if (socket.readyState === socket.OPEN) socket.send(encode(message));
      },
      close() {
        socket.close();
      },
    };

    matchServer.connect(connection);
    socket.on('message', (data) => {
      matchServer.receive(connection, typeof data === 'string' ? data : data.toString());
    });
    socket.on('close', () => matchServer.disconnect(connection));
    socket.on('error', () => matchServer.disconnect(connection));
  });

  return new Promise((resolve, reject) => {
    http.once('error', reject);
    http.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => {
      const address = http.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            for (const client of sockets.clients) client.terminate();
            sockets.close(() => http.close(() => done()));
          }),
      });
    });
  });
}
