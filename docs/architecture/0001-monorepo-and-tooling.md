# ADR 0001 — Monorepo layout and toolchain

**Status:** accepted · **Date:** 2026-08-07

## Context

The deck builder is the first milestone, but the same card definitions and rules
must later serve an authoritative server, a headless simulator and automated
tests. Package boundaries drawn now decide whether that is cheap or painful.

## Decision

A TypeScript monorepo with strict compiler settings, split as:

```text
apps/web-client      Deck builder (React + Vite)
packages/shared      Result type, structured diagnostics, ID generation
packages/card-data   Card schemas, effects, loader, query layer, artwork paths
packages/deck        Deck schema, migrations, legality, persistence, import/export
```

Dependency direction is one-way: `web-client → deck → card-data → shared`.
`card-data` imports nothing from the UI, server, simulator or rules engine, and
an ESLint `no-restricted-imports` rule fails the build if that is violated.

Packages are consumed as TypeScript source (`"exports": "./src/index.ts"`)
rather than built artefacts. Vite and Vitest transpile them directly, so there
is no per-package build step to keep in sync. When the Node server arrives it
can run the same way via a loader, or gain a build step then.

### Deck as its own package

Decks could have lived in `card-data`, but a deck is a game concept, not a card
concept, and the rules engine will need both independently. Keeping them apart
means `card-data` stays a pure catalogue.

## Toolchain

React 19 + Vite 6, Zod 4 for runtime validation, Vitest 3, ESLint 9 flat config,
Prettier. Chosen for being mainstream and boring.

Strict TypeScript includes `noUncheckedIndexedAccess` and
`exactOptionalPropertyTypes`, which are unusually strict but cheap to adopt at
the start of a project and awkward to retrofit.

## Deviation: npm workspaces, not pnpm

The specification prefers pnpm workspaces. pnpm is not installed on the
development machine and `corepack enable` requires administrator rights there,
so the workspace uses **npm workspaces** instead.

npm workspaces cover everything this project needs: local package linking,
hoisting, and `--workspace` script targeting. Moving to pnpm later means adding
a `pnpm-workspace.yaml` and deleting `package-lock.json`; no source changes.

## Consequences

- No package build step, so no stale-`dist` class of bug — at the cost of
  packages not being independently publishable. Fine for a private prototype.
- The import-direction rule is enforced mechanically, not by convention.
- `rules-engine`, `bot-interface`, `multiplayer-server` and `simulator` are
  **not** created as empty packages. Their place in the layout is documented
  here and in the README rather than faked with stub code.

**Updated 2026-08-07 (Phase 2):** `packages/rules-engine`,
`packages/protocol` and `apps/multiplayer-server` now exist. `protocol` was not
in the original layout sketch — it holds the client/server message schemas,
which could not live in `card-data` (which must not know about the network) and
would have made `shared` non-trivial. Rationale in
[ADR 0006](0006-network-protocol.md). `bot-interface` and `simulator` remain
absent, awaiting Phase 4.
