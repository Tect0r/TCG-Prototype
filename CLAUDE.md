# TCG Prototype — permanent agent instructions

This file stays deliberately short because it is loaded on every task. The live
work queue is in [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md); detailed
scope is in exactly one file under `docs/milestones/`.

## Model routing

This repository uses one sequential Claude Code session, not an agent team.
Never create parallel implementers or let multiple agents edit the working tree.

- The main session runs **Sonnet** and owns planning, implementation, fixes,
  durable-record updates, commits and pushes.
- `tcg-recon` runs **Haiku** for bounded repository discovery and impact
  analysis. Use it instead of broad exploration by the main session.
- `tcg-verifier` runs **Haiku** after implementation. It executes and reports
  checks but never fixes code or generated records.
- `tcg-reviewer` runs **Opus** as a read-only quality gate after the change is
  implemented, documented and verified.

Run those roles sequentially and wait for each required result. Do not use Opus
for repository discovery, implementation, routine test output, formatting or a
small documentation-only correction. Do not delegate implementation to another
Sonnet subagent: the Sonnet main session already owns that context and work.

### When each role is required

For every numbered milestone tranche:

1. Ask `tcg-recon` to revalidate the tranche against the current branch, code,
   tests and directly relevant documents.
2. Have the Sonnet main session implement exactly that tranche.
3. Ask `tcg-verifier` to run focused checks, the repository consistency gates
   and the full final gate.
4. After the milestone checklist and root status row truthfully match the
   verified implementation, ask `tcg-reviewer` to review the complete diff.
5. Commit and push only after the reviewer returns `VERDICT: APPROVE`.

For work outside a milestone, use `tcg-recon` when the relevant boundary is not
already obvious. Use `tcg-reviewer` when a change affects gameplay or business
logic, state transitions, persistence, networking, schemas, compatibility,
hidden information, security, deterministic execution, public APIs, multiple
packages, or architectural boundaries. Sonnet plus `tcg-verifier` is enough for
small isolated changes.

If review returns `VERDICT: CHANGES REQUIRED`, the Sonnet main session fixes the
findings and re-runs the affected focused checks plus all failed final gates.
Resume the same reviewer and ask it to recheck only its open findings and the
new diff. Stop after two review/fix cycles and report the unresolved blocker
instead of looping or widening scope.

## Working protocol

1. Inspect the current branch, working tree, recent commits and remote state
   before changing anything.
2. Read `IMPLEMENTATION_PLAN.md` and only the active milestone file. Locate the
   named tranche with targeted search and bounded reads; do not load entire
   historical milestone records without a concrete need.
3. Re-check the named problem in code. If it is already fixed, verify it, record
   evidence, and do not reimplement it.
4. Complete one numbered tranche only. Never roll into the next tranche without
   a new instruction.
5. Preserve unrelated and user-owned changes.
6. Do not modify the implementation plan, milestone checklist or generated
   status audit until code and focused acceptance checks support the claim.
7. When a change affects anything counted by `docs/status-audit.md`, regenerate
   it with the repository command; never hand-edit derived facts.
8. Before completion, run the routed verification and review flow above.
9. For an implementation request, commit the approved coherent tranche and push
   its branch unless the user explicitly asked for a local-only change. Never
   commit analysis-only or review-only work.
10. Stop with: files changed, behavior changed, verification run, reviewer
    verdict, commit/push result, remaining blocker, and the exact next tranche.

## Product rules that must not drift

- `precon_wave_1`: 40-card singleton deck plus one Commander outside the deck.
  40 is the owner-confirmed first-playtest scope (2026-08-14); 50 is the later
  target and needs 8–9 more colour-legal cards per Commander first.
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
- Automated warnings and statistical signals are evidence for review, never an
  automatic balance verdict.

## Verification

Run the smallest relevant tests while developing. Before a tranche can enter
Opus review, `tcg-verifier` must run:

1. the focused tests and checks that cover the changed behavior;
2. `npm run check:consistency`;
3. `npm run audit:check`;
4. `npm run verify`.

`npm run verify` is the single full-code gate: since M01.5 its `typecheck` step
covers the workspaces **and** the root `tsconfig.json` (`scripts/`,
`vitest.config.ts`, `eslint.config.js`), so there is no separate root type-check
to remember. The consistency and status-audit checks remain explicit because
they protect the durable project record rather than replacing the code gate.

Never claim completion from `npm test` alone. Never mark a tranche complete when
a required command was skipped, failed or produced ambiguous output.

