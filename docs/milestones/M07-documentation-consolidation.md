# M07 — Documentation consolidation and final audit

## Preconditions

Run after M01–M06 so documentation describes the settled implementation once,
not every intermediate state.

## M07.1 — Final code/status audit

Regenerate counts from code and run the full verification chain. Record the
current commit, schema versions, formats, card/precon counts, test totals, and
known limitations. Do not copy old totals from prose.

## M07.2 — Rules truth sweep

Rewrite/consolidate:

- `docs/rules/confirmed-rules.md` — implemented player-facing rules only;
- `docs/rules/open-decisions.md` — genuinely provisional rules only;
- `docs/open-questions.md` — unanswered owner decisions only.

Remove answered/stale entries about five Unit slots, three Relics, inert
Guardian, Swift, non-deployable Commanders, 30-card Wave 1 decks, absent player
targets, and already-built schemas.

Keep the explicit card-by-card `deployed` versus `entersBattlefield` review
record. Do not convert it into a blanket rule.

## M07.3 — ADR amendments

Preserve accepted ADRs, but add clear supersession amendments where their body
describes the old game. ADR 0016 especially must no longer say Commander defeat
lifecycle is unimplemented; record immediate Command-Zone return, +1 per defeat,
and total-cost cap 10. Keep the deliberate current-Health Overwhelm divergence
visible.

Add ADRs for new persisted/state-machine/statistical decisions introduced in
M02–M05.

## M07.4 — Project status and testing record

Update `docs/project-status.md` with the Phase 4 hardening final report and all
later milestones. Fix broken links and old references to monolithic
`prototype_core.json`. Add `docs/testing/FIRST_CARD_BATCH_TEST_PLAN.md` with the
actual staged protocol used for Wave 1, not the obsolete pre-authoring plan.

## M07.5 — Root and README cleanup

Ensure the root contains only:

- `README.md`
- `CLAUDE.md`
- `IMPLEMENTATION_PLAN.md`

Delete superseded root handoff/spec files listed in the package apply guide.
Refresh `README.md` and shrink completed milestone detail to durable evidence.
Keep milestone files as concise completion records or archive them under
`docs/history/`; do not put the backlog back into `CLAUDE.md`.

## M07.6 — Root JSON decision

Re-run exact parity checks between tracked root `cards.json`/`precons.json` and
generated content. Ask the owner whether to delete the redundant imports. Until
explicit approval, keep them and state that generated `content/` is authoritative.

## M07.7 — Final consistency test

Add/retain automated checks that catch:

- obsolete rule terms in player help and active rules docs;
- broken internal Markdown links;
- implementation-plan references to missing files;
- current format/card/precon counts generated from source;
- `implemented: false` in a playtest/active set;
- help text that contradicts registry/config values.

Run `npm run verify` and a Markdown link check. Record remaining open decisions,
not speculative future features.

## Acceptance

- One short root work queue, one short permanent agent file, one accurate README.
- No active document teaches an obsolete rule.
- ADR history remains available with explicit supersession.
- All links and generated facts validate.
- The next developer can identify current state and next action without reading
  historical handoff documents.
