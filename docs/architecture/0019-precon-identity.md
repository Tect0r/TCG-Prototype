# ADR 0019 — A precon is an identity, not a decklist

**Status:** accepted · **Date:** 2026-08-13 · **Extends:**
[ADR 0003](0003-deck-save-format.md), [ADR 0006](0006-network-protocol.md),
[ADR 0010](0010-seed-derivation-and-reproducibility.md),
[ADR 0016](0016-precon-wave-1-ruleset.md)

Recorded in M07.3 for decisions taken and implemented in M03.1–M03.4.

## Context

Four bundled precons ship with the Wave 1 set, and four separate surfaces have
to answer questions about them: the deck builder (may I copy this?), the lobby
(may I play this?), the match server (may this seat play this?) and the
simulator (may this experiment name this?).

The naive shape is for each surface to hold a decklist. That fails in two ways
at once. A precon that the builder calls playable and the server rejects is a
bug a player meets at the worst possible moment; and a 40-card list travelling
over the network as data is a list a client can edit before sending, which turns
"I played the shipped precon" into a claim nobody checks.

## Decision

### 1. One resolution path, used by every surface

`bundledPrecon` → `reviewPrecon` → `preconToDeck`, in `@tcg/card-data` and
`@tcg/deck`. `reviewPrecon` layers a format check, the existing `validatePrecon`
and `validateDeck` **run against the copy that would actually be played**, so no
surface can call a precon playable by a rule another surface does not apply. The
list a surface may offer at all comes from `preconsForFormat`, which is
format-scoped: any playable pool is obtained through a format-scoped database,
never the bundled card universe.

Copying a precon in the builder produces an **ordinary saved deck** through
`preconToDeck`, with a fresh ID and a non-colliding name. The bundled definition
is never written to, and nothing in `SavedDeck` records where it came from — an
edited precon has to be judged on its contents, and its name buys it nothing
([ADR 0003](0003-deck-save-format.md)).

### 2. What crosses the wire is the ID

`submit_precon { preconId }` is a protocol message carrying **only** the ID. The
server resolves it against its own bundled content, reviews it with the same
`reviewPrecon` the UI previewed with, and builds the deck itself. What it
validates is therefore what the UI presented, and there is no list on the wire
to tamper with. An edited precon is an ordinary saved deck and still goes
through `submit_deck`, judged on its contents.

Two failure modes are deliberately distinct, because they are different
mistakes:

- `protocol/unknown_precon` — the ID names nothing this build has. The seat's
  existing submission is left alone rather than cleared.
- `precon/format_mismatch` — the ID resolves, and names a precon belonging to
  another format. It is refused after resolution, so the error can say what it
  actually is.

**The precon ID is not in `LobbySeatView`.** The seat's public `deckName` becomes
the precon's name, which is exactly what a copied precon has always shown; the
ID would hand every opponent an exact 40-card list before the match starts. This
is the ordinary observation-boundary rule (ADR 0009, CLAUDE.md §11) applied to
the lobby.

### 3. A named deck source is fatal on any failure

A simulator experiment may name precons — `{ "kind": "precon", "preconIds": [...] }`
— resolved through the same three functions. It is the one deck source where
**every** failure stops the run: an unknown ID, another format's precon, a
precon the environment bans a card out of, or the same ID listed twice. A source
that _names_ shipped decks cannot quietly play three of the four and report a
matrix, because the missing cell would be invisible in the output.

`environment.format` and `environment.sets` scope the card pool, which is what
they always claimed to do and did not: before M03.3 every environment resolved
against the whole bundled universe. An environment naming neither still does,
because the Phase 1–4 fixture configurations depend on it.

### 4. Completeness is recorded, not assumed

`orderedMatchupMatrix: true` asks for the whole ordered matrix in one setting.
Two things had to be said properly for that to mean anything:

- `includeMirrorMatchups` enumerates deck tuples as combinations **with**
  repetition, and a tuple's seat orientations are its number of **distinct
  rotations** rather than its length — so a deck against a copy of itself is one
  ordered matchup, not two identical tables on different seeds. Four decks are
  6 × 2 + 4 = **16** ordered matchups. A schedule without mirrors is
  byte-identical to before the flag existed.
- The artefact records `expectedCells` (n²), names any `missing` pair, and
  counts `cleanGames`, and the manifest carries the same numbers. The claim is
  either made or visibly declined.

A configuration that **could not** produce a complete matrix — not two seats, a
sampled schedule, unmirrored seats — is refused at parse time rather than
quietly adjusted.

The shipped run, `experiments/precon-matrix.json`, is 16/16 cells and 16/16
clean, byte-identical at one worker and at four. Its report section says in bold
that it is a robustness artefact and **not a balance measurement**; the winner
column is there for auditability. Whether a run may be cited for more than that
is [ADR 0022](0022-evidence-claims.md)'s question, not this one's.

## Consequences

- A manifest records each precon ID with its format, Commander and **resolved
  deck hash**, beside the environment hashes and the frozen snapshot that pin
  what those IDs meant at the time. A precon is a name; the hash is what it
  contained ([ADR 0010](0010-seed-derivation-and-reproducibility.md)).
- Changing a bundled precon changes its resolved deck hash and therefore every
  seed derived from it. Old result sets do not silently re-interpret; they
  disagree, visibly, on the hash.
- Four surfaces share one verdict, so a rule added to `validateDeck` reaches all
  of them. The builder cannot drift permissive and the server cannot drift
  strict.
- The first precon smoke run found a real engine defect rather than a content
  one: the simulator's `seatToAct` did not know about Reaction windows, so a
  window whose priority sat with a non-active seat was offered to the active
  player, who had no legal action at all. The generated fixture decks carry
  almost no Reactions, which is why nothing had caught it. The four-precon batch
  is its regression.

## Alternatives considered

**Send the resolved decklist and let the server validate it.** Rejected: the
server would be validating a list, not a precon, and "this seat played the
shipped Bastion deck" would stop being checkable.

**Add precon provenance to `SavedDeck`.** Rejected for M03 and still not done:
it is a persisted schema change, no surface needs it, and a copied precon that
carried its origin would invite exactly the "it says precon, so it is legal"
shortcut the shared `reviewPrecon` path exists to prevent.
