import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import {
  ADMIN_CONTRACT_VERSION,
  ADMIN_VERSION_FIELDS,
  CATALOG_DOCUMENT_VERSION,
  CURRENT_ADMIN_VERSIONS,
  JOB_EVENT_VERSION,
  SAVED_CHOICE_VERSION,
  catalogDocumentVersionSchema,
  contractVersionSchema,
  isFutureVersion,
  jobEventVersionSchema,
  refuseForeignVersion,
  refuseFutureVersion,
  refusePastVersion,
  savedChoiceVersionSchema,
  type AdminVersionField,
} from './version.js';

/**
 * Every "one greater than" below is derived from the constant rather than
 * written as a number, so bumping a version does not silently turn a
 * future-version test into a current-version one.
 */
const SCHEMAS: Readonly<Record<AdminVersionField, z.ZodType<number>>> = {
  contract: contractVersionSchema,
  catalogDocument: catalogDocumentVersionSchema,
  jobEvent: jobEventVersionSchema,
  savedChoice: savedChoiceVersionSchema,
};

describe('the admin version constants', () => {
  it('are positive integers', () => {
    for (const field of ADMIN_VERSION_FIELDS) {
      const value = CURRENT_ADMIN_VERSIONS[field];
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(1);
    }
  });

  it('are exactly four, and each is owned by a named schema', () => {
    // A version with no artifact to own it is a number nobody can disagree over.
    // The third joined in M08.2 with the artifact that needed it: the per-job
    // event log is appended to and never rewritten, so a build reads lines
    // written by every build before it, which the rewritten-in-place document
    // beside it never has to do. The fourth joined in M08.8 on the same test: a
    // saved builder form holds a preset choice and nothing about a run, so its
    // shape moves when a *builder* gains a control, and stamping it with the
    // catalog's number would make adding a knob to a form unread every batch.
    expect([...ADMIN_VERSION_FIELDS].sort()).toEqual([
      'catalogDocument',
      'contract',
      'jobEvent',
      'savedChoice',
    ]);
    for (const field of ADMIN_VERSION_FIELDS) {
      expect(SCHEMAS[field].parse(CURRENT_ADMIN_VERSIONS[field])).toBe(
        CURRENT_ADMIN_VERSIONS[field],
      );
    }
  });

  it('expose the same numbers through the map and through the constants', () => {
    expect(CURRENT_ADMIN_VERSIONS.contract).toBe(ADMIN_CONTRACT_VERSION);
    expect(CURRENT_ADMIN_VERSIONS.catalogDocument).toBe(CATALOG_DOCUMENT_VERSION);
    expect(CURRENT_ADMIN_VERSIONS.jobEvent).toBe(JOB_EVENT_VERSION);
    expect(CURRENT_ADMIN_VERSIONS.savedChoice).toBe(SAVED_CHOICE_VERSION);
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

  it('names the domain that failed, so three versions cannot be confused', () => {
    const contract = refuseFutureVersion('contract', ADMIN_CONTRACT_VERSION + 1, 'v');
    const document = refuseFutureVersion('catalogDocument', CATALOG_DOCUMENT_VERSION + 1, 'v');
    const event = refuseFutureVersion('jobEvent', JOB_EVENT_VERSION + 1, 'v');
    expect(contract?.message).toContain('admin contract version');
    expect(document?.message).toContain('admin catalog document version');
    expect(event?.message).toContain('admin job event version');
    expect(new Set([contract?.message, document?.message, event?.message]).size).toBe(3);
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

describe('an older version is refused readably too', () => {
  it('says so in the counterpart sentence, without pretending to migrate', () => {
    // M08.4 is the first tranche to move `CATALOG_DOCUMENT_VERSION`, so a v1 job
    // document is now a thing that can be read from disk. Without this it would
    // fail its `z.literal` as `admin/schema` \u2014 *expected 2, received 1* \u2014
    // which tells a person nothing about what happened.
    const refusal = refusePastVersion('catalogDocument', CATALOG_DOCUMENT_VERSION - 1, 'v');
    expect(refusal?.code).toBe('admin/unsupported_version');
    expect(refusal?.message).toContain('written by an older build');
    expect(refusal?.message).toContain('no migration');
    expect(refusal?.context).toEqual({
      field: 'catalogDocument',
      found: CATALOG_DOCUMENT_VERSION - 1,
      supported: CATALOG_DOCUMENT_VERSION,
    });
  });

  it('answers nothing about the current version, a future one, or a non-version', () => {
    for (const field of ADMIN_VERSION_FIELDS) {
      expect(refusePastVersion(field, CURRENT_ADMIN_VERSIONS[field], 'v')).toBeNull();
      expect(refusePastVersion(field, CURRENT_ADMIN_VERSIONS[field] + 1, 'v')).toBeNull();
    }
    for (const found of [undefined, null, '1', 0, -3, 1.5, Number.NaN]) {
      expect(refusePastVersion('catalogDocument', found, 'v')).toBeNull();
    }
  });

  it('leaves the two refusals disjoint, so a caller can ask both in order', () => {
    // Exactly one of them answers any given value, which is what makes
    // `refuseFutureVersion(...) ?? refusePastVersion(...)` a total rule.
    for (const found of [0, 1, 2, 3, 99, '1', null, undefined, 1.5]) {
      const future = refuseFutureVersion('catalogDocument', found, 'v');
      const past = refusePastVersion('catalogDocument', found, 'v');
      expect(future !== null && past !== null).toBe(false);
    }
  });
});

describe('a version this build reads but does not own', () => {
  it('gets the same two sentences, under a name that is not an admin field', () => {
    // `CONFIG_SCHEMA_VERSION` is `@tcg/simulator`'s. ADR 0023 \u00a77 asks for the
    // treatment, not for the admin surface to adopt the number.
    expect(refuseForeignVersion('experiment configuration', 1, 1, 'schemaVersion')).toBeNull();
    expect(
      refuseForeignVersion('experiment configuration', 2, 1, 'schemaVersion')?.message,
    ).toContain('written by a newer build');
    expect(
      refuseForeignVersion('experiment configuration', 1, 2, 'schemaVersion')?.message,
    ).toContain('written by an older build');
  });

  it('names the record rather than an admin version field in its context', () => {
    const refusal = refuseForeignVersion('experiment configuration', 9, 1, 'schemaVersion');
    expect(refusal?.context).toEqual({
      record: 'experiment configuration',
      found: 9,
      supported: 1,
    });
    expect(Object.keys(refusal?.context ?? {})).not.toContain('field');
  });

  it('reports an unreadable value as a missing version, not as a past one', () => {
    for (const found of [undefined, null, '1', 0, -3, 1.5]) {
      const refusal = refuseForeignVersion('experiment configuration', found, 1, 'schemaVersion');
      expect(refusal?.code).toBe('admin/missing_version');
      expect(refusal?.message).toContain('experiment configuration');
    }
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
