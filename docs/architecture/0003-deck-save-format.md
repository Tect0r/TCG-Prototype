# ADR 0003 — Deck save format, migrations and persistence

**Status:** accepted · **Date:** 2026-08-07

## Context

Saved decks are user work. They must survive card renames, app updates and bad
import files. They must also be validatable by a server that has never seen the
browser that produced them.

## Decision

### Format

Exactly the shape documented in the specification, with two additions:

```json
{
  "schemaVersion": 1,
  "id": "deck_01h_example",
  "name": "Prototype Deck",
  "commanderId": "prototype_commander_blue_red",
  "cards": [{ "cardId": "prototype_scout", "quantity": 2 }],
  "createdAt": "2026-08-07T12:00:00.000Z",
  "updatedAt": "2026-08-07T12:00:00.000Z"
}
```

- `commanderId` is **nullable**. A deck exists before a Commander is chosen;
  the alternative is either a fake Commander or an unsaveable draft.
- `notes` is an optional free-text field, omitted when empty.

Entries reference cards by permanent ID only. A test asserts that an exported
deck containing Goblin Scout does not contain the string `"Goblin Scout"`.

Export is the bare deck object rather than a wrapper envelope, so what is
exported is what is documented. Import accepts a single deck or an array, so a
whole collection can be backed up and restored.

### Migrations

`migrateSavedDeck(raw, migrations)` walks a registry of `{ from, migrate }`
steps up to the current version, then validates. The registry is **empty** — v1
is the first released format — but the runner exists and is tested with injected
migrations, so the first schema bump is a data change rather than new machinery.

A deck from a _newer_ schema is refused with "update the app", never
partially parsed. `structuredClone` runs before any step, so a careless
migration cannot mutate the caller's object.

### Persistence is salvaging, never destructive

`DeckRepository` takes a `KeyValueStore` interface rather than touching
`localStorage` directly, so the logic is testable in plain Node.

Three rules:

1. One unreadable deck in the collection is skipped with a warning; the rest
   still load.
2. A payload that cannot be parsed at all is **copied to a quarantine key**
   before anything else happens. Nothing is deleted.
3. An import that fails validation changes nothing. Parsing completes fully and
   returns a `Result` before any state is touched.

Imported decks are also collision-proofed: a deck ID that already exists gets a
fresh one and a duplicate name is suffixed, so importing a file you already have
adds a copy instead of overwriting the original.

### Hydration ordering

The client must not write state to storage before reading it. This was
originally guarded with a `useRef` that flipped inside the load effect — which
fails, because the persist effect then runs in the same commit with the still
empty `state.decks` and erases the collection. React StrictMode's double-mount
turns that into permanent data loss.

Hydration is therefore a flag in **reducer state**: it only becomes true in the
same render that carries the loaded decks. `persistence.test.tsx` covers this
and fails against the old approach.

## Consequences

- Deck validation is pure and database-driven, so the future server can call
  `validateDeck` with no changes.
- Format limits are a config object, so playtesting can change deck size or copy
  limits without touching validation code.
- Storage can never be silently wiped; the worst case is decks temporarily
  hidden behind a quarantined key.
