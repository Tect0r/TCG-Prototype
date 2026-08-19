/**
 * `@tcg/deck-generator` — one deterministic legal deck generator.
 *
 * Extracted from `apps/simulator/src/deck-search/` in M09.8 so the search and a
 * live lobby build decks the same way instead of two ways. What came with it is
 * exactly what generation needs — the deck value and its legality check, deck
 * plan resolution and conformance, and the content hash a deck is identified
 * by. What stayed behind is everything that *searches*: mutation, crossover,
 * fitness, populations across generations, checkpoints.
 *
 * Three properties this package is responsible for:
 *
 * - **Determinism.** A seed and an environment decide a deck. Nothing here
 *   reads a clock, a process ID or `Math.random()`.
 * - **Legality without repair.** `validateDeck` is the final authority, and a
 *   deck that cannot be made legal is refused by a named code rather than
 *   patched from outside the format's pool.
 * - **A stated runtime.** Node only, because deck identity is a synchronous
 *   SHA-256. See `version.ts`; the claim is checked by `runtime.test.ts`.
 */

export {
  DECK_GENERATOR_VERSION,
  NODE_BUILTIN_DEPENDENCIES,
  SUPPORTED_RUNTIMES,
  runtimeIsSupported,
  type SupportedRuntime,
} from './version.js';

export { generationEnvironmentForFormat, type GenerationEnvironment } from './environment.js';

export {
  HASH_VERSION,
  canonicalJson,
  deckHash,
  digest,
  digestOf,
  type HashableDeck,
} from './hash.js';

export {
  DECK_CONSTRUCTION_KINDS,
  checkDeck,
  deckConstructionKindSchema,
  deckConstructionSchema,
  deckSize,
  fromSavedDeck,
  makeDeck,
  normalizeEntries,
  simDeckSchema,
  toMatchDeck,
  toSavedDeck,
  withConstruction,
  type DeckConstruction,
  type DeckConstructionKind,
  type DeckLegality,
  type SimDeck,
  type SimDeckInput,
} from './deck.js';

export {
  PlanResolutionError,
  archetypeLabel,
  conformanceOf,
  corePackages,
  describeArchetype,
  isPackageIntact,
  resolvePlan,
  resolvePlanForPrecon,
  type ResolvedPackage,
  type ResolvedPlan,
} from './plan.js';

export {
  GENERATION_PROBLEM_CODES,
  generateDeck,
  generatePopulation,
  generatorConfigSchema,
  isFullSize,
  poolFor,
  poolReportFor,
  type GenerationDiagnostic,
  type GenerationPoolReport,
  type GenerationProblemCode,
  type GenerationResult,
  type GeneratorConfig,
  type GeneratorConfigInput,
  type RngState,
} from './generate.js';
