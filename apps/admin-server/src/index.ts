/**
 * `@tcg/admin-server` — the orchestration process
 * [ADR 0023](../../../docs/architecture/0023-admin-lab-boundary.md) §1 named,
 * and at M08.2 exactly one part of it: the durable catalog.
 *
 * What this workspace is **for** is running balance experiments and serving one
 * admin client. What it *is* today is a store, because the milestone builds it in
 * the order the pieces depend on each other:
 *
 * - **M08.2 (here)** persists batches and jobs and recovers their truthful state
 *   after a restart. It opens files under a configured root and nothing else.
 * - **M08.4** adds the `@tcg/simulator` dependency and turns one catalog job into
 *   one canonical experiment directory. It is the first tranche that runs
 *   anything.
 * - **M08.6** adds the HTTP boundary, loopback binding and the non-loopback
 *   authentication refusal. It is the first tranche that opens a port, and the
 *   first that gives this workspace a `start` script.
 *
 * So there is deliberately **no entry point** in this package yet. A `main.ts`
 * that bound nothing and ran nothing would be the premature scaffolding the
 * milestone warns against; the store is imported by its tests today and by the
 * service that owns it in M08.6.
 *
 * ## The boundaries this package keeps
 *
 * - It imports `@tcg/admin-contracts`, `@tcg/shared` and `zod`, and nothing else.
 *   No engine, no simulator, no protocol, no UI framework, no web server.
 * - Nothing in the player bundle or the live match server may import it, and
 *   nothing in it may import them: ADR 0023 §1 keeps the admin process and the
 *   live match process off one event loop, and M08's exclusions keep simulator
 *   CPU work out of the multiplayer server entirely.
 * - It spawns no process and invokes no shell. When M08.4 needs a child process
 *   it gets a fixed executable and a fixed argument vector (ADR 0023 §2).
 * - Every path it touches is resolved from configuration against a configured
 *   root, and a reference that escapes one is refused rather than followed
 *   (ADR 0023 §5).
 *
 * `boundary.test.ts` reads these sources and the manifests to keep each of those
 * a fact rather than a paragraph.
 */

export {
  FileCatalogStore,
  jobMatchesFilter,
  openFileCatalogStore,
  type FileCatalogStoreOptions,
} from './catalog/file-catalog-store.js';

export {
  resolveCatalogRoots,
  resolveResultLocation,
  type CatalogRootsInput,
  type ResolvedCatalogRoots,
} from './catalog/roots.js';

export {
  comparePositions,
  decodeCursor,
  encodeCursor,
  isAfter,
  type CatalogPosition,
} from './catalog/cursor.js';

export {
  appendJsonLine,
  documentExists,
  documentPath,
  ensureDirectory,
  listDocumentNames,
  readDocument,
  readJsonLines,
  writeJsonAtomically,
  type JsonLinesResult,
  type SkippedLine,
} from './catalog/files.js';

export { KeyedMutex } from './catalog/serialize.js';

export type {
  CatalogPage,
  CatalogResult,
  CatalogStore,
  JobActionInput,
  NewBatchInput,
  NewJobInput,
  RecoveredJob,
  RecoveryReport,
  UnreadableEntry,
} from './catalog/store.js';
