import { adminError, cursorSchema, timestampSchema, type AdminError } from '@tcg/admin-contracts';
import { err, ok, type Result } from '@tcg/shared';

/**
 * The continuation token, and what it means.
 *
 * `@tcg/admin-contracts` promises a client two things about a cursor: it is
 * opaque, and it cannot spell a path. Both are properties of the *alphabet*, and
 * the schema enforces them. What the schema deliberately does not say is what a
 * cursor encodes — `pagination.ts` says so in as many words: *stability is the
 * store's promise rather than the schema's*. This module is that promise.
 *
 * A cursor is a **position in an ordering**, not an offset. The ordering is
 * `createdAt` then ID, ascending, which is why `timestampSchema` fixes the offset
 * to `Z` and the precision to milliseconds: lexicographic order and chronological
 * order are then the same order, and a position can be expressed as a value
 * rather than as a count. An offset would silently skip or repeat a row whenever
 * an entry was created while a person was paging, and entries are created while
 * people are paging.
 *
 * The encoded form carries its own tag. Nothing has been issued by an earlier
 * build, so there is nothing to migrate; the tag exists so that a later store —
 * the database ADR 0023 §3 keeps the option open for — can refuse a token it did
 * not issue readably instead of decoding it into a position it does not have.
 */

const CURSOR_TAG = 'c1';
/**
 * A space: no ISO timestamp and no admin ID can contain one -- the ID alphabet
 * is [a-z0-9_] and a timestamp is digits with -, :, ., T and Z -- so a decoded
 * token can never be split in the wrong place.
 */
const SEPARATOR = ' ';

export interface CatalogPosition {
  readonly createdAt: string;
  readonly id: string;
}

/**
 * Encodes a position.
 *
 * base64url rather than base64: it has no `/`, no `+` and no `=`, so the output
 * satisfies `cursorSchema` by construction rather than by a check that could be
 * forgotten.
 */
export function encodeCursor(position: CatalogPosition): string {
  const encoded = Buffer.from(
    [CURSOR_TAG, position.createdAt, position.id].join(SEPARATOR),
    'utf8',
  ).toString('base64url');
  return encoded;
}

/**
 * Decodes a position, or refuses the token.
 *
 * Every failure is one error — `admin/invalid_cursor`, the code the contract
 * declares for *a continuation token this build did not issue, or can no longer
 * honour*. A caller has the same recourse in each case, which is to start the
 * listing again, so distinguishing "wrong alphabet" from "wrong tag" would give
 * them nothing and would tell whoever sent it something about the encoding.
 */
export function decodeCursor(token: string): Result<CatalogPosition, readonly AdminError[]> {
  if (!cursorSchema.safeParse(token).success) return err([invalidCursor()]);

  let decoded: string;
  try {
    decoded = Buffer.from(token, 'base64url').toString('utf8');
  } catch {
    return err([invalidCursor()]);
  }

  const parts = decoded.split(SEPARATOR);
  if (parts.length !== 3) return err([invalidCursor()]);
  const [tag, createdAt, id] = parts as [string, string, string];
  if (tag !== CURSOR_TAG) return err([invalidCursor()]);
  if (!timestampSchema.safeParse(createdAt).success) return err([invalidCursor()]);
  if (id.length === 0) return err([invalidCursor()]);

  return ok({ createdAt, id });
}

function invalidCursor(): AdminError {
  return adminError(
    'admin/invalid_cursor',
    'This continuation token was not issued by this catalog, or can no longer be honoured. Start the listing again.',
    { path: 'page.cursor' },
  );
}

/**
 * The catalog's one ordering, in one function.
 *
 * Exported so the store sorts and the cursor compares by the same rule. Two
 * copies of "createdAt then ID" is exactly how a page comes to skip a row: the
 * comparison that placed it and the comparison that decided it was already shown
 * would disagree about a tie.
 */
export function comparePositions(left: CatalogPosition, right: CatalogPosition): number {
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1;
  if (left.id !== right.id) return left.id < right.id ? -1 : 1;
  return 0;
}

/** Whether an entry falls strictly after a cursor's position. */
export const isAfter = (position: CatalogPosition, cursor: CatalogPosition): boolean =>
  comparePositions(position, cursor) > 0;
