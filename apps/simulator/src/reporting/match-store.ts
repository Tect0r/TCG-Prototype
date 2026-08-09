import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { HASH_VERSION } from '../hash.js';
import { SEED_DERIVATION_VERSION } from '../seed.js';
import {
  TELEMETRY_SCHEMA_VERSION,
  isAbnormal,
  matchRecordSchema,
  recordIdentity,
  type MatchRecord,
} from '../telemetry/schema.js';
import { JsonlWriter, ensureDir, readJson, readJsonl, writeJson } from './sinks.js';

/**
 * The one raw record store every experiment type writes to
 * (PHASE4_HARDENING §7).
 *
 * Before this existed, a batch streamed to `matches.jsonl` while a search and a
 * comparison accumulated everything in memory and wrote a final `matches.json`
 * array. That meant the two largest experiment kinds were the two that could not
 * be resumed and the two most likely to run out of memory — precisely backwards.
 *
 * The contract:
 *
 * - **Append-only, line-committed.** A record is resumable once its newline is
 *   on disk. A process killed mid-write leaves a partial final line, which is
 *   dropped and reported rather than silently accepted or allowed to poison the
 *   whole file.
 * - **One identity.** Records are deduplicated by `arm + matchId`, so re-running
 *   an interrupted experiment never doubles a match and never skips one.
 * - **Drift-checked.** A sidecar header records the configuration hash and every
 *   schema version. Resuming into a stream written by a different configuration
 *   is refused, because the merged result would be neither run.
 */

export const MATCH_STREAM_HEADER_VERSION = 1;

export const matchStreamHeaderSchema = z.strictObject({
  schemaVersion: z.literal(MATCH_STREAM_HEADER_VERSION),
  experimentId: z.string(),
  experimentKind: z.string(),
  /** Hash of the normalized configuration this stream was opened for. */
  configHash: z.string(),
  telemetrySchemaVersion: z.number().int(),
  seedDerivationVersion: z.number().int(),
  hashVersion: z.number().int(),
});
export type MatchStreamHeader = z.infer<typeof matchStreamHeaderSchema>;

export interface MatchStoreOptions {
  readonly experimentId: string;
  readonly experimentKind: MatchRecord['experimentKind'];
  readonly configHash: string;
  /** Continue an existing stream instead of starting a fresh one. */
  readonly resume?: boolean;
}

export interface RecoveredLine {
  readonly line: number;
  readonly reason: string;
}

/**
 * A sink a batch can append to without knowing where the experiment writes.
 *
 * `runBatch` takes this rather than a directory so an in-memory test, a plain
 * batch and one arm of a comparison all use the same code path.
 */
export interface MatchSink {
  /** True when a record with this identity is already committed. */
  has(identity: string): boolean;
  append(record: MatchRecord): void;
}

export class MatchStore implements MatchSink {
  readonly path: string | null;
  readonly header: MatchStreamHeader;
  readonly #writer: JsonlWriter | null;
  readonly #identities = new Set<string>();
  readonly #records: MatchRecord[] = [];
  readonly #recovered: RecoveredLine[] = [];
  #resumedCount = 0;

  constructor(root: string | null, options: MatchStoreOptions) {
    this.path = root === null ? null : join(root, 'matches.jsonl');
    this.header = matchStreamHeaderSchema.parse({
      schemaVersion: MATCH_STREAM_HEADER_VERSION,
      experimentId: options.experimentId,
      experimentKind: options.experimentKind,
      configHash: options.configHash,
      telemetrySchemaVersion: TELEMETRY_SCHEMA_VERSION,
      seedDerivationVersion: SEED_DERIVATION_VERSION,
      hashVersion: HASH_VERSION,
    });

    if (root === null || this.path === null) {
      this.#writer = null;
      return;
    }

    ensureDir(root);
    const headerPath = join(root, 'matches.header.json');

    if (options.resume && existsSync(this.path)) {
      assertNoDrift(headerPath, this.header);
      const read = readJsonl(this.path, matchRecordSchema);
      for (const record of read.records) {
        const identity = recordIdentity(record);
        // A duplicate on disk is possible if an older writer double-appended.
        // Keeping the first and dropping the rest is the only choice that makes
        // a resumed summary equal an uninterrupted one.
        if (this.#identities.has(identity)) continue;
        this.#identities.add(identity);
        this.#records.push(record);
      }
      this.#recovered.push(...read.skipped);
      this.#resumedCount = this.#records.length;
      // Rewrite the file from the records that survived validation, so the
      // damaged tail is truncated exactly once rather than re-read on every
      // future resume.
      this.#writer = new JsonlWriter(this.path, { truncate: true });
      for (const record of this.#records) this.#writer.append(record);
      this.#writer.flush();
    } else {
      this.#writer = new JsonlWriter(this.path, { truncate: true });
    }

    writeJson(headerPath, this.header);
  }

  has(identity: string): boolean {
    return this.#identities.has(identity);
  }

  append(record: MatchRecord): void {
    const identity = recordIdentity(record);
    if (this.#identities.has(identity)) return;
    this.#identities.add(identity);
    this.#records.push(record);
    this.#writer?.append(record);
  }

  flush(): void {
    this.#writer?.flush();
  }

  /** Every record in canonical order. Arm first, then the schedule's order key. */
  all(): MatchRecord[] {
    return [...this.#records].sort(compareRecords);
  }

  /** Records belonging to one arm, in canonical order. */
  arm(label: string | null): MatchRecord[] {
    return this.#records.filter((record) => record.arm === label).sort(compareRecords);
  }

  get resumedCount(): number {
    return this.#resumedCount;
  }

  get recovered(): readonly RecoveredLine[] {
    return this.#recovered;
  }

  get abnormalCount(): number {
    return this.#records.filter((record) => isAbnormal(record.termination)).length;
  }
}

/**
 * Canonical record order.
 *
 * Sorting by arm before order key keeps a comparison's two halves contiguous and
 * keeps every aggregate's floating-point accumulation order fixed, whatever
 * order the workers actually finished in.
 */
export function compareRecords(left: MatchRecord, right: MatchRecord): number {
  const arm = (left.arm ?? '').localeCompare(right.arm ?? '');
  if (arm !== 0) return arm;
  return left.orderKey.localeCompare(right.orderKey);
}

function assertNoDrift(headerPath: string, current: MatchStreamHeader): void {
  if (!existsSync(headerPath)) {
    throw new Error(
      `Cannot resume "${headerPath.replace(/matches\.header\.json$/, '')}": the stream has no ` +
        'header, so there is no way to tell whether it was written by this configuration. ' +
        'Delete the directory and run without --resume.',
    );
  }

  const previous = readJson(headerPath, matchStreamHeaderSchema);
  const drift: string[] = [];
  if (previous.experimentId !== current.experimentId) {
    drift.push(`experiment ID ${previous.experimentId} → ${current.experimentId}`);
  }
  if (previous.experimentKind !== current.experimentKind) {
    drift.push(`experiment kind ${previous.experimentKind} → ${current.experimentKind}`);
  }
  if (previous.configHash !== current.configHash) {
    drift.push(`configuration hash ${previous.configHash} → ${current.configHash}`);
  }
  if (previous.telemetrySchemaVersion !== current.telemetrySchemaVersion) {
    drift.push(
      `telemetry schema v${previous.telemetrySchemaVersion} → v${current.telemetrySchemaVersion}`,
    );
  }
  if (previous.seedDerivationVersion !== current.seedDerivationVersion) {
    drift.push(
      `seed derivation v${previous.seedDerivationVersion} → v${current.seedDerivationVersion}`,
    );
  }
  if (previous.hashVersion !== current.hashVersion) {
    drift.push(`hash v${previous.hashVersion} → v${current.hashVersion}`);
  }

  if (drift.length > 0) {
    throw new Error(
      `Refusing to resume: the existing records were produced by a different run (${drift.join('; ')}). ` +
        'Merging them would produce a result set that is neither experiment. Use a new output ' +
        'directory, or delete the existing one to start over.',
    );
  }
}
