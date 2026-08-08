/**
 * Minimal Node ESM resolve hook: maps a relative `./x.js` specifier onto the
 * `./x.ts` source next to it.
 *
 * The repository has no build step for its Node applications — the workspace
 * packages point `main` straight at TypeScript — and Node's own type stripping
 * deliberately does not rewrite extensions. This hook closes exactly that gap
 * and nothing else: it only ever touches relative specifiers that end in `.js`,
 * and it falls through to normal resolution whenever the `.ts` file is absent,
 * so a genuine `.js` file still resolves as itself.
 *
 * Used only by the simulator's worker threads. The main thread runs under
 * `vite-node` (or Vitest), which already resolves TypeScript.
 */
export async function resolve(specifier, context, nextResolve) {
  if (/^\.{1,2}\//.test(specifier) && specifier.endsWith('.js')) {
    try {
      return await nextResolve(`${specifier.slice(0, -3)}.ts`, context);
    } catch {
      // Not a TypeScript source after all; fall through to the real file.
    }
  }
  return nextResolve(specifier, context);
}
