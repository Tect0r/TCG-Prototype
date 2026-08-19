/**
 * What this generator is, and where it can run.
 *
 * Both questions are answered by exported constants rather than by prose,
 * because both of them are cited by something else: `generatorVersion` is a
 * field of `generatedDeckProvenanceSchema` in `@tcg/bot-config`, and the
 * supported runtime is what decides whether a caller may reach this package at
 * all. A statement nobody can read is a statement nobody can check.
 */

/**
 * The construction procedure a generated deck was built by.
 *
 * A string because `generatedDeckProvenanceSchema.generatorVersion` is a string:
 * a recorded deck cites the generator that produced it, and a citation that
 * cannot be compared to anything is not provenance.
 *
 * Bump when the *draw* changes — the weighting, the ordering, the stopping
 * rule — so a deck recorded under an older version is never confused for one
 * this build would produce. Do not bump for a new report field, a new
 * diagnostic, or a move between packages: none of those change which cards come
 * out for a given seed.
 *
 * - `1` — M09.8. The procedure M05.5 left in the simulator, extracted unchanged
 *   and proven byte-equivalent against decks recorded before the move.
 */
export const DECK_GENERATOR_VERSION = '1';

/**
 * Where this package is supported. **Server-side Node only.**
 *
 * This is a declaration, not an aspiration, and M09.8 chose it deliberately
 * over the alternative. Deck identity is a SHA-256 content address taken in
 * `hash.ts` through `node:crypto`; a browser has `crypto.subtle`, but its
 * digest is asynchronous, so making this package portable would mean either an
 * async generator or a second hash implementation — and a second hash
 * implementation is exactly the drift that would let the same seed produce two
 * different deck IDs on two machines.
 *
 * Nothing in M09 needs the browser: generation happens on the authoritative
 * server, and a client is told a Commander and a hash rather than being asked
 * to reproduce a deck. Should a browser caller ever be wanted, the honest fix
 * is to move deck identity onto a hash both runtimes can take synchronously,
 * bump `DECK_GENERATOR_VERSION`, and re-record the goldens — not to quietly add
 * a fallback.
 */
export const SUPPORTED_RUNTIMES = Object.freeze(['node'] as const);
export type SupportedRuntime = (typeof SUPPORTED_RUNTIMES)[number];

/**
 * Every Node built-in this package imports, listed so the claim above is
 * checkable. `runtime.test.ts` reads the package's own sources and fails when a
 * built-in appears that is not named here — which is what stops the declaration
 * from quietly becoming false.
 */
export const NODE_BUILTIN_DEPENDENCIES = Object.freeze(['node:crypto'] as const);

/** True when the current runtime is one this package declares support for. */
export function runtimeIsSupported(): boolean {
  const node = (globalThis as { process?: { versions?: { node?: string } } }).process;
  return typeof node?.versions?.node === 'string';
}
