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
}

export const DIFFICULTY_REGISTRY: Readonly<Record<BotDifficulty, DifficultyDefinition>> =
  Object.freeze({
    easy: {
      id: 'easy',
      label: 'Easy',
      summary:
        'Bounded, deterministic suboptimality over the same scored legal candidates. Not uniform ' +
        'random, not an illegal action, not free concession, and not deliberate non-participation.',
      status: 'planned',
      plannedIn: 'M09.13',
      behaviorVersion: null,
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
    },
    hard: {
      id: 'hard',
      label: 'Hard',
      summary:
        'A versioned improvement on named calibration gaps, choosing better among the same legal ' +
        'candidates. It reads no hidden state, and a Hard result is not a balance finding.',
      status: 'planned',
      plannedIn: 'M09.15',
      behaviorVersion: null,
    },
  });

export function difficultyDefinition(difficulty: BotDifficulty): DifficultyDefinition {
  return DIFFICULTY_REGISTRY[difficulty];
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
    } else if (definition.behaviorVersion === null) {
      problems.push(`available difficulty "${difficulty}" does not declare a behaviour version.`);
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
