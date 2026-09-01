# TCG Prototype — permanent agent instructions

This file stays deliberately short because it is loaded on every task. The live
work queue is in [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md); detailed
scope is in exactly one file under `docs/milestones/`.

## Model routing

This repository uses one sequential Claude Code session, not an agent team.
Never create parallel implementers or let multiple agents edit the working tree.

- The main session runs **Sonnet** and owns planning, implementation, fixes,
  focused verification, durable-record updates, commits and pushes.
- `tcg-recon` runs **Haiku** only when the user explicitly requests recon or a
  targeted Sonnet search cannot establish the boundary without broad discovery.
- `tcg-verifier` runs **Haiku** only when the user explicitly requests an
  independent verification pass. Routine verification belongs to Sonnet.
- `tcg-reviewer` runs **Opus** once when a whole tranche is ready to close. It
  reviews the bounded tranche diff and verification evidence, never each slice.

Subagents are exceptions, not the default workflow. Never spawn recon and
verification agents merely because a milestone slice exists. Never use Opus for
discovery, implementation, routine test output, formatting or intermediate slice
review. Never delegate implementation to another Sonnet agent.

### Milestone workflow

1. Sonnet implements exactly one named work slice and runs only its focused
   checks. It may mark that slice complete, but not the tranche checklist.
2. Sonnet records a coherent checkpoint commit and stops. It never rolls into
   the next slice in the same session.
3. Repeat in a fresh session until every implementation slice in the tranche is
   complete.
4. In the tranche-close session, Sonnet revalidates the combined tranche diff,
   runs the required consistency, audit and full verification gates, and updates
   the uncommitted durable record only where the evidence supports completion.
5. Only then ask `tcg-reviewer` to review the complete tranche commit range. Fix
   material findings with Sonnet and request one bounded recheck. Include the
   uncommitted close-record diff in that review.
6. Commit and push the tranche-close record, mark the tranche complete and name
   its successor only after `VERDICT: APPROVE`.

For work outside a milestone, Sonnet handles isolated changes alone. Use Opus
only for a genuinely risky final review involving gameplay or business logic,
state transitions, persistence, networking, schemas, compatibility, hidden
information, security, determinism, public APIs or architectural boundaries.

If review returns `VERDICT: CHANGES REQUIRED`, the Sonnet main session fixes the
findings and re-runs the affected focused checks plus all failed final gates.
Resume the same reviewer and ask it to recheck only its open findings and the
new diff. Stop after two review/fix cycles and report the unresolved blocker
instead of looping or widening scope.

## Working protocol

1. Inspect the current branch, working tree, recent commits and remote state
   before changing anything.
2. Read the execution rule and status row in `IMPLEMENTATION_PLAN.md`, then use
   targeted search to read only the named slice in the active milestone file.
   Do not load an entire historical milestone record.
3. Re-check the named slice against current code. If it is already complete,
   verify and record that fact instead of reimplementing it.
4. Complete exactly one work slice, or one explicitly named tranche-close run.
   Never continue into another slice in the same session.
5. Preserve unrelated and user-owned changes.
6. A normal slice may update only its work-slice checkbox and evidence note.
   Tranche acceptance checklists, the root status row and generated audit facts
   move only in the tranche-close run after their gates pass.
7. When a change affects anything counted by `docs/status-audit.md`, regenerate
   it in the tranche-close run; never hand-edit derived facts.
8. Commit a coherent, focused-test-passing slice as a checkpoint. Push according
   to the repository's current branch convention unless the user requested local
   work only. A slice commit is not a completed tranche.
9. Stop with: slice, files and behavior changed, focused verification, commit and
   push result, remaining blocker, and the exact next slice. A tranche-close run
   also reports full gates, reviewer verdict and the next tranche.

## Context discipline

Claude Code auto-compacts at the repository's 200,000-token window. Compaction is
an emergency boundary, not a target.

- Keep a normal slice small enough to finish without compaction: one coherent
  result, one ownership boundary and its semantic tests.
- Use targeted `rg`, bounded reads and concise command output. Never paste or
  reread complete generated files, milestone histories or successful full logs.
- Be quiet on success and precise on failure. Prefer summary/quiet reporters;
  for potentially verbose commands, write the full log outside the repository
  and return only exit status, exact counts and the smallest useful failure
  excerpt. Do not emit a full log merely to prove that a command ran.
- Inspect diffs with `--stat`, `--name-only` and bounded hunks before requesting
  a complete diff. Never print an unchanged file or an entire large diff when a
  symbol search or line range answers the question.
- Do not run the full repository gate during implementation slices unless the
  slice explicitly changes the gate itself. Full gates belong to tranche close.
- If compaction occurs, do not explore further or widen scope. Finish the current
  safe checkpoint, run its focused checks, commit if valid, report and stop.
- If the slice cannot reach a safe checkpoint after compaction, record the exact
  blocker and stop without marking it complete.

### Compact instructions

Preserve only the named slice, its acceptance boundary, changed paths, decisions,
current failures and verification evidence, git state, blockers and exact next
action. Drop completed exploration, long command output, superseded plans,
historical milestone detail and unrelated repository context.

Final reports stay concise: do not narrate exploration or repeat the request.
Report exact changed paths, behavior, focused or full command results, commit and
push state, blockers and the next slice; include log excerpts only for failures.

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

Run the smallest relevant tests while developing. A normal work slice stops
after its focused semantic checks. Before a tranche can enter Opus review, the
Sonnet tranche-close session must run:

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
