import type { AnalysisSettings } from '../config.js';
import type { EnvironmentDiff } from '../environment.js';
import type { Aggregate } from '../analysis/aggregate.js';
import type { ClusteringResult } from '../analysis/clusters.js';
import type { CardPair } from '../analysis/pairs.js';
import type { ReplacementImpact } from '../analysis/replacement.js';
import type { ComparisonReport } from '../analysis/compare.js';
import type { Flag } from '../analysis/flags.js';
import type { GenerationReport } from '../deck-search/evolve.js';
import { round } from '../analysis/stats.js';

/**
 * The human-readable report (CLAUDE.md §13.13).
 *
 * It leads with limitations, scale and the environment diff, and it labels every
 * section as observation, inference or recommendation. It contains no prose that
 * pretends to certainty: where the evidence is thin, the report says so and
 * prints the sample size instead of a conclusion.
 */

export interface ReportInputs {
  readonly title: string;
  readonly experimentId: string;
  readonly kind: string;
  readonly seed: string;
  readonly softwareCommit: string | null;
  readonly rulesVersion: string;
  readonly environmentSummaries: readonly {
    readonly id: string;
    readonly hash: string;
    readonly label: string;
  }[];
  readonly settings: AnalysisSettings;
  readonly aggregate: Aggregate;
  readonly clustering: ClusteringResult;
  readonly pairs: readonly CardPair[];
  readonly replacements: readonly ReplacementImpact[];
  readonly flags: readonly Flag[];
  readonly diff?: EnvironmentDiff;
  readonly comparison?: ComparisonReport;
  readonly searchHistory?: readonly GenerationReport[];
  readonly deckCount: number;
  readonly pilotIds: readonly string[];
  readonly wallClockMs: number;
  readonly workers: number;
  readonly extraLimitations?: readonly string[];
}

const pct = (value: number): string => `${round(value * 100, 1)}%`;

/** How much of the flag list the written report shows before deferring to `summary.json`. */
const FLAG_TABLE_LIMIT = 30;
const FLAG_DETAIL_LIMIT = 15;

export function renderReport(inputs: ReportInputs): string {
  const lines: string[] = [];
  const { aggregate: agg, settings } = inputs;

  lines.push(`# ${inputs.title}`);
  lines.push('');
  lines.push(
    'Simulated evidence from heuristic pilots. **This is not a balance verdict.** ' +
      'Everything below describes what these bots did with these decks under these rules; ' +
      'a card is worth reviewing when the evidence says so, and a human decides what to change.',
  );
  lines.push('');

  /* ------------------------------------------------------------ limitations */

  lines.push('## Limitations, first');
  lines.push('');
  const limitations = [
    `Pilots are transparent heuristics, not skilled players: ${inputs.pilotIds.join(', ')}. ` +
      'A card that rewards play the pilots cannot perform will look weak here.',
    `${agg.run.usableMatches} usable matches over ${inputs.deckCount} decks. ` +
      `Card conclusions need ${settings.minMatchesPerCard} seat-matches; pair conclusions need ` +
      `${settings.minPairSupport} co-occurrences.`,
    'Individual deck win rates are samples from one opponent field, not a balance model.',
    'Every threshold in this report is a configurable review dial, printed with each flag.',
    ...(inputs.extraLimitations ?? []),
    ...(inputs.comparison?.limitations ?? []),
  ];
  if (agg.run.abnormalMatches > 0) {
    limitations.push(
      `${agg.run.abnormalMatches} match(es) ended abnormally and were excluded from every statistic ` +
        'below. Their replays are in `replays/`.',
    );
  }
  for (const limitation of limitations) lines.push(`- ${limitation}`);
  lines.push('');

  /* ------------------------------------------------------------------ scale */

  lines.push('## Scale and provenance *(observation)*');
  lines.push('');
  lines.push('| Field | Value |');
  lines.push('| --- | --- |');
  lines.push(`| Experiment | \`${inputs.experimentId}\` (${inputs.kind}) |`);
  lines.push(`| Root seed | \`${inputs.seed}\` |`);
  lines.push(`| Rules version | ${inputs.rulesVersion} |`);
  lines.push(`| Software commit | ${inputs.softwareCommit ?? 'not recorded'} |`);
  for (const environment of inputs.environmentSummaries) {
    lines.push(
      `| Environment \`${environment.id}\` | ${environment.label} — hash \`${environment.hash}\` |`,
    );
  }
  lines.push(`| Matches | ${agg.run.matches} (${agg.run.usableMatches} usable) |`);
  lines.push(`| Decks | ${inputs.deckCount} |`);
  lines.push(`| Workers | ${inputs.workers} |`);
  lines.push(`| Wall clock | ${round(inputs.wallClockMs / 1000, 1)} s |`);
  lines.push('');

  /* -------------------------------------------------------- environment diff */

  if (inputs.diff) {
    lines.push('## Environment diff *(observation)*');
    lines.push('');
    if (inputs.diff.identical) {
      lines.push('The two environments are byte-identical. Nothing changed.');
    } else {
      if (inputs.diff.cardsAdded.length > 0) {
        lines.push(`- **Cards added:** ${inputs.diff.cardsAdded.join(', ')}`);
      }
      if (inputs.diff.cardsRemoved.length > 0) {
        lines.push(`- **Cards removed:** ${inputs.diff.cardsRemoved.join(', ')}`);
      }
      for (const changed of inputs.diff.cardsChanged) {
        lines.push(`- **${changed.cardId} changed:** ${changed.fields.join(', ')}`);
      }
      for (const rule of inputs.diff.rulesChanged) {
        lines.push(`- **Rule \`${rule.key}\`:** ${rule.before} → ${rule.after}`);
      }
      for (const format of inputs.diff.formatChanged) {
        lines.push(`- **Format \`${format.key}\`:** ${format.before} → ${format.after}`);
      }
    }
    lines.push('');
  }

  /* ------------------------------------------------------------------ flags */

  lines.push('## Strongest evidence *(inference — recommendations to look, not verdicts)*');
  lines.push('');
  const actionable = inputs.flags.filter(
    (flag) => flag.level === 'review_recommended' || flag.level === 'possible_interaction',
  );
  if (actionable.length === 0) {
    lines.push(
      'No flag cleared its configured threshold. That is **not** a statement that the environment is ' +
        'balanced — with this sample size it most often means there was not enough evidence to say anything.',
    );
  } else {
    // A report that prints two hundred flags is a report nobody reads. The full
    // set is always in `summary.json`; this is the readable head of it.
    const shown = actionable.slice(0, FLAG_TABLE_LIMIT);
    if (actionable.length > shown.length) {
      lines.push(
        `Showing the ${shown.length} strongest of ${actionable.length} flags. ` +
          'The complete list, with the evidence behind each one, is in `summary.json`.',
      );
      lines.push('');
    }
    lines.push('| Level | Reason | Subject | Sample | Interval | Threshold |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const flag of shown) {
      const interval = flag.interval
        ? `${round(flag.interval.low, 3)} … ${round(flag.interval.high, 3)}`
        : '—';
      const threshold = flag.threshold ? `${flag.threshold.name} = ${flag.threshold.value}` : '—';
      lines.push(
        `| ${flag.level} | \`${flag.reason}\` | \`${flag.subject}\` | ${flag.sampleSize} | ${interval} | ${threshold} |`,
      );
    }
    lines.push('');
    for (const flag of shown.slice(0, FLAG_DETAIL_LIMIT)) {
      lines.push(`- **\`${flag.subject}\`** — ${flag.message}`);
    }
  }
  lines.push('');

  const quality = inputs.flags.filter((flag) => flag.level === 'run_quality');
  if (quality.length > 0) {
    lines.push('### Run quality');
    lines.push('');
    for (const flag of quality) lines.push(`- ${flag.message}`);
    lines.push('');
  }

  const unknown = inputs.flags.filter((flag) => flag.level === 'insufficient_data');
  if (unknown.length > 0) {
    lines.push(`### Not enough data (${unknown.length} subject${unknown.length === 1 ? '' : 's'})`);
    lines.push('');
    lines.push(
      'Listed so that "we did not measure this" is visible rather than looking like "we found nothing":',
    );
    lines.push('');
    lines.push(`\`${unknown.map((flag) => flag.subject).join('`, `')}\``);
    lines.push('');
  }

  /* ------------------------------------------------------------------- runs */

  lines.push('## Match outcomes *(observation)*');
  lines.push('');
  lines.push('| Termination | Matches |');
  lines.push('| --- | --- |');
  for (const [kind, count] of Object.entries(agg.run.terminations).sort()) {
    lines.push(`| ${kind} | ${count} |`);
  }
  lines.push('');
  lines.push(
    `Turns: mean ${agg.run.turns.mean}, median ${agg.run.turns.median}, ` +
      `p10 ${agg.run.turns.p10}, p90 ${agg.run.turns.p90}, max ${agg.run.turns.max}. ` +
      `Draws: ${agg.run.draws}. Decisions per match: ${agg.run.decisionsPerMatch}.`,
  );
  lines.push('');

  if (agg.run.seatWinRates.length > 0) {
    lines.push(
      '**Seat win rates** (the schedule mirrors seats, so an imbalance here is a rules effect):',
    );
    lines.push('');
    lines.push('| Seat | Win rate | 95% interval | Matches |');
    lines.push('| --- | --- | --- | --- |');
    for (const seat of agg.run.seatWinRates) {
      lines.push(
        `| ${seat.seatIndex} | ${pct(seat.rate.point)} | ${pct(seat.rate.low)} … ${pct(seat.rate.high)} | ${seat.rate.total} |`,
      );
    }
    lines.push('');
  }

  if (agg.run.pilotWinRates.length > 1) {
    lines.push('**Pilot win rates:**');
    lines.push('');
    lines.push('| Pilot | Win rate | Matches |');
    lines.push('| --- | --- | --- |');
    for (const pilot of agg.run.pilotWinRates) {
      lines.push(`| ${pilot.pilotId} | ${pct(pilot.rate.point)} | ${pilot.rate.total} |`);
    }
    lines.push('');
  }

  /* --------------------------------------------------------------- clusters */

  if (inputs.clustering.clusters.length > 0) {
    lines.push('## Strategic clusters *(observation)*');
    lines.push('');
    lines.push(
      'Decks grouped by named, inspectable features — colours, curve, type and role mix, keyword density. ' +
        'No model, no archetype naming.',
    );
    lines.push('');
    lines.push('| Cluster | Description | Decks | Win rate | Interval | Matches |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const cluster of inputs.clustering.clusters) {
      lines.push(
        `| ${cluster.id} | ${cluster.label} | ${cluster.deckHashes.length} | ${pct(cluster.winRate.point)} | ` +
          `${pct(cluster.winRate.low)} … ${pct(cluster.winRate.high)} | ${cluster.matches} |`,
      );
    }
    lines.push('');
    lines.push(`Largest cluster holds ${pct(inputs.clustering.largestClusterShare)} of the decks.`);
    lines.push('');
  }

  /* ------------------------------------------------------------------ cards */

  lines.push('## Cards *(observation)*');
  lines.push('');
  lines.push(
    'Inclusion win rates are **correlations**: a card is not responsible for a win because it was in the ' +
      'deck. Use the replacement section for anything causal.',
  );
  lines.push('');
  const topCards = [...agg.cards]
    .filter((card) => card.seatMatches >= settings.minMatchesPerCard)
    .sort((left, right) => right.inclusionWinRateLift - left.inclusionWinRateLift)
    .slice(0, 15);
  if (topCards.length === 0) {
    lines.push(`No card reached ${settings.minMatchesPerCard} seat-matches. Nothing is reported.`);
  } else {
    lines.push(
      '| Card | Decks | Seat-matches | With | Without | Lift | Play rate | Dead in hand |',
    );
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const card of topCards) {
      lines.push(
        `| \`${card.definitionId}\` | ${card.decksIncluding} | ${card.seatMatches} | ` +
          `${pct(card.winRateWhenIncluded.point)} | ${pct(card.winRateWhenAbsent.point)} | ` +
          `${round(card.inclusionWinRateLift * 100, 1)} pts | ${pct(card.playRatePerDrawn)} | ${pct(card.deadInHandShare)} |`,
      );
    }
  }
  lines.push('');

  /* ------------------------------------------------------------------ pairs */

  const reportedPairs = inputs.pairs.filter((pair) => pair.support >= settings.minPairSupport);
  lines.push('## Card pairs *(inference)*');
  lines.push('');
  if (reportedPairs.length === 0) {
    lines.push(
      `No card pair reached the minimum support of ${settings.minPairSupport} co-occurrences. ` +
        'Pairs below that threshold are not reported at all, because at this sample size they are noise.',
    );
  } else {
    lines.push('| A | B | Support | Together | Best single | Lift | Effect |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const pair of reportedPairs.slice(0, 15)) {
      lines.push(
        `| \`${pair.cardA}\` | \`${pair.cardB}\` | ${pair.support} | ${pct(pair.winRateTogether)} | ` +
          `${pct(Math.max(pair.winRateAOnly, pair.winRateBOnly))} | ${round(pair.lift * 100, 1)} pts | ${pair.effectSizeLabel} |`,
      );
    }
  }
  lines.push('');

  /* ------------------------------------------------------------ replacement */

  if (inputs.replacements.length > 0) {
    lines.push('## Controlled replacement *(inference — the closest thing here to causal)*');
    lines.push('');
    lines.push(
      '| Card | Replaced with | Base | Variant | Impact | Interval | Paired games | Confounds |',
    );
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const impact of inputs.replacements) {
      lines.push(
        `| \`${impact.subjectCardId}\` | \`${impact.replacementCardId ?? '—'}\` | ` +
          `${pct(impact.baseWinRate)} | ${pct(impact.variantWinRate)} | ` +
          `${round(impact.impact * 100, 1)} pts | ${round(impact.low * 100, 1)} … ${round(impact.high * 100, 1)} | ` +
          `${impact.pairedGames} | ${impact.confounds.length} |`,
      );
    }
    lines.push('');
    for (const impact of inputs.replacements.filter((entry) => entry.confounds.length > 0)) {
      lines.push(
        `- \`${impact.subjectCardId}\` → \`${impact.replacementCardId ?? 'nothing'}\` is **not a clean ` +
          `comparison**: ${impact.confounds.join('; ')}.`,
      );
    }
    lines.push('');
  }

  /* ------------------------------------------------------------- comparison */

  if (inputs.comparison) {
    lines.push('## Baseline versus candidate *(inference)*');
    lines.push('');
    lines.push(
      `${inputs.comparison.pairedGames} paired games (${pct(inputs.comparison.pairedCoverage)} of the ` +
        'baseline run) shared their seeds with the candidate run.',
    );
    lines.push('');

    const moved = inputs.comparison.referenceDeckDeltas.filter(
      (delta) => Math.abs(delta.delta) > 0.02,
    );
    lines.push('### Existing decks, unchanged');
    lines.push('');
    if (moved.length === 0) {
      lines.push('No reference deck moved by more than two win-rate points.');
    } else {
      lines.push('| Deck | Baseline | Candidate | Delta | Interval | Paired games |');
      lines.push('| --- | --- | --- | --- | --- | --- |');
      for (const delta of moved.slice(0, 15)) {
        lines.push(
          `| ${delta.deckId} | ${pct(delta.baselineWinRate)} | ${pct(delta.candidateWinRate)} | ` +
            `${round(delta.delta * 100, 1)} pts | ${round(delta.low * 100, 1)} … ${round(delta.high * 100, 1)} | ${delta.pairedGames} |`,
        );
      }
    }
    lines.push('');

    lines.push('### Newly discovered decks');
    lines.push('');
    lines.push(
      `Independent search found ${inputs.comparison.strategiesGained.length} deck(s) only in the candidate ` +
        `environment and ${inputs.comparison.strategiesLost.length} only in the baseline.`,
    );
    if (inputs.comparison.newlyViableCards.length > 0) {
      lines.push('');
      lines.push(
        `**Newly viable cards** (appear in searched decks only after the change): \`${inputs.comparison.newlyViableCards.join('`, `')}\``,
      );
    }
    if (inputs.comparison.displacedCards.length > 0) {
      lines.push('');
      lines.push('**Displaced cards** (at least halved their inclusion in searched decks):');
      lines.push('');
      for (const card of inputs.comparison.displacedCards) {
        lines.push(`- \`${card.definitionId}\`: ${card.before} → ${card.after}`);
      }
    }
    lines.push('');
  }

  /* ----------------------------------------------------------- deck search */

  if (inputs.searchHistory && inputs.searchHistory.length > 0) {
    lines.push('## Deck search *(observation)*');
    lines.push('');
    lines.push(
      '| Gen | Decks | Matches | Best score | Best win rate | Card entropy | Commanders | Mean distance |',
    );
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const generation of inputs.searchHistory) {
      lines.push(
        `| ${generation.generation} | ${generation.evaluated} | ${generation.matches} | ` +
          `${generation.best?.score ?? '—'} | ${generation.best ? pct(generation.best.winRate) : '—'} | ` +
          `${generation.cardEntropy} | ${generation.commanderCount} | ${generation.meanPairwiseDistance} |`,
      );
    }
    lines.push('');
    const notes = inputs.searchHistory.flatMap((generation) =>
      generation.notes.map((note) => `- generation ${generation.generation}: ${note}`),
    );
    if (notes.length > 0) {
      lines.push('Diversity and quality notes, reported rather than corrected:');
      lines.push('');
      lines.push(...notes);
      lines.push('');
    }
  }

  /* ------------------------------------------------------------- provenance */

  lines.push('## Reproducing this');
  lines.push('');
  lines.push('```bash');
  lines.push(`npm run simulate -- --config <this experiment's config.json>`);
  lines.push('```');
  lines.push('');
  lines.push(
    'Raw records are in `matches.jsonl`; every number above is recomputable from them. ' +
      '`manifest.json` records the exact configuration, seeds and software version this run used.',
  );
  lines.push('');

  return lines.join('\n');
}
