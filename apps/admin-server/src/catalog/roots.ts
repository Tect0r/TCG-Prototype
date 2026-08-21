import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import {
  adminError,
  experimentDirectorySchema,
  resultRootIdSchema,
  type AdminError,
  type ResultLocation,
} from '@tcg/admin-contracts';
import { err, ok, type Result } from '@tcg/shared';

/**
 * Where the store is allowed to write, and where a run is allowed to have been
 * written — resolved from configuration, never from a request.
 *
 * [ADR 0023](../../../../docs/architecture/0023-admin-lab-boundary.md) §5 states
 * the rule this module implements: *a request never names a filesystem path; it
 * names an identifier that the server resolves. The resolved real path is
 * checked to be inside its configured root, and symlink escape is rejected
 * rather than followed.*
 *
 * The first half is already structural — `@tcg/admin-contracts` has no request
 * shape with a place to put a path, and its own boundary test keeps it that way.
 * This module is the second half, and it is needed because a `rootId` and a
 * relative directory *can* be persisted, so a catalog document written by hand,
 * restored from a backup, or produced by a future tranche that forgot the rule
 * is a real way for a path to arrive.
 *
 * ## Three checks, and why one is not enough
 *
 * 1. **The identifier is configured.** An unknown `rootId` resolves to nothing
 *    at all rather than to a default, so a missing configuration entry is a
 *    refusal instead of a write somewhere plausible.
 * 2. **The directory is spellable.** `experimentDirectorySchema` already refuses
 *    `..`, absolute prefixes, drive letters and backslashes, and it is applied
 *    again here rather than trusted from the document, because the document may
 *    not have come from this build.
 * 3. **The real path is inside the real root.** The first two are lexical, and a
 *    symlink is not a lexical construct: `results/run-1` can be a link to
 *    somewhere else entirely and every character of it is legal. Resolving both
 *    sides with `realpath` and comparing is the only check that sees it.
 *
 * ## What an error may say
 *
 * Nothing here puts a resolved path into a message or into error context. The
 * context vocabulary in `@tcg/admin-contracts` would refuse it — a value
 * containing a separator is rejected outright rather than redacted — but a
 * refusal that depended on that would be reporting a defect rather than not
 * having one. The identifier is what a person can act on anyway: they configured
 * it.
 */

export interface CatalogRootsInput {
  /** Where batch documents, job documents and job event logs live. */
  readonly catalogRoot: string;
  /** Each configured result root, by the identifier a document may name. */
  readonly resultRoots: Readonly<Record<string, string>>;
}

export interface ResolvedCatalogRoots {
  readonly catalogRoot: string;
  readonly resultRoots: ReadonlyMap<string, string>;
}

/**
 * Validates configuration once, at startup, so every later resolution is a
 * lookup.
 *
 * Absolute paths are required rather than resolved against the working
 * directory: a service whose roots move when it is started from a different
 * directory would make "inside its configured root" a claim about whoever
 * launched it.
 */
export function resolveCatalogRoots(
  input: CatalogRootsInput,
): Result<ResolvedCatalogRoots, readonly AdminError[]> {
  const problems: AdminError[] = [];

  if (!isAbsolute(input.catalogRoot)) {
    problems.push(
      adminError(
        'admin/unsafe_result_reference',
        'The catalog root must be configured as an absolute path, so it does not move with the working directory.',
        { path: 'catalogRoot' },
      ),
    );
  }

  const roots = new Map<string, string>();
  for (const [rootId, path] of Object.entries(input.resultRoots)) {
    if (!resultRootIdSchema.safeParse(rootId).success) {
      problems.push(
        adminError(
          'admin/unsafe_result_reference',
          `A result root is named by identifier, and \`${rootId.slice(0, 40)}\` is not a legal one.`,
          { path: 'resultRoots' },
        ),
      );
      continue;
    }
    if (!isAbsolute(path)) {
      problems.push(
        adminError(
          'admin/unsafe_result_reference',
          `The result root \`${rootId}\` must be configured as an absolute path.`,
          { path: 'resultRoots', context: { rootId } },
        ),
      );
      continue;
    }
    roots.set(rootId, resolve(path));
  }

  if (problems.length > 0) return err(problems);
  return ok({ catalogRoot: resolve(input.catalogRoot), resultRoots: roots });
}

/**
 * The real path of the longest existing prefix, with the rest appended
 * unresolved.
 *
 * A result directory is often checked before it has been created, and `realpath`
 * fails outright on a path that does not exist. Resolving what exists and
 * carrying the remainder means a link *anywhere on the way down* is followed and
 * seen, which is the case that matters: the escape is normally an existing
 * parent directory that is a link, not the leaf.
 */
async function realpathOfExistingPrefix(target: string): Promise<string> {
  const missing: string[] = [];
  let current = resolve(target);
  for (;;) {
    try {
      const real = await realpath(current);
      return missing.length === 0 ? real : join(real, ...missing);
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(target);
      missing.unshift(basename(current));
      current = parent;
    }
  }
}

/**
 * Whether `candidate` is the root itself or something under it.
 *
 * `relative` rather than `startsWith`, because `startsWith` reports
 * `/results-archive` as inside `/results`, and because on Windows the comparison
 * has to ignore case — which `relative` already does and a string comparison
 * does not.
 */
function isInside(root: string, candidate: string): boolean {
  const step = relative(root, candidate);
  return step === '' || (!step.startsWith('..') && !isAbsolute(step));
}

/**
 * Turns a stored `rootId` and relative directory into a real path, or refuses.
 *
 * The returned path is for the server's own use — reading a manifest, listing a
 * replay — and is never part of an answer that leaves the process.
 */
export async function resolveResultLocation(
  roots: ResolvedCatalogRoots,
  location: ResultLocation,
): Promise<Result<string, readonly AdminError[]>> {
  const configured = roots.resultRoots.get(location.rootId);
  if (configured === undefined) {
    return err([
      adminError(
        'admin/unsafe_result_reference',
        `No result root named \`${location.rootId}\` is configured, so this run cannot be located.`,
        { path: 'result.location.rootId', context: { rootId: location.rootId } },
      ),
    ]);
  }

  if (!experimentDirectorySchema.safeParse(location.directory).success) {
    return err([
      adminError(
        'admin/unsafe_result_reference',
        'A result directory is a short relative path of plain segments. This one is not, so it was not resolved.',
        { path: 'result.location.directory', context: { rootId: location.rootId } },
      ),
    ]);
  }

  const realRoot = await realpathOfExistingPrefix(configured);
  const candidate = resolve(configured, ...location.directory.split('/'));

  // The lexical check first: it is cheap, and it catches a `..` that the schema
  // would have refused had the document come from this build.
  if (!isInside(realRoot, resolve(candidate))) {
    return err([unsafeReference(location.rootId)]);
  }

  const real = await realpathOfExistingPrefix(candidate);
  if (!isInside(realRoot, real)) return err([unsafeReference(location.rootId)]);

  return ok(real);
}

function unsafeReference(rootId: string): AdminError {
  return adminError(
    'admin/unsafe_result_reference',
    `This run's directory resolves outside the configured result root \`${rootId}\`, so it was refused rather than followed.`,
    { path: 'result.location', context: { rootId } },
  );
}
