# ADR 0006 — Network boundary and authoritative server (Phase 2B)

**Status:** accepted · **Date:** 2026-08-07

## Context

Phase 2B adds online 1v1 through private invite-code lobbies. The server must be
the only process that mutates match state, must never leak hidden information,
and must survive a refresh without letting a retried action play a card twice
(CLAUDE.md §11).

`docs/open-questions.md` Q7 asked where the message schema should live. It could
not go in `card-data` (which must not know about the network) and putting it in
`shared` would have made `shared` non-trivial.

## Decision

### A separate `packages/protocol`

Message schemas live in their own package that depends on `rules-engine` and
`deck`. Both ends import it, so client and server cannot drift: adding a field
to a server message that the client does not expect is a type error, not a
runtime surprise.

Every frame is validated on receipt at **both** ends. A malformed frame produces
a structured `protocol/malformed_message` error and changes nothing.

### Versions are compared, not negotiated

The handshake carries `{ protocol, rules, cardSchema }`. Any mismatch is
refused up front with the specific differences listed. There is no negotiation
and no compatibility shim in v0.1: two clients silently playing by different
rules is much worse than a clear refusal to start.

### The server is transport-agnostic

`MatchServer` is driven by `receive(connection, rawMessage)` against a
three-method `ServerConnection` interface. `ws-adapter.ts` is the only file that
knows what a WebSocket is.

The point is testability: the entire lobby, reconnection, idempotency and
redaction surface is covered by fast, deterministic tests with no ports, no
timers and no flakiness, including a full match played to a natural finish. One
separate test suite opens a real socket to prove the adapter works.

Timers and randomness are injected for the same reason — the 90-second
disconnect window is tested by firing the scheduled callback, not by waiting.

### Idempotency by client action ID

Every action carries a client-generated `actionId`. The server records the IDs
it has applied per seat; a repeat is answered with the **current view** rather
than being applied again. This is what makes "retry after reconnect" safe, and
it is tested directly by dropping a connection mid-action and replaying it.

### Stale revisions are rejected

Each action also carries the `lastSequence` the client was looking at. If it no
longer matches the server's, the action is rejected with
`protocol/stale_revision` and the current view is resent. Turn-based play has no
legitimate reason to act on a stale board, and this closes the window where a
fast click resolves against a state the player never saw.

### The server sends views, never state

Clients receive `PlayerView` plus the redacted event delta since their last
sequence. Authoritative `MatchState` never crosses the boundary — not even
serialised, not even to the player it belongs to.

The view includes engine-computed `legalActions`, so highlighting in the UI is
server-derived. The client can and does show a local deck-legality preview, but
the server validates every submitted deck against its own card database and its
verdict is the one that counts.

## Consequences

- Lobbies and matches are **in memory only**. Restarting the process ends every
  live match. This is a deliberate limitation for this phase, per CLAUDE.md §11
  ("do not add accounts or a database merely to solve it yet"), and is stated in
  the server's own startup banner.
- Reconnect tokens are opaque random strings with no expiry beyond the lobby's
  lifetime. Good enough without accounts; not a security boundary.
- Leaving a live match is treated as a concession, while losing the socket is
  not — it starts the grace window instead.
- A second live connection for one seat is closed in favour of the newest, so a
  stale tab cannot keep acting.

## Alternatives considered

**Putting the schemas in `shared`.** Rejected: `shared` is meant to stay tiny
and dependency-free, and it is imported by `card-data`, which must never learn
about the network.

**Sending event deltas only, with the client folding them into a local state.**
Rejected for this phase: it duplicates engine logic in the client, which is
exactly what the "server is authoritative" rule exists to prevent. Sending the
whole view is a few kilobytes per action in a turn-based game.

**Server-side timers driving game rules.** Rejected: the engine must never read
a clock. A disconnect expiry is submitted as an explicit, validated
`server_timeout` action like any other.
