import type { KeywordId } from '@tcg/card-data';

/**
 * What each keyword does *in the engine today*.
 *
 * None of these are confirmed rules. CLAUDE.md §4 lists keyword behaviour as an
 * open design decision, and `docs/open-questions.md` Q4 keeps it open. This
 * table is the single reversible placeholder: changing a keyword's behaviour
 * means changing this table and the handler it names, not hunting through
 * combat code.
 *
 * `implemented: false` means the keyword is inert — it is still authored on
 * cards, still filterable in the deck builder, and still rendered in card text,
 * but the engine deliberately gives it no mechanical effect because inventing
 * one would be guessing at a design decision that has not been made.
 */
export interface KeywordBehaviour {
  readonly id: KeywordId;
  /** Whether the engine currently gives this keyword any mechanical effect. */
  readonly implemented: boolean;
  /** Exactly what the engine does today. Not marketing text. */
  readonly engineBehaviour: string;
}

export const KEYWORD_BEHAVIOUR: Readonly<Record<KeywordId, KeywordBehaviour>> = Object.freeze({
  swift: {
    id: 'swift',
    implemented: true,
    engineBehaviour: 'Ignores summoning sickness: may attack the turn it enters play.',
  },
  evasive: {
    id: 'evasive',
    implemented: true,
    engineBehaviour: 'Cannot be assigned a blocker.',
  },
  armored: {
    id: 'armored',
    implemented: true,
    engineBehaviour:
      'Reduces each separate instance of damage dealt to this unit by ' +
      '`RulesConfig.armoredReduction`, to a minimum of zero. Per instance, not per turn — ' +
      'see open-questions.md Q4.',
  },
  quick_strike: {
    id: 'quick_strike',
    implemented: true,
    engineBehaviour:
      'Deals its combat damage in an earlier damage step. A combatant defeated in that ' +
      'step never deals its own combat damage.',
  },
  venom: {
    id: 'venom',
    implemented: true,
    engineBehaviour: 'Any damage this unit deals to another unit is lethal to that unit.',
  },
  siphon: {
    id: 'siphon',
    implemented: true,
    engineBehaviour: 'Combat damage this unit deals heals its controller by the same amount.',
  },
  resilient: {
    id: 'resilient',
    implemented: false,
    engineBehaviour:
      'INERT. Candidate readings (clear damage at end of turn / survive lethal damage once ' +
      'per turn) differ sharply in power and interact with the "damage persists between ' +
      'turns" rule. Awaiting open-questions.md Q4.',
  },
  guardian: {
    id: 'guardian',
    implemented: false,
    engineBehaviour:
      'INERT. Taunt-style semantics have no meaning in the Phase 2 combat model, because ' +
      'attackers target the opposing player and never choose a unit to attack. Awaiting ' +
      'open-questions.md Q4 and Q10.',
  },
});

/** Keywords the engine currently acts on. Everything else is authored-but-inert. */
export const ACTIVE_KEYWORDS: readonly KeywordId[] = Object.values(KEYWORD_BEHAVIOUR)
  .filter((entry) => entry.implemented)
  .map((entry) => entry.id);

/** Keywords that exist on cards but do nothing yet. Reported by the CLI harness. */
export const INERT_KEYWORDS: readonly KeywordId[] = Object.values(KEYWORD_BEHAVIOUR)
  .filter((entry) => !entry.implemented)
  .map((entry) => entry.id);
