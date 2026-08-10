import { KEYWORD_REGISTRY, IMPLEMENTED_KEYWORDS, UNIMPLEMENTED_KEYWORDS } from '@tcg/card-data';
import type { KeywordId } from '@tcg/card-data';

/**
 * Engineering notes on what each keyword does *in the engine today*.
 *
 * None of these are confirmed rules. CLAUDE.md §4 lists keyword behaviour as an
 * open design decision, and `docs/open-questions.md` Q4 keeps it open. This
 * table is the single reversible placeholder: changing a keyword's behaviour
 * means changing this table and the handler it names, not hunting through
 * combat code.
 *
 * The player-facing definition and the `implemented` flag are **not** duplicated
 * here — both come from `KEYWORD_REGISTRY` in `@tcg/card-data`, so the glossary
 * a player reads and the engine's own record of what is wired up can never
 * drift apart. What stays here is the developer-facing note: which handler owns
 * the behaviour and which open question governs it.
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

/** Developer notes, keyed by keyword. Merged with the registry below. */
const ENGINE_NOTES: Readonly<Record<KeywordId, string>> = {
  rush:
    'derive.isNewlyDeployed bypass in legal-actions.ts, for both attack declaration and ' +
    '`exhaust_source` activation costs. Renamed from `swift` by the v2 → v3 card migration.',
  guardian:
    'legal-actions.ts requires every attacker a ready Guardian could block to be blocked ' +
    'before blockers may be confirmed. ADR 0016 §5.',
  barrier:
    'damage.ts prevents the first non-zero damage event to the unit and clears the flag. ' +
    'Ordered after Overwhelm assignment — ADR 0016 Q-D.',
  overwhelm:
    "combat.ts assigns damage equal to the blocker's current health to the blocker and the " +
    'remainder to the defending player. ADR 0016 Q-D.',
  untargetable_by_opponents:
    'targeting.ts drops the unit from any legal target set computed for an opposing chooser. ' +
    'Non-targeting effects are unaffected.',
  evasive: 'Filtered out of `blocking.attackerInstanceIds` in legal-actions.ts. Open question Q4.',
  armored:
    'damage.ts reduces each instance by `RulesConfig.armoredReduction` before shields. ' +
    'Per instance, not per turn — see open-questions.md Q4.',
  quick_strike: 'combat.ts `stepOf` puts it in the earlier damage step. Open question Q4.',
  venom: 'damage.ts raises marked damage to current health when the `lethal` flag is set.',
  siphon: 'combat.ts accumulates dealt combat damage per controller and calls healPlayer.',
  resilient:
    'INERT. Candidate readings (clear damage at end of turn / survive lethal damage once ' +
    'per turn) differ sharply in power and interact with the "damage persists between ' +
    'turns" rule. Awaiting open-questions.md Q4. No Precon Wave 1 card prints it.',
};

export const KEYWORD_BEHAVIOUR: Readonly<Record<KeywordId, KeywordBehaviour>> = Object.freeze(
  Object.fromEntries(
    Object.values(KEYWORD_REGISTRY).map((keyword) => [
      keyword.id,
      {
        id: keyword.id,
        implemented: keyword.implemented,
        engineBehaviour: ENGINE_NOTES[keyword.id],
      },
    ]),
  ) as Record<KeywordId, KeywordBehaviour>,
);

/** Keywords the engine currently acts on. Everything else is authored-but-inert. */
export const ACTIVE_KEYWORDS: readonly KeywordId[] = IMPLEMENTED_KEYWORDS;

/** Keywords that exist on cards but do nothing yet. Reported by the CLI harness. */
export const INERT_KEYWORDS: readonly KeywordId[] = UNIMPLEMENTED_KEYWORDS;
