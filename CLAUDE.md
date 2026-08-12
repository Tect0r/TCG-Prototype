# TCG Prototype — permanent agent instructions

This file stays deliberately short because it is loaded on every task. The live
work queue is in [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md); detailed
scope is in exactly one file under `docs/milestones/`.

## Working protocol

1. Inspect the current branch and working tree before changing anything.
2. Read `IMPLEMENTATION_PLAN.md` and only the active milestone file.
3. Re-check the named problem in code. If it is already fixed, verify it, record
   evidence, and do not reimplement it.
4. Complete one numbered tranche only. Never roll into the next tranche without
   a new instruction.
5. Preserve unrelated and user-owned changes.
6. Update the plan only after tests and acceptance criteria pass.
7. Stop with: files changed, behavior changed, verification run, remaining
   blocker, and the exact next tranche.

## Product rules that must not drift

- `precon_wave_1`: 40-card singleton deck plus one Commander outside the deck.
- The battlefield has no Unit limit. Large boards are measured, not treated as
  proof that a cap is needed.
- Each player has one active Relic. Replacing it is neither defeat nor sacrifice.
- Commanders deploy from the Command Zone. On defeat they return immediately to
  that zone; each defeat adds 1 Energy to future deployment cost, with total
  cost capped at 10.
- Commander abilities are active only in their structured `activeZone`.
- `Newly Deployed` clears at the controller's next Ready Step. It prevents
  attacking and Exhaust-cost abilities, but not blocking. Rush bypasses those
  two restrictions without removing the state.
- One Reaction per eligible player per window; no Reaction responds to another
  Reaction unless a future explicit counter rule says otherwise.
- `deployed` and `entersBattlefield` are different triggers. Review their use
  card by card; never bulk-convert them.
- Player damage/healing targets a player, not a deployed Commander Unit.
- Overwhelm splits against current blocker Health before Barrier prevents the
  blocker portion. Barrier does not prevent excess damage to the player.
- Tokens retain individual engine identity even when grouped visually.

ADRs 0016 and 0017 contain the current architectural rationale. If an older
document disagrees with the rules above, the older document is stale.

## Engineering invariants

- Structured card data is authoritative. Display text is never parsed into
  behavior.
- New mechanics ship across the whole contract: schema/versioning, engine,
  choices/protocol/redaction, UI, help/glossary, pilots, telemetry/provenance,
  hashing/replay, templates, and tests.
- The engine stays deterministic, serializable, authoritative, and independent
  of UI timing.
- Bots receive only their observation boundary. Analysis-mode information never
  leaks into normal matches.
- Costs are atomic. Interactive costs pause before commitment and are revalidated
  when answered. Countering never refunds paid costs.
- Any playable pool must be obtained through a format-scoped database, never the
  entire bundled card universe.
- Do not silently invent unresolved rules. Record the smallest blocking question
  in `IMPLEMENTATION_PLAN.md` and stop that tranche.

## Verification

Run the smallest relevant tests while developing, then run `npm run verify`
before completing a tranche. `npm run verify` is the single final gate: since
M01.5 its `typecheck` step covers the workspaces **and** the root
`tsconfig.json` (`scripts/`, `vitest.config.ts`, `eslint.config.js`), so there
is no separate root type-check to remember.

Never claim completion from `npm test` alone.
