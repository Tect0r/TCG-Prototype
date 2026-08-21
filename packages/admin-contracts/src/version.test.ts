import { describe, expect, it } from 'vitest';

import {
  ADMIN_CONTRACT_VERSION,
  ADMIN_VERSION_FIELDS,
  CATALOG_DOCUMENT_VERSION,
  CURRENT_ADMIN_VERSIONS,
  catalogDocumentVersionSchema,
  contractVersionSchema,
  isFutureVersion,
  refuseFutureVersion,
  type AdminVersionField,
} from './version.js';

/**
 * Every "one greater than" below is derived from the constant rather than
 * written as a number, so bumping a version does not silently turn a
 * future-version test into a current-version one.
 */
const SCHEMAS: Readonly<Record<AdminVersionField, typeof contractVersionSchema>> = {
  contract: contractVersionSchema,
  catalogDocument: catalogDocumentVersionSchema,
};

describe('the admin version constants', () => {
  it('are positive integers', () => {
    for (const field of ADMIN_VERSION_FIELDS) {
      const value = CURRENT_ADMIN_VERSIONS[field];
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(1);
    }
  });

  it('are exactly two, and each is owned by a named schema', () => {
    // ADR 0023 §7 asks for two version domains and no more: a version with no
    // artifact to own it is a number nobody can disagree over.
    expect([...ADMIN_VERSION_FIELDS].sort()).toEqual(['catalogDocument', 'contract']);
    for (const field of ADMIN_VERSION_FIELDS) {
      expect(SCHEMAS[field].parse(CURRENT_ADMIN_VERSIONS[field])).toBe(
        CURRENT_ADMIN_VERSIONS[field],
      );
    }
  });

  it('expose the same numbers through the map and through the constants', () => {
    expect(CURRENT_ADMIN_VERSIONS.contract).toBe(ADMIN_CONTRACT_VERSION);
    expect(CURRENT_ADMIN_VERSIONS.catalogDocument).toBe(CATALOG_DOCUMENT_VERSION);
  });

  it('are frozen, so nothing can move one at runtime', () => {
    expect(Object.isFrozen(CURRENT_ADMIN_VERSIONS)).toBe(true);
  });
});

describe('current versions round-trip', () => {
  it('accepts the version this build stamps, for every field', () => {
    for (const field of ADMIN_VERSION_FIELDS) {
      const parsed = SCHEMAS[field].parse(CURRENT_ADMIN_VERSIONS[field]);
      expect(parsed).toBe(CURRENT_ADMIN_VERSIONS[field]);
      expect(refuseFutureVersion(field, parsed, 'version')).toBeNull();
    }
  });

  it('refuses a neighbouring version at the schema, in both directions', () => {
    for (const field of ADMIN_VERSION_FIELDS) {
      const current = CURRENT_ADMIN_VERSIONS[field];
      expect(SCHEMAS[field].safeParse(current + 1).success).toBe(false);
      expect(SCHEMAS[field].safeParse(current - 1).success).toBe(false);
    }
  });
});

describe('a future version is refused readably', () => {
  it('names the found and supported versions in safe structured context', () => {
    for (const field of ADMIN_VERSION_FIELDS) {
      const found = CURRENT_ADMIN_VERSIONS[field] + 1;
      const refusal = refuseFutureVersion(field, found, 'documentVersion');
      expect(refusal).not.toBeNull();
      if (refusal === null) continue;
      expect(refusal.code).toBe('admin/unsupported_version');
      expect(refusal.message).toContain('written by a newer build');
      expect(refusal.message).toContain('Update the application.');
      expect(refusal.message).toContain(String(found));
      expect(refusal.message).toContain(String(CURRENT_ADMIN_VERSIONS[field]));
      expect(refusal.path).toBe('documentVersion');
      expect(refusal.context).toEqual({
        field,
        found,
        supported: CURRENT_ADMIN_VERSIONS[field],
      });
    }
  });

  it('uses the wording the rest of the repository already refuses with', () => {
    // The sentence is `@tcg/bot-config`'s, copied rather than imported so an
    // admin failure is not reported under a bot seat's error code.
    const refusal = refuseFutureVersion('contract', ADMIN_CONTRACT_VERSION + 1, 'contractVersion');
    expect(refusal?.message).toMatch(
      /^This record was written by a newer build \(admin contract version \d+; this build reads up to \d+\)\. Update the application\.$/,
    );
  });

  it('names the domain that failed, so two versions cannot be confused', () => {
    const contract = refuseFutureVersion('contract', ADMIN_CONTRACT_VERSION + 1, 'v');
    const document = refuseFutureVersion('catalogDocument', CATALOG_DOCUMENT_VERSION + 1, 'v');
    expect(contract?.message).toContain('admin contract version');
    expect(document?.message).toContain('admin catalog document version');
  });

  it('refuses a version far ahead as readily as the next one', () => {
    const refusal = refuseFutureVersion('contract', ADMIN_CONTRACT_VERSION + 1000, 'v');
    expect(refusal?.code).toBe('admin/unsupported_version');
  });
});

describe('the future-version predicate stays narrow', () => {
  it('is true of an integer greater than what this build reads', () => {
    for (const field of ADMIN_VERSION_FIELDS) {
      expect(isFutureVersion(field, CURRENT_ADMIN_VERSIONS[field] + 1)).toBe(true);
    }
  });

  it('is false of the current version and of every older one', () => {
    for (const field of ADMIN_VERSION_FIELDS) {
      expect(isFutureVersion(field, CURRENT_ADMIN_VERSIONS[field])).toBe(false);
      expect(isFutureVersion(field, 0)).toBe(false);
      expect(isFutureVersion(field, -1)).toBe(false);
    }
  });

  it('is false of every value that is not a readable version at all', () => {
    // A missing field, a string, a fraction and a zero are ordinary malformed
    // values, and must keep whatever the boundary already says about those.
    for (const found of [undefined, null, '2', 1.5, Number.NaN, {}, [], true]) {
      expect(isFutureVersion('contract', found)).toBe(false);
    }
  });
});

describe('an unreadable version is a different refusal', () => {
  it('reports a missing version rather than a future one', () => {
    for (const found of [undefined, null, '1', 0, -3, 1.5, Number.NaN]) {
      const refusal = refuseFutureVersion('catalogDocument', found, 'documentVersion');
      expect(refusal?.code).toBe('admin/missing_version');
      expect(refusal?.message).toContain('does not declare a readable');
      expect(refusal?.message).toContain('admin catalog document');
    }
  });

  it('names the supported version but not the unreadable value it found', () => {
    // The value is unusable by definition, and echoing an arbitrary payload back
    // into an error body is how one escapes.
    const refusal = refuseFutureVersion('contract', { nested: 'payload' }, 'contractVersion');
    expect(refusal?.context).toEqual({ field: 'contract', supported: ADMIN_CONTRACT_VERSION });
  });
});

describe('no play-contract version is reachable from here', () => {
  it('does not depend on a package that owns one', async () => {
    // `PROTOCOL_VERSION`, `MATCH_SCHEMA_VERSION`, `RULES_VERSION` and the
    // `@tcg/bot-config` constants do not move for M08.1, and the strongest form
    // of that claim is that this package cannot see them.
    const manifest = (await import('../package.json', { with: { type: 'json' } })) as {
      readonly default: { readonly dependencies: Readonly<Record<string, string>> };
    };
    expect(Object.keys(manifest.default.dependencies).sort()).toEqual(['@tcg/shared', 'zod']);
  });
});
