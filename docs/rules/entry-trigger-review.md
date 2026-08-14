# Entry-trigger review — `precon_wave_1`

Ruleset update §7 and `CLAUDE.md` keep `deployed` and `entersBattlefield` as
**different** events and forbid converting one to the other in bulk. Every card
that reacts to its own arrival therefore has to be judged individually. This is
that review, run over `npm run report:triggers -- --set precon_wave_1` on
2026-08-12 (M02.6). It is a record of decisions, not a specification: the cards
themselves are authoritative.

## What the three forms mean in the engine

| Form                             | Fires when                                                                 |
| -------------------------------- | -------------------------------------------------------------------------- |
| `on_deployed` ability            | The card was played from hand for its deployment cost, or a Token arrived. |
| `on_entered_battlefield`         | Any arrival at all, revival included.                                      |
| Top-level `effects` (no trigger) | The **implicit deploy** form (`CLAUDE.md` §17 Q1).                         |

The implicit form is the one worth knowing precisely, because nothing in the
card file names a trigger. It is enqueued from exactly two places — the
play-a-permanent path in `engine.ts` and Token creation in `effects.ts` — and
**not** from `moveToZone`. So a permanent put onto the battlefield by an effect
(`grave_reassembly`) emits `unit_entered_battlefield` and runs no top-level
effects. Verified against the engine while writing this review, not assumed.

## The 21 uses, card by card

### `on_deployed` — 1 use

- **`bastion_armory`** (`issue_barrier`) — correct as printed. "The first
  **Guardian you deploy** each turn gains Barrier" is scoped to _other_ cards
  arriving, and it says "deploy". A Guardian brought back by an effect was not
  deployed and should not be armoured. **No change.**

### `on_entered_battlefield` — 0 uses

Nothing in Wave 1 asks for the wider event by name. That is a real finding
rather than an oversight: no printed card in the set says "however it got here".

### Implicit deploy effects — 20 uses

Fifteen of these print **"When deployed, …"**, which is exactly what the
implicit form does. All confirmed correct with no change:

`bastion_armorer`, `bastion_chaplain`, `bone_carrier`, `containment_warden`,
`corpse_wagon`, `field_analyst`, `grave_robber`, `patrol_scout`,
`pit_executioner`, `refuge_warden`, `rift_displacer`, `rift_scholar`,
`senior_researcher`, `shield_page`, `static_adept`.

Five used to print **"When this Unit enters the battlefield, …"** while behaving
as deploy effects, so their wording promised an arrival the structure does not
honour:

- `goblin_bomb_thrower`
- `goblin_lookout`
- `goblin_mob_caller`
- `goblin_recruiter`
- `goblin_siege_leader`

That was a genuine disagreement, and it was observable: a `goblin_recruiter`
returned to play by `grave_reassembly` creates no Goblin Token, which its printed
text said it should. Confirmed by driving the engine, not inferred.

**Answered as Q48 on 2026-08-14: the prose was corrected, the structure was
not.** All five now print "When deployed, …", which is exactly what the implicit
form does, and every one of the twenty implicit uses is now worded correctly.

The two resolutions were one-line edits and they were not equivalent:

- Correcting the **prose** keeps every current behaviour and makes five cards
  honest. Nothing about the game changes — which is why it was chosen in a
  consistency pass.
- Converting the **structure** to `on_entered_battlefield` would make the cards
  do what they say and hand the Goblin deck a revival payoff it does not have
  today. That is a gameplay change, and it stays out of scope.

The behaviour is therefore unchanged and still verifiable: returning one of the
five with `grave_reassembly` fires no deploy effect. The five were listed
together because they shared one question, **not** because they should be
converted together; if the structural route is ever taken, each still gets its
own judgement about whether revival should re-fire it.

## The drift linter now catches this

When this review was written, `lintDisplayText` checked only that prose and
structure named the same _mechanics_ — all five cards genuinely create Tokens,
deal damage or search, so both directions passed. The mismatch was about
**when**, and a marker for it would have failed the content build for
`precon_wave_1` — a strict `playtest` set — before Q48 was answered. The check
belonged with the answer rather than ahead of it.

Q48 is answered, so the check exists: `display_text/entry_timing` reports a card
whose prose says it arrives on the battlefield while its structure is the
implicit deploy form, and a warning on a `playtest` or `active` card is a build
error. Re-introducing the old wording on any of the five now fails
`npm run content:check`.
