import { CATALOG_DOCUMENT_VERSION } from '@tcg/admin-contracts';

/**
 * Migrations `readDocument` applies to a parsed-but-not-yet-validated catalog
 * document before its version check or its schema ever see it (M08.R3).
 *
 * `CATALOG_DOCUMENT_VERSION`'s own history
 * (`@tcg/admin-contracts/src/version.ts`) records why the 4 → 5 move is the
 * first version this file needs to carry: it is additive — every batch and
 * job document a v4 build ever wrote already parses under the v5 schemas
 * unchanged in content, because `jobSpecSchema`'s existing shape became the
 * `experiment` branch of a wider discriminated union and `jobOriginSchema`
 * only gained a fourth member — so the only rewrite a v4 document needs is
 * its own `documentVersion` field, done once, in place, the first time the
 * document is read. A v3 document or older still has no migration and is
 * still refused with the older-build sentence.
 */
const MIGRATABLE_FROM = 4;

/**
 * Rewrites a v4 catalog document's `documentVersion` to the current version.
 * `null` when this document is not a v4 document, in which case it is read
 * exactly as it was written — including the "no migration for this version"
 * refusal a genuinely older or newer document still gets.
 */
export function migrateCatalogDocument(parsed: unknown): unknown | null {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (record.documentVersion !== MIGRATABLE_FROM) return null;
  return { ...record, documentVersion: CATALOG_DOCUMENT_VERSION };
}
