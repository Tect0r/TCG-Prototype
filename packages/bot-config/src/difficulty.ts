import { z } from 'zod';

/**
 * Bot difficulty (M09.1).
 *
 * Difficulty is one of **four independent axes** — deck source, difficulty,
 * style and timing — and this file is the whole of one of them
 * ([ADR 0024](../../../docs/architecture/0024-live-bot-seats.md) §5). A Hard bot
 * does not get a better deck, a slow bot is not an Easy bot, and a defensive bot
 * is not a stronger bot. The three shipped styles live in `style.ts` precisely so
 * that they cannot be quietly renamed Easy, Normal and Hard: they are one
 * heuristic pointed at three weight vectors, and ranking them would resurrect
 * the pooled skill axis M05.4 exists to refuse.
 *
 * Two properties are structural rather than conventional:
 *
 * - The registry is a **total** `Record` over `BOT_DIFFICULTIES`, so adding an ID
 *   without deciding its status, its summary and its behaviour version is a
 *   compile error. `difficultyRegistryGaps()` says the same at runtime for
 *   callers that arrive with a string.
 * - A difficulty that has **no decision procedure yet** says so in data. M09.1
 *   defines the vocabulary and implements none of it, so `easy` and `hard` are
 *   `planned` with a `null` behaviour version and name the tranche that owns
 *   them. A lobby refuses a planned difficulty by reading this table rather than
 *   by hard-coding a list of what is finished.
 *
 * **Difficulty is a player-facing label, not an evidence class.** A Hard result
 * is not final-balance evidence and Hard does not become archetype-aware; the
 * agent-class taxonomy in `@tcg/bot-interface` is what decides what a run may be
 * cited for, and nothing here overrides it.
 */

/** Ordered easiest first. The order is the UI's order, and nothing else. */
export const BOT_DIFFICULTIES = ['easy', 'normal', 'hard'] as const;
export const botDifficultySchema = z.enum(BOT_DIFFICULTIES);
export type BotDifficulty = z.infer<typeof botDifficultySchema>;

/**
 * `available` — a build can select it and a bot will fly it.
 * `planned` — the ID exists, the tranche that implements it is named, and
 * selecting it is refused rather than silently downgraded to something else.
 */
export const DIFFICULTY_STATUSES = ['available', 'planned'] as const;
export const difficultyStatusSchema = z.enum(DIFFICULTY_STATUSES);
export type DifficultyStatus = z.infer<typeof difficultyStatusSchema>;

/* ------------------------------------------------------- how it chooses (M09.13) */

/**
 * How a difficulty picks among the *same* scored legal candidates.
 *
 * This is the whole of what a difficulty is. Every difficulty sees the identical
 * candidate list from the identical scorer under the identical style weights;
 * the only thing that varies is which entry of that list it takes. Nothing here
 * can produce an action the engine did not offer, because nothing here produces
 * an action at all — it selects one.
 *
 * The parameters live in this package rather than beside the pilots for the
 * reason `pilotId` does: a lobby has to print what Easy will do and a server has
 * to record which Easy it flew, and neither should have to import a decision
 * procedure to find out. `@tcg/bot-interface` implements these numbers and a
 * test over there proves it honours them.
 */
export const CANDIDATE_SELECTION_KINDS = ['best', 'bounded_error'] as const;
export const candidateSelectionKindSchema = z.enum(CANDIDATE_SELECTION_KINDS);
export type CandidateSelectionKind = z.infer<typeof candidateSelectionKindSchema>;

export const difficultySelectionSchema = z.discriminatedUnion('kind', [
  /** Take the highest-scoring candidate, breaking exact ties on the seat's RNG. */
  z.strictObject({ kind: z.literal('best') }),
  z.strictObject({
    kind: z.literal('bounded_error'),
    /**
     * How far below the best a choice may fall, as a fraction of the spread
     * between the best and worst candidate on offer. `0.5` is the promise "never
     * from the worse half of the range it was given" — a bound relative to the
     * board rather than an absolute score, because a score has no units.
     */
    errorBudget: z.number().min(0).max(1),
    /**
     * The most candidates that are ever eligible, best first. The band is what
     * keeps this a *bounded* degradation rather than a soft uniform sample: on a
     * board offering thirty plays it still only ever considers this many.
     */
    maxBand: z.number().int().min(1),
  }),
]);
export type DifficultySelection = z.infer<typeof difficultySelectionSchema>;

/**
 * Easy's published degradation.
 *
 * Half the range and three candidates: an Easy bot never takes a play from the
 * worse half of what it was offered, and never looks past the third-best. That
 * is deliberately a *statement about the bound* rather than about the outcome —
 * an Easy choice is often the same choice Normal would make, and the honest
 * claim is that it is never much worse, not that it is always worse.
 *
 * It is not uniform random over legal actions, it cannot return an illegal one,
 * and it cannot concede: a concession scores `-Infinity` and is excluded from
 * the band before anything is picked.
 */
export const EASY_SELECTION: DifficultySelection = Object.freeze({
  kind: 'bounded_error',
  errorBudget: 0.5,
  maxBand: 3,
});

export interface DifficultyDefinition {
  readonly id: BotDifficulty;
  readonly label: string;
  /** What the difficulty *is*, in one sentence a lobby can print. */
  readonly summary: string;
  readonly status: DifficultyStatus;
  /** The tranche that owns it. Non-null for everything still `planned`. */
  readonly plannedIn: string | null;
  /**
   * The version of this difficulty's own decision procedure, so a result that
   * cites `hard` can say *which* Hard. `null` while nothing implements it.
   */
  readonly behaviorVersion: string | null;
  /**
   * How it chooses among the scored candidates, and `null` while nothing
   * implements it — the same rule `behaviorVersion` follows, so the two cannot
   * disagree about whether a difficulty exists yet.
   */
  readonly selection: DifficultySelection | null;
}

export const DIFFICULTY_REGISTRY: Readonly<Record<BotDifficulty, DifficultyDefinition>> =
  Object.freeze({
    easy: {
      id: 'easy',
      label: 'Easy',
      summary:
        'Bounded, deterministic suboptimality over the same scored legal candidates. Not uniform ' +
        'random, not an illegal action, not free concession, and not deliberate non-participation.',
      status: 'available',
      plannedIn: null,
      behaviorVersion: '1.0.0',
      selection: EASY_SELECTION,
    },
    normal: {
      id: 'normal',
      label: 'Normal',
      summary:
        'The published heuristic for the chosen style, unchanged. The baseline every other ' +
        'difficulty is described as a difference from.',
      status: 'available',
      plannedIn: null,
      behaviorVersion: '1.0.0',
      // Literally the selection the heuristic has always made, named rather than
      // reimplemented, which is what makes "Normal is unchanged" checkable.
      selection: { kind: 'best' },
    },
    hard: {
      id: 'hard',
      label: 'Hard',
      summary:
        'A versioned improvement on named calibration gaps, choosing better among the same legal ' +
        'candidates. It reads no hidden state, and a Hard result is not a balance finding.',
      status: 'planned',
      // Its behaviour exists — `hard_tactical` in `@tcg/bot-interface` is at
      // `1.1.0` and closes six of the twenty-four calibration boards Normal
      // misses — but a difficulty is not a profile, and nothing here may quietly
      // become one. Publishing it needs a field this registry does not have,
      // which is exactly why it cannot happen by accident: `selection` and
      // `behaviorVersion` are still null, so `difficultySelection('hard')`
      // throws by name and a lobby's list still does not contain it.
      //
      // What is left is a decision rather than an implementation. M09.15 closed
      // two of the three strategic gaps it owned and recorded the third; no
      // threshold for "good enough to ship" was ever written down, and inventing
      // one is not an engineering call. Recorded as owner question Q50.
      plannedIn: 'M09.16',
      behaviorVersion: null,
      selection: null,
    },
  });

export function difficultyDefinition(difficulty: BotDifficulty): DifficultyDefinition {
  return DIFFICULTY_REGISTRY[difficulty];
}

/**
 * How this difficulty chooses, for a caller that is about to build a pilot.
 *
 * Throws rather than falling back to `best`, because a silent fallback is how a
 * planned difficulty ends up quietly playing as Normal while a lobby, a seat
 * label and a match record all say it did not.
 */
export function difficultySelection(difficulty: BotDifficulty): DifficultySelection {
  const definition = DIFFICULTY_REGISTRY[difficulty];
  if (definition.selection === null) {
    throw new Error(
      `Difficulty "${definition.label}" is planned for ${definition.plannedIn ?? 'a later tranche'} ` +
        'and has no decision procedure behind it.',
    );
  }
  return definition.selection;
}

export function difficultyIsAvailable(difficulty: BotDifficulty): boolean {
  return DIFFICULTY_REGISTRY[difficulty].status === 'available';
}

/** In registry order, so a lobby's list is the same list every time. */
export const AVAILABLE_DIFFICULTIES: readonly BotDifficulty[] =
  BOT_DIFFICULTIES.filter(difficultyIsAvailable);

export const PLANNED_DIFFICULTIES: readonly BotDifficulty[] = BOT_DIFFICULTIES.filter(
  (difficulty) => !difficultyIsAvailable(difficulty),
);

/**
 * Runtime twin of the type-level totality check, in the shape
 * `agentClassGaps()` established: the `Record` type already fails a build that
 * forgets an ID, and this catches the other direction — an entry for an ID the
 * vocabulary no longer has — and reports every problem at once instead of the
 * first.
 */
export function difficultyRegistryGaps(): string[] {
  const problems: string[] = [];
  const known = new Set<string>(BOT_DIFFICULTIES);

  for (const key of Object.keys(DIFFICULTY_REGISTRY)) {
    if (!known.has(key)) problems.push(`difficulty "${key}" is defined but not in the list.`);
  }
  for (const difficulty of BOT_DIFFICULTIES) {
    const definition = DIFFICULTY_REGISTRY[difficulty];
    if (definition.id !== difficulty) {
      problems.push(`difficulty "${difficulty}" is filed under the wrong key.`);
    }
    if (definition.status === 'planned') {
      if (definition.plannedIn === null) {
        problems.push(`planned difficulty "${difficulty}" does not name the tranche that owns it.`);
      }
      if (definition.behaviorVersion !== null) {
        problems.push(
          `planned difficulty "${difficulty}" carries a behaviour version, but nothing implements it.`,
        );
      }
      if (definition.selection !== null) {
        problems.push(
          `planned difficulty "${difficulty}" declares how it chooses, but nothing implements it.`,
        );
      }
      continue;
    }
    if (definition.behaviorVersion === null) {
      problems.push(`available difficulty "${difficulty}" does not declare a behaviour version.`);
    }
    if (definition.selection === null) {
      problems.push(`available difficulty "${difficulty}" does not say how it chooses.`);
      continue;
    }
    // Parsed rather than trusted: the registry is a hand-written literal, and
    // `errorBudget: 1.5` would type-check and silently mean "anything at all".
    const selection = difficultySelectionSchema.safeParse(definition.selection);
    if (!selection.success) {
      problems.push(
        `difficulty "${difficulty}" declares an unreadable selection: ` +
          selection.error.issues.map((issue) => issue.message).join('; '),
      );
    }
  }
  return problems;
}

export function assertDifficultyRegistryComplete(): void {
  const problems = difficultyRegistryGaps();
  if (problems.length > 0) {
    throw new Error(`Difficulty registry is out of date:\n- ${problems.join('\n- ')}`);
  }
}
