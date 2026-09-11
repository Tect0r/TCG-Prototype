# M10 — Prepared Reactions and Three-Event Timing

Status: **Draft milestone specification. Do not start while M08 or its correction pass is active.**

When M10 is scheduled, place this document at
`docs/milestones/M10-prepared-reactions-and-neutral-spells.md` and add exactly
one M10 status row to `IMPLEMENTATION_PLAN.md`. The root plan remains the only
work queue. This supplied file is a session brief, not a second queue and not a
repository-root document.

The original draft was grounded against `Tect0r/TCG-Prototype` `main` at
`3b966f2cbac999d311506d77a4d91ab82bd51e1d` on 2026-09-04 while M08 was still
active. It was revised after the owner replaced the old six authored timing
labels with three recognizable event windows and approved one bounded
response-to-Reaction opportunity. Revalidate every count, version, path and
baseline statement against the branch when M10 opens. Current code and passing
tests outrank this draft.

## How Claude must execute this milestone

M10 uses **large coherent tranches**, **small implementation slices**, and one
review after each tranche.

- One implementation slice is one Sonnet session and one coherent checkpoint
  commit. Keep it comfortably below 150,000 tokens.
- Read `CLAUDE.md`, the M10 status row in `IMPLEMENTATION_PLAN.md`, the
  concise current-work entry, this document's exact active slice, and only
  directly relevant code. Do not reload the complete milestone history each
  session.
- Revalidate the named slice before editing. If later work already completed it,
  prove and record that instead of reimplementing it.
- Run focused semantic tests inside ordinary slices. Update the concise current
  state, commit, push and stop. Never continue into the next slice.
- Do not run Opus or the whole repository gate after every implementation slice.
- Each tranche ends with a fresh tranche-close session: revalidate the combined
  range, run the full gates, request one bounded `tcg-reviewer` review, fix
  material findings, obtain `VERDICT: APPROVE`, update the canonical record,
  commit and push.
- Use one sequential Claude Code workflow. Do not create parallel implementers.
- Preserve unrelated user changes and never reset or discard them.

The shared close procedure appears near the end of this document.

## Preconditions and scheduling

M10 may open only when all of the following are true:

1. M08 and its correction work are complete, committed and pushed, with a green
   verification run for the exact final SHA.
2. The worktree is clean and local `main` matches the intended remote base.
3. The four current 40-card singleton precons load and finish matches through
   the ordinary server-authoritative path.
4. The AI Lab can run the precon matrix, Commander-constrained construction and
   open construction experiments required by M10.7. If M08 shipped less, first
   re-scope M10.7 honestly rather than inventing a parallel lab.
5. Current rules, card, match, protocol, spectator/replay, telemetry and admin
   contract versions are measured from code constants.

M10 runs before the intended 50-card expansion. It establishes the real
Reaction rules and rebalances current cards so later content is authored against
the final timing model.

## Objective

M10 makes Reactions visible, preparable commitments while keeping the option to
hold them as fully hidden surprises.

1. Replace the old combat-checkpoint timing model with three understandable
   event windows: an opponent deploys a Unit, you are attacked, or an opponent
   casts a Spell.
2. Permit a bounded exchange: initial responders act once, then the player who
   caused the event may make one final authored rebuttal if somebody responded.
   The window then closes permanently.
3. Keep direct play from hand for the Reaction's full effective Energy cost.
4. During either Main Phase, allow a Reaction to be prepared face down by
   spending all but one of its effective cost and locking the final one Energy.
5. Prepared Reactions persist, arm only after the preparation turn ends and use
   their authored event/role permissions without paying again.
6. Use the one-Energy lock as a soft capacity limit; add no fixed Prepared Zone
   slots.
7. Keep prepared identity private from opponents, bots and live spectators.
8. Make generic utility Spells and Reactions trend neutral while efficient,
   faction-defining and synergy-dependent cards remain colored.
9. Extend clients, bots, replay, telemetry and AI Lab evidence without hidden
   information advantages.

## Locked owner decisions

These are implementation requirements, not questions for individual sessions.
Reopen one only if current code proves it impossible or a direct test exposes a
material contradiction.

### Card taxonomy

- `spell` remains a first-class type played during the active player's Main
  Phase. It resolves and goes to discard.
- `reaction` remains a first-class type. Only a Reaction card may be played in
  a Reaction window.
- Units, ordinary Spells, Relics, Tokens and Commanders never become Reactions
  merely because their controller has priority.
- Every Reaction supports both storage modes: direct from hand and face-down in
  the Prepared Zone. Do not introduce `quickcast`, `prepared_only` or a
  second Reaction card type.
- The rules/code term is **Prepared Zone**. A compact UI label may say
  **Prepared Reactions**. Do not call it a Spell Zone.

### Three base event windows

There are exactly three player-facing event windows. A response to a Reaction is
a stage inside the same window, never a fourth window.

#### A. Opponent deploys a Unit

- The event is a player manually deploying a Unit card from hand or deploying a
  Commander from the Command Zone.
- Commander deployment counts; Relic deployment does not.
- Token creation, revival, returning a card to the battlefield, copying,
  transformation and any Unit entering through an effect do not open this
  window.
- The deployment transaction, entry instructions, entry triggers and any
  required choices resolve completely first. If they end the match, no window
  opens.
- The Unit is already a public battlefield object when the window opens. This
  answers the new threat; it does not counter the summon or cancel its entry
  effect.
- Exactly one window may follow one manually deployed card. A Unit creating
  several Tokens still produces at most that one window.
- Initial responders are the deploying player's living opponents.

#### B. You are attacked

- Attackers and defending players are confirmed first. Attack exhaustion and
  authored `on_attack` work settle before the window.
- The window opens before blockers are chosen.
- Only living players targeted by at least one declared attacker are initial
  responders. Unattacked third parties are excluded.
- A multi-defender attack uses one shared window, with eligible defenders in
  deterministic clockwise order.
- After the window closes, defenders assign blockers and combat proceeds through
  damage and aftermath. There is no after-block or post-combat window.
- The attacker is the event initiator and may receive the final rebuttal if at
  least one attacked player responds.

#### C. Opponent casts a Spell

- The Spell is revealed and all casting choices, Energy and additional costs are
  committed before the window opens.
- The Spell waits unresolved as the base subject.
- Initial responders are the caster's living opponents. The caster is never an
  initial responder to their own Spell.
- Countering never refunds the Spell's Energy or additional costs.
- After the window drains, the Spell resolves if not countered and then follows
  the ordinary discard path.

### Conditional opening and accepted information leak

- A window opens only when at least one initial responder has a legal,
  affordable matching Reaction in hand or an armed matching Reaction prepared.
- Rebuttal-only cards held by the initiator do not cause a window to open.
- Players without a legal action are skipped and are not asked to pass.
- This intentionally reveals the coarse fact that somebody can respond. It does
  not reveal identity, cost, color, target, timing details or source zone.
- The UI may show the same brief non-interactive “Checking Reactions…” transition
  for every eligible event so ordinary latency is not an obvious tell. It must
  not manufacture an engine window or human timeout.

### Bounded response and rebuttal

The game does not use Magic's repeatable priority loop. One window has at most
two stages.

#### Initial-response stage

- Eligible responders are ordered clockwise after the event initiator.
- Each is offered priority at most once.
- Each may play at most one Reaction or pass.
- Passing is final; playing never restarts the order or re-offers a seat.
- Later responders see already committed public Reactions and may answer them
  only if their authored card is legal.

#### Initiator-rebuttal stage

- If nobody played a Reaction, the initiator receives no offer.
- If one or more opponents responded, the initiator receives at most one final
  opportunity.
- Only a Reaction explicitly authored for the `rebuttal` role and legal in the
  base event may be offered. The initiator cannot exploit this stage for an
  unrelated utility Reaction.
- A rebuttal may protect the original action or answer a pending opposing
  Reaction only where its authored effects and targets are legal.
- Playing or passing ends the window permanently. Opponents never answer the
  final rebuttal.

#### Resolution

- Committed Reactions resolve newest first.
- The initiator's rebuttal therefore resolves first when played.
- In a Spell event the original Spell sits beneath the Reactions and resolves
  last if it survives.
- Deployment and attack events have no pending original card: their base event
  already committed.
- No item can be interrupted after it begins resolving.

Maximum committed Reactions are bounded:

- two-player event: one opponent response plus one initiator rebuttal;
- four-player deployment/Spell: three opponent responses plus one rebuttal;
- attack: one per attacked defender plus one attacker rebuttal.

### Authored timing contract

Do not keep the six old timing labels under new display names. Replace them with
a structured contract representing:

- base event: `unit_deployed`, `attackers_declared`, or `spell_cast`;
- permitted role: `response`, `rebuttal`, or both;
- optional subject restrictions;
- target/effect legality evaluated against authoritative state.

A recommended shape is a Reaction block with unique non-empty `events` and
`roles` arrays. Exact names may follow repository conventions. Relative facts
such as “opponent” and “you are attacked” must be enforced by engine eligibility,
not by display text.

Migration rules:

- old pre-block labels map to the attack event only when semantically valid;
- old after-block/post-combat cards require authored review, not blind mapping;
- old Spell timing maps to Spell response with opponent relation enforced;
- no old card gains rebuttal permission through a default.

Validation refuses a Reaction with no event or role. Display/consistency checks
reject wording for removed windows.

### Direct play from hand

- A Reaction in hand is playable only from a current engine-supplied response or
  rebuttal offer.
- It pays its complete effective Energy cost then and remains hidden until
  committed.
- It enters the same pending/resolution path as a prepared Reaction.
- A player commits at most one Reaction in the entire event window.

### Preparing a Reaction

- Preparation is allowed during either Main Phase of the active player's turn
  while no choice/resolution blocks ordinary Main-Phase actions.
- The card must be a Reaction in that player's hand with a calculable effective
  cost.
- Let `C` be the effective cost after valid reductions/floors. Preparation
  requires at least `C` available Energy.
- It spends `C - 1` and locks exactly one. All `C` immediately becomes
  unavailable.
- A future zero-cost Reaction may cost zero directly, but preparation treats
  `C` as one and still requires/locks one.
- Store the cost snapshot, spent amount and lock. Do not recompute the historic
  transaction after board changes.
- A once-per-cycle Reaction discount is consumed when it discounts preparation.
  Continuous discounts count only at preparation time.
- Preparing removes the card from hand and chooses no targets, creates no
  pending item and runs no effect.

### Arming, persistence and capacity

- A Reaction cannot activate during the turn it was prepared.
- It becomes armed when that turn ends, using turn state rather than a clock.
- It persists until activation, voluntary discard, controller elimination or a
  future explicit mechanic.
- At Ready Step, available Energy refreshes to normal maximum minus one for each
  surviving prepared lock.
- Locks are ongoing capacity commitments, not repeated spending.
- There is no fixed Prepared Zone slot limit.
- Players may lock all available Energy; the UI warns but the engine permits it.
- M10 adds no opponent inspection, destruction, theft, reordering or targeting
  of face-down prepared cards.

### Activating and discarding prepared Reactions

- An armed prepared card is offered only when event, role, subject and targets
  are legal.
- Targets/choices occur at activation, not preparation.
- Activation reveals it, converts its lock to spent Energy, enters the shared
  pending line and moves it to discard after resolution.
- Removing the lock on activation gives no Energy immediately; capacity returns
  at the next Ready Step.
- A targetless/unusable prepared card is not offered and remains prepared.
- During either Main Phase, its owner may voluntarily discard it. Public discard
  reveals it and returns exactly the one locked Energy immediately; `C - 1`
  is never refunded.
- A prepared card cannot voluntarily return to hand, reorder or atomically
  exchange for another hidden card.

### Additional costs

- Future non-Energy Reaction costs are chosen, validated and paid on activation,
  never preparation.
- At the original baseline, validation rejected additional costs on Reactions
  and no shipped Reaction used one.
- M10 does not implement unused machinery. Keep validation truthful until an
  authored fixture proves selection, priority, atomic payment and resolution.

### Hidden information

Public view exposes controller, stable face-down slot/order, count, locked
Energy, armed state and committed prepare/arm/discard/reveal/Energy events.

It does not expose definition, name, art, text, color, printed/effective cost,
event/role permissions, legal targets or reconstructable private metadata.

The owner sees identities. Bots receive the same opponent redaction as humans.
Live spectators see backs. Canonical admin/post-match telemetry may retain
identity but cannot expose it live. Participant replay preserves original
seat-specific knowledge and does not reveal unused prepared cards after a match.

### Neutral and colored identity

- Do not target a neutral percentage.
- Generic, broadly useful utility should usually be neutral.
- Efficient broad answers, faction mechanics, tribal references, archetype
  engines and signature effects should remain colored.
- Neutral strength comes from conditions, narrowness, symmetry, cost or a real
  drawback—not deliberate inferiority.
- Colored synergy supplies the deck's main plan; neutrals fill gaps and answer a
  metagame.
- Near-universal neutral inclusion is a warning requiring usage/matchup context,
  not automatic proof.
- Goblins remain red; M10 does not remap them green or add a fifth precon.

### Modular UI assets and components

All UI follows:

```text
visual asset → reusable stateful component → flexible layout composition
```

- Prepared cards, backs, zone frames, counters, controls, target markers and
  overlays are independent components/assets.
- Board backgrounds contain no baked-in functional slots, counters, labels or
  targeting lines.
- Text, numbers, accessibility names, hit areas and state are not baked into
  raster images.
- Replaceable PNG/SVG skins are separate from component layout/behavior.
- Components accept viewer-relative face/back, owner/opponent, armed state,
  selection/targetability, orientation and size.
- Overlays anchor to components rather than absolute board coordinates.
- The same components support two-to-four players without redrawing assets.
- M10 builds its Prepared/Reaction surfaces, not the complete later board
  redesign.

## Worked examples

### Cost 5 prepared

At 6/6 Energy, preparing a cost-5 Reaction spends four and locks one, leaving
one available. At a later Ready Step with maximum 7, it refreshes to six
available plus one locked. Activation consumes the lock without a current-turn
refund. Voluntary discard returns the one lock immediately; the four spent
remains spent.

### Cost 1 prepared

Zero non-locked Energy is spent and one is locked. It is not free: every later
Ready Step provides one less available Energy until activation or discard.

### Cost 3 direct

The card stays hidden in hand. On a legal offer, its controller pays three,
reveals it and adds it to the pending line. No persistent lock exists.

### Spell response and rebuttal

1. A pays for and casts a Spell.
2. B plays one legal Reaction intended to counter it.
3. Because B responded, A gets one final offer and plays a rebuttal protecting
   the Spell.
4. The window closes; B cannot answer again.
5. A's rebuttal resolves, then B's Reaction, then the Spell if it survives.

If B has no legal response, no engine window opens and A receives no offer to
respond to their own Spell.

### Four-player split attack

A attacks B and D but not C. B and D respond in clockwise order; C is excluded.
Each may commit one. If either acts, A may make one final authored rebuttal.
Then Reactions resolve and B/D choose blockers.

## Baseline to revalidate when M10 opens

This is the old implementation M10 intentionally replaces:

- Original Wave 1 had 42 Spells and 10 Reactions: four neutral Spells, zero
  neutral Reactions; Reactions blue 4, white 5, red 1, black 0.
- Reactions cost 1–5.
- Six timing values produced three combat pauses plus a Spell pause:
  `after_attackers_declared`, `before_blockers_declared`,
  `after_blockers_declared`, `after_combat_damage`, `after_combat`,
  `when_opponent_plays_spell`.
- The engine did not structurally enforce “opponent” in Spell timing, so the
  caster could receive an initial offer against their own Spell.
- Priority started active player first and went clockwise once. M10 replaces it
  with opponent/defender response followed by bounded initiator rebuttal.
- `play_reaction` accepted hand only; state/views/protocol/replay had no
  Prepared Zone or locks.
- Cost-discount cards require full preparation/direct/rebuttal audit.
- Telemetry had no source mode, new event or rebuttal data.
- Historical observed versions were rules 1.0.0, protocol 11, match 7, card 5,
  spectator replay 6, board telemetry 3 and match telemetry 6. Re-measure; never
  bump from this sentence.

## Compatibility and version plan

All changed boundaries reject future data with the project's readable
“written by a newer build / update the application” behavior.

| Contract                        | Expected treatment                 | Reason                                                       |
| ------------------------------- | ---------------------------------- | ------------------------------------------------------------ |
| `RULES_VERSION`                 | Semantic move justified in ADR     | Three events, rebuttal and Prepared Energy replace rules     |
| `CARD_SCHEMA_VERSION`           | Bump plus migration/refusal        | Timing discriminants/roles change; Prepared may widen ZoneId |
| `MATCH_SCHEMA_VERSION`          | Bump plus migration                | Prepared records, locks and staged windows are durable       |
| `PROTOCOL_VERSION`              | Bump                               | Actions, offers, views and event stages change               |
| `SPECTATOR_REPLAY_VERSION`      | Bump if stored shape changes       | Face-down knowledge and event stages must parse honestly     |
| `TELEMETRY_SCHEMA_VERSION`      | Bump plus owned policy             | Source mode, events, locks and rebuttal are recorded         |
| Report/manifest versions        | Only where persisted shapes change | Readers/writers must agree                                   |
| `BOARD_TELEMETRY_VERSION`       | Only if its payload changes        | Do not force ownership                                       |
| `CONTENT_BUNDLE_SCHEMA_VERSION` | Normally unchanged                 | Card stamps are not bundle-envelope shape                    |
| `ADMIN_CONTRACT_VERSION`        | Only if admin fields change        | Internal telemetry alone is not admin wire                   |

Do not guess-migrate an old open window into response/rebuttal state. If safe
migration is impossible, refuse that transient match state honestly. Adding
`prepared` to shared ZoneId must not let authored effects/targets name it.

## Required invariants

1. Every card instance is in exactly one authoritative zone.
2. Prepared records, instance zone, owner/controller and one lock agree.
3. Energy stays within zero and refreshed maximum minus locks.
4. Preparation removes `C` available and records `C - 1` spent plus one
   locked.
5. Activation removes a lock without refund; discard returns exactly one.
6. Prepared order, arming and identity survive serialization/reconnect/replay.
7. Hidden prepared identity/permissions never enter opponent/bot/spectator
   definitions, DOM, accessibility or errors.
8. Unarmed, wrong-event, wrong-role or targetless cards are never offered.
9. Only legal initial responders determine whether a window opens.
10. Each responder is offered once and commits at most one.
11. Initiator receives nothing when nobody responded.
12. After a response, initiator gets at most one legal authored rebuttal offer.
13. Initiator action/pass closes the window; nobody is re-offered.
14. Caster cannot initially respond to their own Spell.
15. Unattacked seats cannot respond to attack.
16. Tokens/effect entries/Relics cannot open Unit-deployment windows.
17. Entry work completes before deployment response.
18. Attack response completes before blockers; no later combat window exists.
19. Spell effects wait below Reactions.
20. Direct/prepared activation share one pending-resolution path.
21. Bots/clients act only from engine-supplied offers.

## Scope exclusions

M10 does not:

- add a Magic-like stack or repeatedly circulating priority;
- open a new window in response to a Reaction;
- let opponents answer the final rebuttal;
- allow non-Reaction card types to react;
- counter summons or cancel completed entry effects;
- open deployment windows for Tokens, revival or effect entries;
- restore after-block, after-damage or post-combat windows;
- add fixed Prepared capacity or non-Reaction bluff cards;
- add prepared-card inspection, destruction, stealing, reordering or targeting;
- implement unused Reaction additional costs without authored need/approval;
- remap Goblins, add a fifth precon or expand 40-card decks to 50;
- author a large package to satisfy timing/color quotas;
- redesign the full match board;
- declare balance from one rate;
- change M08 experiments to hide inconvenient evidence.

## Tranche map

| Tranche | Outcome                                                  | Slices | Close |
| ------- | -------------------------------------------------------- | ------ | ----- |
| M10.1   | Rules, ADR, timing/state/action schemas and migrations   | A–D    | E     |
| M10.2   | Three-event engine, bounded rebuttal and Prepared Energy | A–E    | F     |
| M10.3   | Privacy, protocol, server, replay and spectator          | A–C    | D     |
| M10.4   | Modular Prepared/Reaction interface                      | A–C    | D     |
| M10.5   | Legal bots and decision-useful telemetry                 | A–C    | D     |
| M10.6   | Card conversion, neutral identity and help               | A–C    | D     |
| M10.7   | Evidence, playtest and closure                           | A–C    | D     |

## M10.1 — Rules and contract foundation

### M10.1A — Revalidate and record

Recount current cards/timing, trace play/entry/attack/queue/priority paths,
measure versions/migrations, locate all stale wording and confirm M08/remote
preconditions. Add the next ADR for the three events, response→rebuttal state
machine, conditional opening and Prepared Energy. Update confirmed/open rules,
plan and concise current work. No runtime/schema changes. Commit, push, stop.

### M10.1B — Card timing schema and migration

Replace old timing discriminants with non-empty unique event/role data. Enforce
removed values/text, opponent/attacked relation capability and future refusal.
Migrate only semantically identical cases; do not blindly map after-block or
post-combat cards or grant rebuttal. Regenerate required stamps and inspect the
bounded diff.

Focused tests: all supported versions, future refusal, removed/empty/duplicate
values, no default rebuttal, structural opponent relation and content staging.
Commit, push, stop.

### M10.1C — Prepared and staged window state

Add Prepared records with stable slot/order, cost snapshot, spent/lock, prepared
turn and armed state. Add base event, initiator, eligible/completed responders,
response count, stage, pending line and resume point to durable window state.
Keep Prepared outside generic targets. Define migration/refusal, elimination and
match-complete cleanup.

Focused tests: round trips, invalid ownership/zone/lock, ordering, older state,
future state and old-open-window policy. Commit, push, stop.

### M10.1D — Actions, legal offers and events

Add/extend `prepare_reaction`, `discard_prepared_reaction`,
`play_reaction` with source/stage/offer identity, stage-safe pass, Main-Phase
prepared actions, response/rebuttal offers, and public prepare/arm/lock/discard/
reveal/window events. Stale IDs, wrong source/stage and private references refuse
atomically. Clients cannot submit eligibility. Commit, push, stop.

### M10.1E — Tranche close

Use the common close procedure. Review migrations, relative eligibility,
removed-window wording and hidden leakage. Close only after approval; name
M10.2A.

## M10.2 — Deterministic engine behavior

### M10.2A — Unit deployment event

Open only after manual Unit/Commander deployment and completed entry work.
Exclude Relics, Tokens, revival/copy/effect entries; one window maximum per
deployed card. Initiator is deployer, potential responders are living opponents,
and only legal initial offers open it.

Test ordinary Unit, Commander, entry choice, Token producer, revival, Relic,
source leaving, match end, no response and 2–4 players. Commit, push, stop.

### M10.2B — Attack event and removed combat windows

After confirmed attackers, settle exhaustion/attack triggers and derive unique
attacked living defenders. Offer them clockwise, drain before blockers, and
delete after-block/post-combat openings. Test no/split/repeated attackers,
unattacked third party, elimination, attacker removal, blocker legality and no-
Reaction trace. Commit, push, stop.

### M10.2C — Spell event and opponent relation

Commit choices/costs, keep the Spell pending below Reactions, exclude caster,
preserve counter/no-refund and resolve directly without opponent offers.
Test cost-filtered counter, caster holding same response, additional costs,
target invalidation, multi-opponent order and discard. Commit, push, stop.

### M10.2D — Response, rebuttal and resolution

Offer initial responders clockwise once; passes survive plays. Track real
responses, skip initiator if none, otherwise offer exactly one legal authored
rebuttal. Initiator play/pass closes forever. Drain newest-first and resume.

Test the canonical Spell/counter/protection case, rebuttal-only card not opening,
initiator lacking rebuttal, responder pass then later play, three responders,
stale actions, max-one and deterministic completion. Commit, push, stop.

### M10.2E — Prepare, lock, arm, activate and discard

Implement atomic preparation, spent/locked accounting, Ready refresh, end-turn
arming, direct/prepared offers, reveal/lock consumption, voluntary discard,
discounts, full lockout, elimination and refusal atomicity.

Test costs 0/1/5, multiple locks, both Main Phases, wrong turn, same-turn
activation, direct/prepared parity, response/rebuttal from each source, no target
and elimination. Commit, push, stop.

### M10.2F — Tranche close

Run serialization/replay determinism plus common close. Review every event
boundary, queue order, removed window and Energy mutation. Close only after
approval; name M10.3A.

## M10.3 — Privacy, protocol and live server

### M10.3A — Viewer-specific redaction

Owner views receive prepared identity/offers; opponents, bots and live
spectators receive stable backs, armed state and public counts. Rebuttal
eligibility/errors cannot expose hidden candidates. Reconnect restores identical
knowledge and definition maps contain only visible definitions.

Mutate hidden identities under identical public state and prove opponent/bot/
spectator bytes, DOM and accessibility remain identical. Commit, push, stop.

### M10.3B — Protocol and authoritative server

Carry prepare, discard, response, rebuttal and pass through real protocol.
Server binds actor/match/offer/source/instance, emits fresh per-viewer state and
atomically refuses stale, duplicate, wrong-player/stage, unarmed, unaffordable or
private requests. Update handshake/refusal behavior and preserve reconnect,
elimination and bot scheduling. Use websocket integration. Commit, push, stop.

### M10.3C — Spectator and replay

Record/render backs, locks, arm changes, three events, stages and resolution.
Reveal only on commitment/public discard. Preserve seat-specific replay,
join-in-progress privacy and stored-version policy.

Test owner/opponent/spectator/replay matrices for every source/stage, unused
match end and reconnect. Commit, push, stop.

### M10.3D — Tranche close

Review compatibility, noninterference, server authority and replay knowledge.
Close after common procedure/approval; name M10.4A.

## M10.4 — Player interface

### M10.4A — Modular Prepared Zone

Build Prepared Zone, card/back, lock and armed markers as independent reusable
components. Owner sees face/inspection; others see the shared back. Use the
existing renderer/fallback with replaceable skin. Preserve order, summarize
overflow, accept orientation/size/viewer state and prevent accessible hidden
text.

Test empty/one/many, owner/opponent/spectator and 2–4 players. Commit, push,
stop.

### M10.4B — Preparation and Energy controls

Offer `Spend C-1 now; lock 1`, distinguish available/maximum/locked with
labels, warn on zero available, explain direct full cost/prepared activation and
`Recover 1 locked Energy; spent Energy is not refunded`. Consume only
authoritative offers and disable on submit.

Test keyboard/touch, double/stale submit, discounts, costs 1/5, lockout and
reconnect. Commit, push, stop.

### M10.4C — Three-event response/rebuttal flow

Use only “Unit deployed,” “You are attacked,” and “Spell cast.” Show the same
brief Checking transition without fake waits. Identify public subject and
priority, distinguish Respond from Final rebuttal, state that rebuttal cannot be
answered, and render pending public items newest-first. Spell stays visibly
under responses; attack returns to blockers; deployment says entry work already
completed. Remove all later combat prompts. Keep human timing separate from bot
pacing. Anchor targets to components for split attacks/four seats.

Test no-window, direct/prepared response, rebuttal/no rebuttal, pass, multiple
responders, responsive/accessibility, reconnect and spectator. Commit, push,
stop.

### M10.4D — Tranche close

Review comprehension, hidden DOM, authoritative legality, modularity, four-seat
readability and unnecessary pauses. Close after approval; name M10.5A.

## M10.5 — Bots and telemetry

### M10.5A — Bot legality

Add candidates for prepare, discard, direct/prepared response/rebuttal and pass,
strictly from engine offers. Record event/stage/source provenance, preserve
seeds/fallback and forbid hidden-opponent inspection.

Test round trips, wrong source/stage, unarmed/private cards, hidden-state
noninterference and seeded 2–4 bot completion with zero illegal actions. Commit,
push, stop.

### M10.5B — Tactical valuation

Value preparation by event likelihood, effect, tempo, lock and coverage; value
direct surprise/rebuttal without hidden knowledge; penalize redundancy/dead
coverage/lockout. Add calibration for prepare versus develop, hold direct Energy,
defend a valuable action, decline weak rebuttal, discard dead preparation and
avoid lethal lockout. Version profiles only where owned behavior moves. Commit,
push, stop.

### M10.5C — Telemetry

Record preparations; direct/prepared and response/rebuttal use; base events;
offers/passes/skips without live identity; cost/spend/lock; prepared/armed/used/
discard turns; duration prepared; unused end state; average/max count/locks;
self-lockout; chain length/duration; rebuttal offer/play/result; and prepared
context/recent events at surrender.

Collect authoritatively, align simulator/live facts, bound admin projections,
version storage and never label correlation causation. Commit, push, stop.

### M10.5D — Tranche close

Review legality, hidden information, determinism, attribution, bounds and
versions. Close after approval; name M10.6A.

## M10.6 — Existing cards and player-facing rules

### M10.6A — Semantic card audit

Audit every current Spell/Reaction: ID/name, color/precon, generic versus
signature purpose, efficiency/synergy, proposed event/role, direct/prepared use,
proposed text/cost/color/effect and risk.

Explicit starting points:

- `emergency_interposition`, `mass_displacement` and
  `unbreakable_formation`: attack-response candidates.
- `hold_the_line`: must work before blockers or be redesigned.
- `orderly_withdrawal` and `punish_the_assault`: attack-window delayed
  aftermath or coherent redesign; no post-combat window.
- `calculated_response` and `narrow_denial`: blue Spell-answer candidates;
  assess rebuttal permission.
- `phase_withdrawal` and `scatter`: choose events/roles deliberately.
- At least one shipped card must exercise Unit response and one rebuttal.

Generic cards may become neutral, but blue control, white Guardian and red
Goblin identity remain colored where mechanics justify them. Record/review the
audit without editing card data. Commit, push, stop.

### M10.6B — Conversion and rebalance

Convert all Reactions to new events/roles. Rewrite removed timing with existing
delayed mechanics where coherent. Grant rebuttal only to cards that defend the
initiating action or answer pending Reaction. Ensure shipped Unit response and
rebuttal paths. Reprice for preparation/rebuttal; audit discounts; recolor only
generic identities. Preserve IDs and 40-card singleton lists; neutrality does
not add cards everywhere. Regenerate content and inspect drift.

Test every changed contract/text, all events/roles/storage modes, precon legality,
ID stability and bundle diff. Commit, push, stop.

### M10.6C — Help and terminology

Explain the three events, exclusions, deployment-after-entry timing, attack-
before-blockers, response then final rebuttal, conditional-opening tell,
newest-first resolution, direct/prepared costs, lock/arming/refresh/discard,
privacy and neutral/colored identity. Add cost and rebuttal examples.

Update rulebook, glossary, references, contextual help, relevant README/card
text. Remove stale six-window, later-combat, active-first, hand-only and circular
response claims. Commit, push, stop.

### M10.6D — Tranche close

Review every current Spell/Reaction for timing, role, identity, efficiency and
text. Reviewer may not impose a neutral quota or invent a large package. Close
after approval; name M10.7A.

## M10.7 — Evidence, playtest and closure

### M10.7A — Automated evidence

Using canonical M08 jobs/results:

1. Seat-balanced precon matrix with at least 200 scheduled matches per unordered
   pairing, evenly oriented where supported.
2. At least 500 Commander-constrained construction matches across four current
   Commanders.
3. At least 500 open-construction matches with bot-selected Commander/deck.
4. Fixed recorded seed, content hash, rules/pilot/difficulty/style provenance
   and termination counts.

Report win rates/sample uncertainty; neutral inclusion/play; source/stage/event
use; window frequency/chain length/duration; rebuttal offers/use/success;
locks/prepared counts; unused/discard/self-lockout; duration/illegal/unfinished/
surrender context; universal or unused cards.

Investigation flags, not automatic nerfs:

- neutral inclusion above roughly 70% across independently generated eligible
  decks;
- direct or prepared mode above roughly 85% when both are materially available;
- seat-balanced precon matchup persistently outside roughly 40–60;
- initiator rebuttals making successful responses exceptionally rare;
- frequent maximum four-player chains or materially longer matches;
- locks associated with stalls/concentrated surrender;
- any illegal action, hidden dependence or unfinished match.

Record result addresses/interpretation; do not edit cards. Commit, push, stop.

### M10.7B — Structured manual playtest

Cover every precon as human deck and at least one 3–4 seat table. Capture whether
players understand the three events, entry effects resolving first, attack
response before blockers, answer plus final unanswerable rebuttal, conditional
information tell, locks, direct versus preparation, many backs, arming/discard,
duration, confusing pauses, defects and surrender reason. Separate defect,
presentation, friction and balance suspicion. Commit record, push, stop.

### M10.7C — One bounded correction

Fix correctness/privacy/migration/legality/determinism/help defects and high-
confidence comprehension failures. Make at most one bounded rate/color pass
supported by combined evidence. Re-run focused tests/smallest experiments.
Record remaining balance hypotheses for 50-card expansion. Stop for owner if
evidence challenges the three events, deployment timing, responder set,
one-lock economy, no capacity or bounded rebuttal. Commit, push, stop.

### M10.7D — Final close

Run common close over M10.7, then full acceptance. Update plan, milestone, audit
and next task only after approval. Next intended task is 50-card expansion unless
evidence names a correctness blocker.

## Milestone acceptance matrix

### Rules and engine

- [ ] Exactly three base events exist in schema, engine, cards and help.
- [ ] Unit/Commander response opens after entry work; exclusions never open it.
- [ ] Attack response occurs before blockers; no later combat window exists.
- [ ] Spell response occurs after costs/before effects; caster is not initial.
- [ ] Initial responders act clockwise once and at most one each.
- [ ] Initiator is offered only after a response and at most once.
- [ ] Only authored legal rebuttals appear; initiator action closes permanently.
- [ ] Resolution is newest-first and deterministic.
- [ ] Every Reaction supports direct and prepared storage.
- [ ] Preparation/lock/refresh/arming/activation/discard match examples with no
      fixed cap.
- [ ] Discounts snapshot/consume once; serialization/migration/replay pass.

### Privacy and compatibility

- [ ] Opponent/bot/spectator cannot recover hidden identity, permissions/targets.
- [ ] Owner/reconnect retains correct identity/offers.
- [ ] Public events reveal only committed facts.
- [ ] Every changed contract has justified versioning, migration and refusal.
- [ ] Older supported data migrates without guessed semantics.

### Interface

- [ ] Prepared cards are modular cards/backs, not text boxes or board-baked slots.
- [ ] Functional text/state remains separate from replaceable images.
- [ ] Available/maximum/locked Energy is labeled without color alone.
- [ ] Prepare/direct/discard consequences appear before confirmation.
- [ ] Three events and response/final-rebuttal stages are clear.
- [ ] No-window events avoid unnecessary engine waits.
- [ ] 2–4 player layouts work with many prepared cards and split attacks.
- [ ] Help/accessibility leaks no hidden identity or accidental action.

### Bots and evidence

- [ ] Pilots finish seeded matches legally from authoritative views/offers.
- [ ] Hidden opponent identity cannot change decisions under identical public
      state.
- [ ] Telemetry distinguishes event, stage, source, locks and surrender context.
- [ ] Automated evidence/manual playtest are recorded with provenance.
- [ ] No rate alone is called causal or balanced.

### Cards and documentation

- [ ] Every current Spell/Reaction was semantically audited.
- [ ] Every Reaction has valid events/roles and truthful text.
- [ ] At least one shipped deployment response and rebuttal exist.
- [ ] Generic-versus-signature identity—not quota—governs neutrality.
- [ ] Four 40-card singleton precons remain legal; IDs remain stable.
- [ ] Generated content contains no unexplained drift.
- [ ] Rulebook/glossary/help/README/ADR/confirmed rules agree.
- [ ] No live document claims removed windows or unimplemented interaction.

### Final gates

- [ ] `npm run content:check`
- [ ] `npm run validate:content`
- [ ] `npm run check:consistency`
- [ ] `npm run audit:check`
- [ ] `npm run verify`
- [ ] clean `git status --porcelain`
- [ ] bounded `tcg-reviewer` verdict: `VERDICT: APPROVE`
- [ ] every close/final record committed and pushed
- [ ] GitHub verification green for the exact final SHA

## Tranche-close procedure

1. In a fresh Sonnet session identify first parent and implementation tip.
2. Revalidate the bounded range against the tranche and locked rules.
3. Inspect bounded stats/names/hunks, not generated bundle/full history dumps.
4. Run content check, content validation, consistency, audit and verify as
   applicable. Full gates belong at tranche close.
5. Update evidence only from passing results; leave close record uncommitted.
6. Ask `tcg-reviewer` once over the range and close-record diff with named risk.
7. On `CHANGES REQUIRED`, fix, retest and request one bounded recheck. Stop
   after two cycles if blockers remain.
8. Only after `APPROVE`, mark complete/name next slice, commit and push.
9. Report behavior/paths, tests, commits, push, verdict, blockers and next slice.

## Stop conditions

Stop and ask the owner if:

- M08 is incomplete or M10 needs unfinished M08 behavior;
- code requires another public event window;
- implementation would move deployment response before entry work, include
  effect entries, restore later combat windows or let caster initially respond;
- priority would re-offer a responder, let opponents answer final rebuttal or
  permit unrelated initiator utility;
- implementation changes one lock, adds fixed capacity/expiry or permits
  same-turn activation;
- public/replay privacy cannot prevent identity leakage;
- migration would discard or guess state;
- unused additional costs require unresolved choice/priority interleaving;
- evidence calls for core redesign rather than bounded correction;
- unrelated dirty-tree work overlaps;
- compaction occurs before a safe tested checkpoint.

## Required final report

Return commits by tranche; files by behavior/schema/content/UI/bot/tests/docs;
delivered event/rebuttal/Energy behavior; versions/migrations/refusals; focused
and aggregate tests with counts/Node/clean tree; evidence/playtest locations;
review verdict and green GitHub SHA/URL; remaining owner decisions; and the next
bounded task without starting it.

## Reusable continuation prompt

> Continue the TCG Prototype milestone workflow. First inspect the current
> branch, worktree, recent commits and remote state. Read `CLAUDE.md`, only the
> execution rule and status row in `IMPLEMENTATION_PLAN.md`, the concise current
> work entry, and only the exact next named slice in the active milestone file.
> Revalidate that slice against current code before changing anything. If it is
> already complete, verify and record it rather than reimplementing it. Complete
> exactly one implementation slice or one explicitly named tranche-close run;
> do not continue into the next slice in the same session. Keep the session
> comfortably below 150k tokens through targeted searches, bounded reads and
> concise output. For a normal slice, run focused semantic checks only, update
> only that slice's evidence/current-state note, commit a coherent checkpoint,
> push according to repository convention and stop. For a tranche-close run,
> revalidate the combined tranche, run the required full gates, obtain the one
> bounded `tcg-reviewer` review, resolve material findings, then commit/push the
> close record only after approval. Finish by reporting changed behavior and
> paths, exact verification, commit/push result, blockers and exact next slice.

M10 is complete only when code, cards, UI, bots, telemetry, help, local gates and
the pushed GitHub gate all describe the same three-event Prepared Reaction
system.
