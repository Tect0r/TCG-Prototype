import { z } from 'zod';
import type { AnalysisSettings } from '../config.js';
import type { MatchRecord } from '../telemetry/schema.js';
import type { ClusteringResult } from './clusters.js';
import { proportion, round } from './stats.js';

/**
 * Opponent-field sensitivity (PHASE4_HARDENING §10.1).
 *
 * `opponent_field_sensitivity` shipped as a reason code that nothing could ever
 * raise: it was in the public schema and in the documentation, and no analyser
 * computed it. §10.1 says implement it or remove it, and prefers implementing —
 * so this is the implementation.
 *
 * The measurement: for a card, split the seat-matches in which it was in the
 * deck by the strategic cluster of the *opponent*, and compare the win rate
 * across those fields. A card that wins 70% into one field and 35% into another
 * is context-sensitive. That is a description, not a defect: soft counter
 * relationships are the healthy meta CLAUDE.md §13.11 describes wanting, and a
 * card with no unfavourable context is the more worrying shape. What is reported
 * is the spread, the best and worst supported fields, and whether the
 * uncertainty leaves the spread meaningful at all.
 *
 * Two guards keep it from firing on noise:
 *
 * - Every field used must clear `minMatchesPerOpponentField` on its own.
 * - The best and worst intervals must not overlap. A spread whose ends are
 *   within each other's confidence intervals is one sample, not two.
 */

export const fieldEstimateSchema = z.strictObject({
  opponentClusterId: z.string(),
  opponentClusterLabel: z.string(),
  matches: z.number().int().min(0),
  winRate: z.number(),
  low: z.number(),
  high: z.number(),
});
export type FieldEstimate = z.infer<typeof fieldEstimateSchema>;

export const opponentSensitivitySchema = z.strictObject({
  subject: z.string(),
  subjectKind: z.enum(['card', 'cluster']),
  /** Every opponent field that met the minimum, best first. */
  fields: z.array(fieldEstimateSchema),
  /** Fields observed but dropped for having too few matches, with their counts. */
  droppedFields: z.array(
    z.strictObject({ opponentClusterId: z.string(), matches: z.number().int().min(0) }),
  ),
  best: fieldEstimateSchema.nullable(),
  worst: fieldEstimateSchema.nullable(),
  /** best.winRate − worst.winRate, over supported fields only. */
  spread: z.number(),
  /** True when the best and worst intervals do not overlap. */
  separated: z.boolean(),
  totalMatches: z.number().int().min(0),
  status: z.enum(['sensitive', 'consistent', 'insufficient_evidence']),
  note: z.string(),
});
export type OpponentSensitivity = z.infer<typeof opponentSensitivitySchema>;

export interface SensitivityInputs {
  readonly records: readonly MatchRecord[];
  readonly clustering: ClusteringResult;
  readonly settings: AnalysisSettings;
  /** Restrict the scan to these card IDs. Empty scans every card seen. */
  readonly cardIds?: readonly string[];
}

export function opponentFieldSensitivity(inputs: SensitivityInputs): OpponentSensitivity[] {
  const { settings } = inputs;
  const clusterOf = new Map<string, { id: string; label: string }>();
  for (const cluster of inputs.clustering.clusters) {
    for (const hash of cluster.deckHashes) {
      clusterOf.set(hash, { id: cluster.id, label: cluster.label });
    }
  }
  if (clusterOf.size === 0) return [];

  /** cardId -> opponentClusterId -> tally */
  const tallies = new Map<string, Map<string, { wins: number; total: number; label: string }>>();
  const wanted = inputs.cardIds && inputs.cardIds.length > 0 ? new Set(inputs.cardIds) : null;

  for (const record of inputs.records) {
    for (const seat of record.seats) {
      const opponents = record.seats.filter((other) => other.playerId !== seat.playerId);
      // Only a well-defined single-opponent field is interpretable. In a
      // free-for-all the "field" a card faced is a mixture, and averaging the
      // mixture into one cluster's row would attribute the result to whichever
      // opponent happened to sort first.
      if (opponents.length !== 1) continue;
      const opponent = opponents[0];
      if (!opponent) continue;
      const field = clusterOf.get(opponent.deckHash);
      if (!field) continue;

      const included = record.cards.filter(
        (card) => card.playerId === seat.playerId && card.copiesInDeck > 0,
      );
      for (const card of included) {
        if (wanted && !wanted.has(card.definitionId)) continue;
        let byField = tallies.get(card.definitionId);
        if (!byField) {
          byField = new Map();
          tallies.set(card.definitionId, byField);
        }
        const tally = byField.get(field.id) ?? { wins: 0, total: 0, label: field.label };
        tally.total += 1;
        if (seat.won) tally.wins += 1;
        byField.set(field.id, tally);
      }
    }
  }

  return [...tallies]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([definitionId, byField]) => summarize(definitionId, 'card', byField, settings));
}

/** The same measurement for a whole strategic cluster rather than one card. */
export function clusterFieldSensitivity(
  records: readonly MatchRecord[],
  clustering: ClusteringResult,
  settings: AnalysisSettings,
): OpponentSensitivity[] {
  const clusterOf = new Map<string, { id: string; label: string }>();
  for (const cluster of clustering.clusters) {
    for (const hash of cluster.deckHashes) {
      clusterOf.set(hash, { id: cluster.id, label: cluster.label });
    }
  }

  const tallies = new Map<string, Map<string, { wins: number; total: number; label: string }>>();
  for (const record of records) {
    for (const seat of record.seats) {
      const own = clusterOf.get(seat.deckHash);
      const opponents = record.seats.filter((other) => other.playerId !== seat.playerId);
      if (!own || opponents.length !== 1) continue;
      const opponent = opponents[0];
      if (!opponent) continue;
      const field = clusterOf.get(opponent.deckHash);
      if (!field) continue;

      let byField = tallies.get(own.id);
      if (!byField) {
        byField = new Map();
        tallies.set(own.id, byField);
      }
      const tally = byField.get(field.id) ?? { wins: 0, total: 0, label: field.label };
      tally.total += 1;
      if (seat.won) tally.wins += 1;
      byField.set(field.id, tally);
    }
  }

  return [...tallies]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([clusterId, byField]) => summarize(clusterId, 'cluster', byField, settings));
}

function summarize(
  subject: string,
  subjectKind: 'card' | 'cluster',
  byField: ReadonlyMap<string, { wins: number; total: number; label: string }>,
  settings: AnalysisSettings,
): OpponentSensitivity {
  const dropped: { opponentClusterId: string; matches: number }[] = [];
  const fields: FieldEstimate[] = [];
  let totalMatches = 0;

  for (const [opponentClusterId, tally] of [...byField].sort((left, right) =>
    left[0].localeCompare(right[0]),
  )) {
    totalMatches += tally.total;
    if (tally.total < settings.minMatchesPerOpponentField) {
      dropped.push({ opponentClusterId, matches: tally.total });
      continue;
    }
    const rate = proportion(tally.wins, tally.total, settings.confidence);
    fields.push({
      opponentClusterId,
      opponentClusterLabel: tally.label,
      matches: tally.total,
      winRate: round(rate.point),
      low: round(rate.low),
      high: round(rate.high),
    });
  }

  fields.sort(
    (left, right) =>
      right.winRate - left.winRate || left.opponentClusterId.localeCompare(right.opponentClusterId),
  );

  const best = fields[0] ?? null;
  const worst = fields[fields.length - 1] ?? null;
  const spread = best && worst ? best.winRate - worst.winRate : 0;
  const separated = best !== null && worst !== null && best !== worst && best.low > worst.high;

  if (fields.length < settings.minOpponentFields) {
    return {
      subject,
      subjectKind,
      fields,
      droppedFields: dropped,
      best,
      worst,
      spread: round(spread),
      separated,
      totalMatches,
      status: 'insufficient_evidence',
      note:
        `Only ${fields.length} opponent field(s) reached ${settings.minMatchesPerOpponentField} ` +
        `seat-matches, below minOpponentFields = ${settings.minOpponentFields}. ` +
        'No statement is made about context sensitivity.',
    };
  }

  const sensitive = spread >= settings.opponentFieldSpread && separated;
  return {
    subject,
    subjectKind,
    fields,
    droppedFields: dropped,
    best,
    worst,
    spread: round(spread),
    separated,
    totalMatches,
    status: sensitive ? 'sensitive' : 'consistent',
    note: sensitive
      ? `Results range from ${round((best?.winRate ?? 0) * 100, 1)}% against ` +
        `${best?.opponentClusterId} to ${round((worst?.winRate ?? 0) * 100, 1)}% against ` +
        `${worst?.opponentClusterId}, and the intervals do not overlap. This is context ` +
        'sensitivity, which may be a healthy counter relationship or a polarised one — the ' +
        'matchup table says which.'
      : `Spread of ${round(spread * 100, 1)} points across ${fields.length} supported opponent ` +
        'field(s), which the intervals do not separate. No context sensitivity is claimed.',
  };
}
