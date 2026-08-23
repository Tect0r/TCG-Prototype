import { open, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { stageRefSchema, type StageRef } from '@tcg/admin-contracts';
import { experimentPaths } from '@tcg/simulator';

/**
 * How far a run has actually got, read from the run's own directory.
 *
 * M08.4 requires progress to be *derived from canonical output and checkpoint
 * state rather than a second counter*, and this module is the whole of that
 * requirement. Nothing here is told anything: it opens the experiment directory
 * the job owns and reports what is in it.
 *
 * ## Why not the simulator's progress callback
 *
 * `runExperiment` takes an `onProgress` that hands out a `BatchProgress` with a
 * `completed` field, and using it would have been the obvious thing. It is
 * exactly the second counter the requirement rules out:
 *
 * - It counts what this process has **done**, not what is **committed**. A match
 *   that has been played but whose line has not reached the disk is not a match a
 *   restart will find, and a catalog that reported it would be promising work
 *   that is about to be replayed.
 * - It is per-attempt. Resumed matches are skipped rather than replayed, so a
 *   resumed run's callback starts from zero while the stream on disk holds
 *   hundreds of records.
 * - It fires every twenty-five matches, which is never for a twelve-match
 *   benchmark.
 *
 * Counting the stream is none of those things. It is the same measure resume
 * uses — `runBatch`'s own comment says *the file on disk is the progress* — so
 * the number a screen shows and the number a restart would continue from are one
 * number by construction.
 *
 * ## What counts as committed
 *
 * A terminating newline. `MatchStore`'s contract is that *a record is resumable
 * once its newline is on disk*, and a process killed mid-write leaves a partial
 * final line that `readJsonl` drops and reports. Counting newline bytes rather
 * than lines is that rule, applied to bytes: a half-written final record has no
 * newline after it and is not counted, which is the same answer resume gives.
 *
 * The file is read in chunks rather than into a string. A two-thousand-match
 * stream is tens of megabytes, this is called on a timer while the run is in
 * flight, and parsing every record to find out how many there are would cost
 * more than playing some of them.
 */

const NEWLINE = 0x0a;
const CHUNK_BYTES = 1 << 16;

/** What the raw-record stream says it is, when there is one. */
export interface StreamIdentity {
  readonly experimentId: string;
  readonly experimentKind: string;
  readonly configHash: string;
}

export interface CanonicalReading {
  /** Records committed to `matches.jsonl`, counted by their terminating newline. */
  readonly completedMatches: number;
  /** The newest checkpoint the run has written, when it writes any. */
  readonly stage: StageRef | null;
  /** The identity the stream declares, or `null` when no stream has been opened. */
  readonly streamIdentity: StreamIdentity | null;
}

export const NO_CANONICAL_READING: CanonicalReading = Object.freeze({
  completedMatches: 0,
  stage: null,
  streamIdentity: null,
});

/** Everything the canonical directory can say about how far along a run is. */
export async function readCanonicalProgress(directory: string): Promise<CanonicalReading> {
  const paths = experimentPaths(directory);
  const [completedMatches, streamIdentity, stage] = await Promise.all([
    countCommittedRecords(paths.matches),
    readStreamIdentity(paths.matchesHeader),
    readNewestStage(paths.checkpoints),
  ]);
  return { completedMatches, stage, streamIdentity };
}

/** Newline-terminated records in a JSONL file. Zero when the file is not there. */
export async function countCommittedRecords(path: string): Promise<number> {
  let handle;
  try {
    handle = await open(path, 'r');
  } catch {
    return 0;
  }

  try {
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    let committed = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, CHUNK_BYTES, null);
      if (bytesRead === 0) return committed;
      for (let index = 0; index < bytesRead; index += 1) {
        if (buffer[index] === NEWLINE) committed += 1;
      }
    }
  } finally {
    await handle.close();
  }
}

/**
 * The three identity fields the stream's sidecar header carries.
 *
 * Read leniently and reported as `null` on any failure, because this is a
 * *progress* reading: a header that cannot be parsed is a question for the
 * caller that is about to resume into it, and refusing to say how many matches
 * are on disk would be answering the wrong one.
 */
async function readStreamIdentity(path: string): Promise<StreamIdentity | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

  const header = parsed as Record<string, unknown>;
  const { experimentId, experimentKind, configHash } = header;
  if (
    typeof experimentId !== 'string' ||
    typeof experimentKind !== 'string' ||
    typeof configHash !== 'string'
  ) {
    return null;
  }
  return { experimentId, experimentKind, configHash };
}

/**
 * Checkpoint file names are `<stage>-generation-<nnn>.json`. `experiment.ts`
 * writes one per replicate per checkpointed generation; nothing else writes into
 * this directory.
 */
const CHECKPOINT_NAME = /^([a-z][a-z0-9_-]*)-generation-(\d+)\.json$/;

/**
 * Which declared stage the run is in, read from the checkpoints it has written.
 *
 * **The files, not their contents.** A checkpoint holds a whole population of
 * decks — every card of every deck in the generation, plus the archive — and
 * opening one on a timer to learn a stage name would cost megabytes per reading.
 * Which checkpoints exist is checkpoint state too, and it is the cheap half.
 *
 * `total` is `null` on purpose, and `stageRefSchema` says why: *an adaptive job
 * discovers how many evaluation blocks it needs, and reporting a total it does
 * not have would be the second-formula mistake ADR 0023 §2 exists to prevent.*
 * The directory knows which stages have started; it does not know how many were
 * configured, and reading that off the configuration here would mean this module
 * had an opinion about a run beyond what the run wrote down.
 *
 * The generation number is deliberately not carried. `stageRefSchema` names
 * stages, and M08.4 adds no field to the contract it does not need; the tranche
 * that shows a generation on screen (M08.9) is the one that decides how.
 */
async function readNewestStage(checkpointDirectory: string): Promise<StageRef | null> {
  let names: string[];
  try {
    names = await readdir(checkpointDirectory);
  } catch {
    return null;
  }

  const stages = new Set<string>();
  let newest: { readonly stageId: string; readonly generation: number } | null = null;
  for (const name of names.sort()) {
    // `String#match` rather than `RegExp#exec`: `boundary.test.ts` scans these
    // sources for the token `exec(`, because that is how `child_process` spells
    // the capability this workspace must not have, and a scan that had to make
    // an exception for a regular expression would be a scan with a hole in it.
    const matched = name.match(CHECKPOINT_NAME);
    if (matched === null) continue;
    const stageId = matched[1] as string;
    const generation = Number.parseInt(matched[2] as string, 10);
    stages.add(stageId);
    if (newest === null || stageId > newest.stageId) {
      newest = { stageId, generation };
      continue;
    }
    if (stageId === newest.stageId && generation > newest.generation) {
      newest = { stageId, generation };
    }
  }
  if (newest === null) return null;

  const ordered = [...stages].sort();
  const parsed = stageRefSchema.safeParse({
    stageId: newest.stageId,
    ordinal: ordered.indexOf(newest.stageId),
    total: null,
  });
  return parsed.success ? parsed.data : null;
}

/** The one place a checkpoint file name is spelled, so a test can build one. */
export function checkpointFileName(stageId: string, generation: number): string {
  return `${stageId}-generation-${String(generation).padStart(3, '0')}.json`;
}

/** Where a run's checkpoints live, named by the simulator rather than by us. */
export function checkpointDirectoryOf(directory: string): string {
  return join(experimentPaths(directory).checkpoints);
}
