/**
 * Root catalogue parity — `npm run parity:root` (M07.6).
 *
 * The CLI shell only. What parity means, and how the two representations are
 * mapped onto each other, is `scripts/lib/root-catalog-parity.ts`.
 *
 * Prints the report and exits non-zero when the tracked root `cards.json` /
 * `precons.json` and the generated content under `content/` disagree — which is
 * the evidence Q40 asks for, since the case for keeping the root pair rests
 * entirely on it still saying the same thing as the content that is actually
 * played.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectRootCatalogParity, renderParityReport } from './lib/root-catalog-parity.js';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');

const parity = collectRootCatalogParity(REPO_ROOT);
process.stdout.write(renderParityReport(parity));
process.exitCode = parity.exact ? 0 : 1;
