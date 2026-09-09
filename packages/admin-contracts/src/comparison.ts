import { z } from 'zod';

import type { EnvironmentContentHashes } from './catalog.js';
import type { PlayerMetaPartition } from './player-meta-results.js';

/**
 * M08.27A — the comparison compatibility gate.
 *
 * Every delta M08.27B computes — precon/Commander matchup, card inclusion,
 * duration, termination, deck-family, surrender-pattern — starts from a
 * baseline and a candidate result. This file decides, before any of that
 * math runs, whether the pair is safe to compare at all. Nothing here
 * computes a delta; nothing here even reads a table. It only classifies a
 * pair of content identities.
 *
 * Two domains, two identities, one shared verdict shape. `RunIdentity`
 * (`./catalog.ts`) and `PlayerMetaPartition` (`./player-meta-results.ts`)
 * are the only two content identities this package has, and they are not
 * the same shape: a catalog environment carries four content hashes
 * (`EnvironmentContentHashes`, restated from `@tcg/simulator` for the
 * dependency reason `catalog.ts` gives); a Player Meta partition carries no
 * hash at all, only `(source, contentVersion, rulesVersion)`
 * (`playerMetaPartitionSchema`). `decideCatalogEnvironmentComparison` and
 * `decidePlayerMetaComparison` each read their own domain's real signal
 * rather than forcing one shape onto both, and `comparisonDecisionSchema` is
 * the verdict both return.
 *
 * A documented gap rather than an invented field: `contentVersion` restates
 * `CARD_SCHEMA_VERSION`, a coarse data-format/migration version that moves
 * far less often than card balance does, and `liveMatchEnvelopeSchema` has
 * no timestamp (M08.25A). Two matches on either side of a balance-only card
 * change can carry the same `contentVersion` and the same `rulesVersion`,
 * so `decidePlayerMetaComparison` cannot detect that difference — it can
 * only ever refuse an *identical* partition or require a human to declare
 * one they already know differs. Under today's telemetry a Player Meta
 * `compatible` verdict is reachable only when the partitions are literally
 * the same triple, which `decidePlayerMetaComparison` refuses instead
 * (nothing to compare) — so in practice every non-identical Player Meta
 * comparison this build can make is `refused` or `deliberately_different`,
 * never `compatible`. Naming that plainly here is the alternative to
 * fabricating a hash or a timestamp this layer does not have.
 */

/** A non-empty operator-authored explanation of what changed, required for every deliberate comparison of an otherwise-incompatible pair. */
export const declaredChangeSchema = z.string().min(1).max(600);
export type DeclaredChange = z.infer<typeof declaredChangeSchema>;

/**
 * The one verdict shape both domains return.
 *
 * `compatible` needs no declaration: the signal this layer can see says the
 * pair would behave identically, so any delta is safe to compute
 * automatically. `refused` names a pair this build will never compare,
 * with or without a declaration — an identical pair (nothing to compare) or
 * a cross-population pair (`PlayerMetaPartition.source` differs, a
 * confound no declaration can fix). `deliberately_different` is the
 * explicit override: content or version differs, a human declared why, and
 * the comparison proceeds on that record rather than on this layer's own
 * judgment.
 */
export const comparisonDecisionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('compatible'), note: z.string().min(1).max(400) }),
  z.strictObject({ kind: z.literal('refused'), reason: z.string().min(1).max(400) }),
  z.strictObject({
    kind: z.literal('deliberately_different'),
    declaredChange: declaredChangeSchema,
    reason: z.string().min(1).max(400),
  }),
]);
export type ComparisonDecision = z.infer<typeof comparisonDecisionSchema>;

/**
 * The catalog-domain gate: two environments' content hashes, already
 * matched by `environmentId` by the caller (`RunIdentity.environments`,
 * `./catalog.ts`) — this function does not search either run for a shared
 * environment, only classifies the pair it is handed.
 *
 * Each hash is compared against its own documented meaning
 * (`environmentContentHashesSchema`), not derived from another: a change
 * that only touches `cardPilotMetadata` moves `pilotInputHash` without
 * necessarily moving `fullContentHash` (`computeEnvironmentHashes` hashes
 * `{mechanics, presentation}`, not pilot metadata, into `fullContentHash`),
 * so this gate never infers one hash's equality from another's.
 */
export function decideCatalogEnvironmentComparison(
  baseline: EnvironmentContentHashes,
  candidate: EnvironmentContentHashes,
  declaredChange?: string,
): ComparisonDecision {
  if (baseline.fullContentHash === candidate.fullContentHash) {
    return {
      kind: 'refused',
      reason: 'Baseline and candidate resolved to byte-identical content; there is nothing to compare.',
    };
  }

  if (
    baseline.mechanicsHash === candidate.mechanicsHash &&
    baseline.pilotInputHash === candidate.pilotInputHash
  ) {
    return {
      kind: 'compatible',
      note: 'Mechanics and pilot input are identical, so these runs would replay and decide identically. The remaining difference is presentation only, which cannot change a match.',
    };
  }

  const trimmed = declaredChange?.trim();
  if (trimmed) {
    return {
      kind: 'deliberately_different',
      declaredChange: trimmed,
      reason: 'Mechanics and/or pilot input differ between baseline and candidate content.',
    };
  }

  return {
    kind: 'refused',
    reason:
      'Mechanics and/or pilot input differ between baseline and candidate content. Declare what changed before comparing.',
  };
}

/**
 * The Player Meta-domain gate: two partitions, compared on the only
 * identity signal this build has. See the file doc comment for why a
 * `compatible` verdict is not currently reachable here except by way of
 * the identical-partition refusal below.
 */
export function decidePlayerMetaComparison(
  baseline: PlayerMetaPartition,
  candidate: PlayerMetaPartition,
  declaredChange?: string,
): ComparisonDecision {
  if (baseline.source !== candidate.source) {
    return {
      kind: 'refused',
      reason:
        'Baseline and candidate were recorded under different live-match sources. This is a population-level confound no declared change can override.',
    };
  }

  if (
    baseline.contentVersion === candidate.contentVersion &&
    baseline.rulesVersion === candidate.rulesVersion
  ) {
    return {
      kind: 'refused',
      reason: 'Baseline and candidate are the same partition; there is nothing to compare.',
    };
  }

  const trimmed = declaredChange?.trim();
  if (trimmed) {
    return {
      kind: 'deliberately_different',
      declaredChange: trimmed,
      reason: 'Content version and/or rules version differ between baseline and candidate partitions.',
    };
  }

  return {
    kind: 'refused',
    reason:
      'Content version and/or rules version differ between baseline and candidate partitions. Declare what changed before comparing.',
  };
}
