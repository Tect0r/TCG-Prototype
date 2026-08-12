import type { AnalysisSettings } from '../config.js';
import type { EnvironmentHashes } from '../content-hash.js';
import type { DeclaredDiffCheck, EnvironmentDiff } from '../environment.js';
import type { ReferencePopulation } from '../reference-population.js';
import type { Aggregate } from '../analysis/aggregate.js';
import type { ClusteringResult } from '../analysis/clusters.js';
import type { CardPair } from '../analysis/pairs.js';
import type { CounterBreadth } from '../analysis/counters.js';
import type { Displacement } from '../analysis/displacement.js';
import type { InclusionAnalysis } from '../analysis/inclusion.js';
import type { Multiplicity } from '../analysis/paired.js';
import type { ReplacementImpact } from '../analysis/replacement.js';
import type { RobustnessReport } from '../analysis/robustness.js';
import type { OpponentSensitivity } from '../analysis/sensitivity.js';
import type { ComparisonReport } from '../analysis/compare.js';
import type { Flag } from '../analysis/flags.js';
import type { GenerationReport } from '../deck-search/evolve.js';
import type { MatchupMatrix } from '../matchup-matrix.js';
import type { BoardAggregate, BoardMeasure } from '../analysis/board.js';
import { describeStallDefinition } from '@tcg/board-telemetry';
import { round } from '../analysis/stats.js';

/**
 * The human-readable report (CLAUDE.md §13.13, PHASE4_HARDENING §12).
 *
 * Two properties make this more than prose.
 *
 * **Self-auditing.** The provenance section carries everything needed to decide
 * whether the numbers below it can be believed and to reproduce them: the
 * configuration hash, the card-pool hashes, the frozen reference-population
 * hash, the seed-derivation and schema versions, the pilots and their versions,
 * every threshold that produced a flag, and the completed / failed / abnormal /
 * excluded / resumed match counts. Worker count is printed too, explicitly
 * marked as non-semantic, so nobody reads a performance setting as a variable.
 *
 * **Derived, never independent.** Every number here is read off the same objects
 * that are written to `summary.json`, and formatted through the helpers below.
 * The JSON is authoritative; this file and the CSVs are views of it, and a
 * regression test checks that they agree.
 *
 * The language is calibrated on purpose. Sections are labelled *observation*,
 * *controlled comparison*, *association* or *review signal*, and the words
 * `proves`, `causes`, `balanced` and `broken` do not appear about a result.
 */

/**
 * Version 3 (M03.4): a batch that ran the ordered matchup matrix gains a section
 * for it, between the outcome tables and the cluster analysis.
 *
 * Version 4 (M04.3): every batch gains an unlimited-board section — clutter, turn
 * length, trigger load and the stall verdict — between the outcome tables and the
 * matchup matrix.
 */
export const REPORT_SCHEMA_VERSION = 4;

export interface ReportPilot {
  readonly id: string;
  readonly version: string;
}

export interface ReportEnvironment {
  readonly id: string;
  readonly hash: string;
  readonly cardPoolHash: string;
  readonly label: string;
  /** The four separated hashes, when the caller resolved a full environment. */
  readonly hashes?: EnvironmentHashes;
  /** Where the frozen snapshot for this environment was written. */
  readonly snapshotPath?: string | null;
}

/** A built-in precon a deck source named by ID (M03.3). */
export interface ReportPrecon {
  readonly preconId: string;
  readonly name: string;
  readonly formatId: string;
  readonly deckHash: string;
}

export interface ReportAbnormal {
  readonly matchId: string;
  readonly termination: string;
  readonly replayPath: string | null;
}

export interface ReportInputs {
  readonly title: string;
  readonly experimentId: string;
  readonly kind: string;
  readonly seed: string;
  /** Hash of the normalized configuration. The run's identity. */
  readonly configHash: string;
  readonly softwareCommit: string | null;
  readonly rulesVersion: string;
  readonly seedDerivationVersion: number;
  readonly telemetrySchemaVersion: number;
  readonly analysisStatsVersion: number;
  readonly environmentSummaries: readonly ReportEnvironment[];
  readonly settings: AnalysisSettings;

  readonly aggregate: Aggregate;
  /**
   * The unlimited battlefield across the batch (M04.3).
   *
   * Aggregated over *every* record, including abnormal ones — see
   * `boardSection` for why that population differs from the rest of the report.
   */
  readonly board: BoardAggregate;
  readonly clustering: ClusteringResult;
  readonly inclusion: InclusionAnalysis;
  readonly pairs: readonly CardPair[];
  readonly replacements: readonly ReplacementImpact[];
  readonly sensitivity: readonly OpponentSensitivity[];
  readonly displacement: readonly Displacement[];
  readonly multiplicity: Multiplicity;
  readonly flags: readonly Flag[];
  readonly counters?: CounterBreadth | null;
  readonly robustness?: RobustnessReport | null;
  /** The ordered matchup matrix, when the batch was configured to run one (M03.4). */
  readonly matchupMatrix?: MatchupMatrix | null;

  readonly diff?: EnvironmentDiff;
  readonly declaredCheck?: DeclaredDiffCheck;
  readonly referencePopulation?: ReferencePopulation;
  readonly comparison?: ComparisonReport;
  readonly searchHistory?: readonly GenerationReport[];

  /* ------------------------------------------------------------ provenance */
  /** Where the raw records this report was derived from actually live. */
  readonly matchesPath: string;
  readonly resumedMatches: number;
  readonly recoveredLines: number;
  readonly failedMatches: number;
  readonly abnormalMatches: readonly ReportAbnormal[];
  readonly deckCount: number;
  /** Precons the run was configured from, by permanent ID. Empty when none. */
  readonly precons?: readonly ReportPrecon[];
  readonly pilots: readonly ReportPilot[];
  readonly wallClockMs: number;
  readonly workers: number;
  readonly extraLimitations?: readonly string[];
}

/* -------------------------------------------------------------- formatting */

/** For values genuinely bounded to 0–1. Never used on an unbounded ratio. */
const pct = (value: number): string => `${round(value * 100, 1)}%`;

/** Win-rate differences, printed in points rather than as a second percentage. */
const pts = (value: number): string => `${round(value * 100, 1)} pts`;

/** Unbounded ratios such as `playsPerDraw`. Printed as a number, never a %. */
const ratio = (value: number): string => `${round(value, 3)}×`;

const interval = (low: number, high: number, format: (value: number) => string): string =>
  Number.isFinite(low) && Number.isFinite(high) ? `${format(low)} … ${format(high)}` : '—';

const orDash = (value: string | number | null | undefined): string =>
  value === null || value === undefined || value === '' ? '—' : String(value);

/** How much of a long list the written report shows before deferring to JSON. */
const FLAG_TABLE_LIMIT = 30;
const FLAG_DETAIL_LIMIT = 15;
const TABLE_LIMIT = 15;
const ABNORMAL_LIMIT = 20;

export function renderReport(inputs: ReportInputs): string {
  const lines: string[] = [];

  lines.push(`# ${inputs.title}`);
  lines.push('');
  lines.push(
    'Simulated evidence from heuristic pilots. **This is not a balance verdict.** ' +
      'Everything below describes what these bots did with these decks under these rules; ' +
      'a card is worth reviewing when the evidence says so, and a human decides what to change.',
  );
  lines.push('');

  section(lines, limitations(inputs));
  section(lines, provenance(inputs));
  section(lines, evidenceLegend());
  section(lines, thresholds(inputs));
  section(lines, environmentDiff(inputs));
  section(lines, referencePopulation(inputs));
  section(lines, flagSection(inputs));
  section(lines, outcomes(inputs));
  section(lines, boardSection(inputs));
  section(lines, matchupMatrixSection(inputs));
  section(lines, clusters(inputs));
  section(lines, cards(inputs));
  section(lines, crossClusterInclusion(inputs));
  section(lines, cardPairSection(inputs));
  section(lines, replacementSection(inputs));
  section(lines, counterSection(inputs));
  section(lines, sensitivitySection(inputs));
  section(lines, displacementSection(inputs));
  section(lines, robustnessSection(inputs));
  section(lines, comparisonSection(inputs));
  section(lines, searchSection(inputs));
  section(lines, abnormalSection(inputs));
  section(lines, reproducing(inputs));

  return lines.join('\n');
}

function section(lines: string[], block: readonly string[]): void {
  if (block.length === 0) return;
  lines.push(...block);
  lines.push('');
}

/* ------------------------------------------------------------- limitations */

function limitations(inputs: ReportInputs): string[] {
  const { aggregate: agg, settings } = inputs;
  const lines = ['## Limitations, first', ''];

  const items = [
    `Pilots are transparent heuristics, not skilled players: ` +
      `${inputs.pilots.map((pilot) => `${pilot.id}@${pilot.version}`).join(', ')}. ` +
      'A card that rewards play the pilots cannot perform will look weak here.',
    `${agg.run.usableMatches} usable matches over ${inputs.deckCount} decks. ` +
      `Card conclusions need ${settings.minMatchesPerCard} seat-matches; pair conclusions need ` +
      `${settings.minPairSupport} co-occurrences in the "both" cell and ` +
      `${settings.minPairCellSupport} in every contributing cell.`,
    'Individual deck win rates are samples from one opponent field, not a balance model.',
    'Every threshold in this report is a configurable review dial, printed in full below and ' +
      'alongside each flag.',
    inputs.multiplicity.note,
    ...(inputs.extraLimitations ?? []),
    ...(inputs.comparison?.limitations ?? []),
  ];

  if (agg.run.abnormalMatches > 0) {
    items.push(
      `${agg.run.abnormalMatches} match(es) ended abnormally and were excluded from every statistic ` +
        'below. They are listed with their replay commands at the end of this report.',
    );
  }
  if (inputs.failedMatches > 0) {
    items.push(
      `${inputs.failedMatches} match(es) failed to run at all and produced no record. Any ` +
        'per-deck or per-card denominator below is short by that much.',
    );
  }
  if (inputs.recoveredLines > 0) {
    items.push(
      `${inputs.recoveredLines} damaged line(s) were dropped when resuming from ` +
        `\`${inputs.matchesPath}\`. Those matches were re-run, not lost, but the recovery is ` +
        'recorded so an unexplained count change is traceable.',
    );
  }
  if (inputs.declaredCheck && inputs.declaredCheck.warnings.length > 0) {
    items.push(
      'The candidate environment differs from the baseline in ways the experiment did not ' +
        'declare, so a difference measured below cannot be attributed to the declared change ' +
        'alone. The undeclared differences are listed in the environment diff.',
    );
  }

  for (const item of items) lines.push(`- ${item}`);
  return lines;
}

/* -------------------------------------------------------------- provenance */

function provenance(inputs: ReportInputs): string[] {
  const { aggregate: agg } = inputs;
  const lines = ['## Provenance and self-audit *(observation)*', ''];
  lines.push('| Field | Value |');
  lines.push('| --- | --- |');
  lines.push(`| Experiment | \`${inputs.experimentId}\` |`);
  lines.push(`| Experiment type | ${inputs.kind} |`);
  lines.push(`| Report schema | v${REPORT_SCHEMA_VERSION} |`);
  lines.push(`| Configuration hash | \`${inputs.configHash}\` |`);
  lines.push(`| Root seed | \`${inputs.seed}\` |`);
  lines.push(`| Seed derivation | v${inputs.seedDerivationVersion} |`);
  lines.push(`| Telemetry schema | v${inputs.telemetrySchemaVersion} |`);
  lines.push(`| Analysis statistics | v${inputs.analysisStatsVersion} |`);
  lines.push(`| Rules version | ${inputs.rulesVersion} |`);
  lines.push(`| Software commit | ${orDash(inputs.softwareCommit)} |`);
  for (const environment of inputs.environmentSummaries) {
    lines.push(
      `| Environment \`${environment.id}\` | ${environment.label} — content \`${environment.hash}\` |`,
    );
    if (environment.hashes) {
      // Separated by what each one actually guarantees (§9 G3), so a reader can
      // tell "this replays identically" from "this reads identically".
      lines.push(
        `| ⤷ \`${environment.id}\` hashes | mechanics (replay equivalence) ` +
          `\`${environment.hashes.mechanicsHash}\`, pilot input \`${environment.hashes.pilotInputHash}\`, ` +
          `presentation \`${environment.hashes.presentationHash}\`, full content ` +
          `\`${environment.hashes.fullContentHash}\` |`,
      );
    }
    if (environment.snapshotPath) {
      lines.push(`| ⤷ \`${environment.id}\` frozen as | \`${environment.snapshotPath}\` |`);
    }
  }
  if (inputs.referencePopulation) {
    lines.push(
      `| Reference population | \`${inputs.referencePopulation.hash}\` ` +
        `(${inputs.referencePopulation.decks.length} deck(s), policy ` +
        `\`${inputs.referencePopulation.policy}\`) |`,
    );
  }
  for (const pilot of inputs.pilots) {
    lines.push(`| Pilot \`${pilot.id}\` | version ${pilot.version} |`);
  }
  lines.push(`| Raw records | \`${inputs.matchesPath}\` |`);
  lines.push(`| Matches completed | ${agg.run.matches} |`);
  lines.push(`| Matches usable | ${agg.run.usableMatches} |`);
  lines.push(
    `| Matches abnormal (excluded from statistics) | ${agg.run.abnormalMatches} ` +
      `(${pct(agg.run.abnormalShare)}) |`,
  );
  lines.push(`| Matches failed (no record) | ${inputs.failedMatches} |`);
  lines.push(`| Matches resumed from a previous run | ${inputs.resumedMatches} |`);
  lines.push(`| Damaged lines recovered | ${inputs.recoveredLines} |`);
  if (inputs.referencePopulation) {
    lines.push(
      `| Reference decks excluded as illegal | ${inputs.referencePopulation.excluded.length} |`,
    );
  }
  lines.push(`| Decks | ${inputs.deckCount} |`);
  for (const precon of inputs.precons ?? []) {
    // Named individually, with the deck hash it resolved to: "we ran the four
    // precons" is only checkable if a reader can see which lists that meant.
    lines.push(
      `| Precon \`${precon.preconId}\` | ${precon.name} (${precon.formatId}) — deck ` +
        `\`${precon.deckHash}\` |`,
    );
  }
  lines.push(`| Workers *(non-semantic)* | ${inputs.workers} |`);
  lines.push(`| Wall clock *(non-semantic)* | ${round(inputs.wallClockMs / 1000, 1)} s |`);
  lines.push('');
  lines.push(
    'Worker count and wall clock cannot change any number in this report: records are sorted ' +
      'into a canonical order before anything is aggregated, so the same configuration hash ' +
      'always produces the same results.',
  );
  return lines;
}

function evidenceLegend(): string[] {
  return [
    '## How to read the evidence labels',
    '',
    '| Label | What it means | What it does not mean |',
    '| --- | --- | --- |',
    '| *observation* | A count or rate read directly off the raw records. | Nothing about cause. |',
    '| *association* | Two things co-occurred in decks a search or a human chose. | That either caused the other. |',
    '| *controlled comparison* | One card or rule changed, everything else held fixed on common seeds. | That the effect generalises past these pilots and this field. |',
    '| *review signal* | A threshold was crossed and a human should look. | That anything is overpowered, broken or balanced. |',
    '| *insufficient evidence* | The sample was too small or a required group was empty. | That nothing is there. |',
  ];
}

function thresholds(inputs: ReportInputs): string[] {
  const { settings } = inputs;
  const entries = Object.entries(settings).sort(([left], [right]) => left.localeCompare(right));
  const lines = ['## Thresholds and minimum-sample rules *(configuration)*', ''];
  lines.push(
    'Every one of these is a review dial, not a game rule. They are printed in full so a reader ' +
      'can see exactly which setting produced which flag, and change one and re-derive.',
  );
  lines.push('');
  lines.push('| Setting | Value |');
  lines.push('| --- | --- |');
  for (const [name, value] of entries) lines.push(`| \`${name}\` | ${String(value)} |`);
  return lines;
}

/* -------------------------------------------------------- environment diff */

function environmentDiff(inputs: ReportInputs): string[] {
  if (!inputs.diff) return [];
  const lines = ['## Environment diff *(observation)*', ''];

  if (inputs.diff.identical) {
    lines.push('The two environments are byte-identical. Nothing changed, so nothing is measured.');
  } else {
    if (inputs.diff.cardsAdded.length > 0) {
      lines.push(`- **Cards added:** \`${inputs.diff.cardsAdded.join('`, `')}\``);
    }
    if (inputs.diff.cardsRemoved.length > 0) {
      lines.push(`- **Cards removed:** \`${inputs.diff.cardsRemoved.join('`, `')}\``);
    }
    for (const changed of inputs.diff.cardsChanged) {
      lines.push(
        `- **\`${changed.cardId}\` changed** in ${changed.fields.join(', ')}:\n` +
          `  - baseline: \`${changed.before}\`\n` +
          `  - candidate: \`${changed.after}\``,
      );
    }
    for (const rule of inputs.diff.rulesChanged) {
      lines.push(`- **Rule \`${rule.key}\`:** \`${rule.before}\` → \`${rule.after}\``);
    }
    for (const format of inputs.diff.formatChanged) {
      lines.push(`- **Format \`${format.key}\`:** \`${format.before}\` → \`${format.after}\``);
    }
  }

  if (inputs.declaredCheck) {
    lines.push('');
    lines.push('### Declared-change verification');
    lines.push('');
    lines.push(
      inputs.declaredCheck.ok
        ? 'The structured diff above was checked against what this experiment declared it ' +
            'changes, **before any match ran**, and they agree.'
        : 'The declared change and the resolved card pools disagree. This run should not have ' +
            'started.',
    );
    if (inputs.declaredCheck.errors.length > 0) {
      lines.push('');
      for (const error of inputs.declaredCheck.errors) lines.push(`- **Error:** ${error}`);
    }
    if (inputs.declaredCheck.warnings.length > 0) {
      lines.push('');
      lines.push(
        '**Undeclared differences.** The experiment is changing more than one thing, so a ' +
          'measured difference cannot be attributed to the declared change alone:',
      );
      lines.push('');
      for (const warning of inputs.declaredCheck.warnings) lines.push(`- ${warning}`);
    }
  }

  return lines;
}

/* ------------------------------------------------- frozen reference population */

function referencePopulation(inputs: ReportInputs): string[] {
  const population = inputs.referencePopulation;
  if (!population) return [];

  const lines = ['## Reference population *(observation)*', ''];
  lines.push(
    `${population.decks.length} deck(s), resolved **once** against \`${population.resolvedAgainst}\` ` +
      `and replayed unchanged in both environments. Content hash \`${population.hash}\` ` +
      `(before legality filtering: \`${population.resolvedHash}\`).`,
  );
  lines.push('');
  lines.push(
    'The identical deck definitions, seat assignments, pilots and derived seeds are used in both ' +
      'arms. A population that differed between arms would make every deck-level delta a mixture ' +
      'of the environment change and two different decklists, so the comparison refuses to run ' +
      'if the two hashes ever diverge.',
  );

  if (population.excluded.length > 0) {
    lines.push('');
    lines.push(
      `${population.excluded.length} deck(s) were excluded for being illegal in at least one ` +
        'environment. They are excluded from **both** arms, never repaired for one side:',
    );
    lines.push('');
    lines.push('| Deck | Rejected by | Reasons |');
    lines.push('| --- | --- | --- |');
    for (const excluded of population.excluded.slice(0, TABLE_LIMIT)) {
      lines.push(
        `| \`${excluded.deckId}\` | \`${excluded.environmentId}\` | ${excluded.reasons.join('; ')} |`,
      );
    }
  }

  return lines;
}

/* ------------------------------------------------------------------- flags */

function flagSection(inputs: ReportInputs): string[] {
  const lines = ['## Strongest evidence *(review signals — recommendations to look)*', ''];

  const actionable = inputs.flags.filter(
    (flag) => flag.level === 'review_recommended' || flag.level === 'possible_interaction',
  );

  if (actionable.length === 0) {
    lines.push(
      'No flag cleared its configured threshold. That is **not** a statement that the environment ' +
        'is healthy — at this sample size it most often means there was not enough evidence to ' +
        'say anything either way.',
    );
  } else {
    const shown = actionable.slice(0, FLAG_TABLE_LIMIT);
    if (actionable.length > shown.length) {
      lines.push(
        `Showing the ${shown.length} strongest of ${actionable.length} flags. The complete list, ` +
          'with the evidence behind each one, is in `summary.json`.',
      );
      lines.push('');
    }
    lines.push('| Level | Reason | Subject | Sample | Interval | Threshold |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const flag of shown) {
      const bounds = flag.interval
        ? `${round(flag.interval.low, 3)} … ${round(flag.interval.high, 3)}`
        : '—';
      const threshold = flag.threshold ? `${flag.threshold.name} = ${flag.threshold.value}` : '—';
      lines.push(
        `| ${flag.level} | \`${flag.reason}\` | \`${flag.subject}\` | ${flag.sampleSize} | ` +
          `${bounds} | ${threshold} |`,
      );
    }
    lines.push('');
    for (const flag of shown.slice(0, FLAG_DETAIL_LIMIT)) {
      lines.push(`- **\`${flag.subject}\`** — ${flag.message}`);
    }
  }

  lines.push('');
  lines.push(`*Scan width:* ${inputs.multiplicity.note}`);

  const quality = inputs.flags.filter((flag) => flag.level === 'run_quality');
  if (quality.length > 0) {
    lines.push('');
    lines.push('### Run quality');
    lines.push('');
    for (const flag of quality) lines.push(`- ${flag.message}`);
  }

  const unknown = inputs.flags.filter((flag) => flag.level === 'insufficient_data');
  if (unknown.length > 0) {
    lines.push('');
    lines.push(
      `### Insufficient evidence (${unknown.length} subject${unknown.length === 1 ? '' : 's'})`,
    );
    lines.push('');
    lines.push(
      'Listed so that "we did not measure this" stays visible instead of looking like ' +
        '"we found nothing":',
    );
    lines.push('');
    lines.push(`\`${unknown.map((flag) => flag.subject).join('`, `')}\``);
  }

  return lines;
}

/* ---------------------------------------------------------------- outcomes */

function outcomes(inputs: ReportInputs): string[] {
  const { aggregate: agg } = inputs;
  const lines = ['## Match outcomes *(observation)*', ''];

  lines.push('| Termination | Matches |');
  lines.push('| --- | --- |');
  for (const [kind, count] of Object.entries(agg.run.terminations).sort()) {
    lines.push(`| ${kind} | ${count} |`);
  }
  lines.push('');
  lines.push(
    `Turns: mean ${agg.run.turns.mean}, median ${agg.run.turns.median}, ` +
      `p10 ${agg.run.turns.p10}, p90 ${agg.run.turns.p90}, max ${agg.run.turns.max}. ` +
      `Draws: ${agg.run.draws}. Decisions per match: ${agg.run.decisionsPerMatch}. ` +
      `Pilot fallbacks: ${agg.run.botFailures}.`,
  );

  if (agg.run.seatWinRates.length > 0) {
    lines.push('');
    lines.push(
      '**Seat win rates.** The schedule mirrors seats, so a gap here whose intervals do not ' +
        'overlap is a rules effect rather than a scheduling artefact:',
    );
    lines.push('');
    lines.push('| Seat | Win rate | Interval | Seat-matches |');
    lines.push('| --- | --- | --- | --- |');
    for (const seat of agg.run.seatWinRates) {
      lines.push(
        `| ${seat.seatIndex} | ${pct(seat.rate.point)} | ` +
          `${interval(seat.rate.low, seat.rate.high, pct)} | ${seat.rate.total} |`,
      );
    }
  }

  if (agg.run.pilotWinRates.length > 1) {
    lines.push('');
    lines.push('**Pilot win rates:**');
    lines.push('');
    lines.push('| Pilot | Win rate | Interval | Seat-matches |');
    lines.push('| --- | --- | --- | --- |');
    for (const pilot of agg.run.pilotWinRates) {
      lines.push(
        `| ${pilot.pilotId} | ${pct(pilot.rate.point)} | ` +
          `${interval(pilot.rate.low, pilot.rate.high, pct)} | ${pilot.rate.total} |`,
      );
    }
  }

  return lines;
}

/* ----------------------------------------------------- unlimited board */

/**
 * What the unbounded battlefield actually did across the batch (M04.3).
 *
 * `CLAUDE.md` says the battlefield has no Unit limit and that large boards are
 * "measured, not treated as proof that a cap is needed". This section is that
 * measurement, and it is written to be capable of saying nothing is wrong: four
 * questions, each answered by a distribution rather than an average, and a stall
 * verdict produced by a rule that lives in the engine-side collector rather than
 * here.
 *
 * **The population is every match, abnormal ones included**, which is the one
 * place this report deliberately departs from the sample every other section
 * uses. A match that hit the turn limit or made no progress is the strongest
 * stall candidate in a batch and usually holds the widest board in it; excluding
 * it would bias the single question this section exists to answer. The count is
 * printed so the reader can weigh it.
 */
function boardSection(inputs: ReportInputs): string[] {
  const board = inputs.board;
  if (board.matches === 0) return [];

  const lines = ['## Unlimited board *(observation)*', ''];
  lines.push(
    `Measured over all ${board.matches} match(es) in this run, including the ` +
      `${inputs.abnormalMatches.length} that terminated abnormally — a match that hit the turn ` +
      'limit is the most likely stall in a batch, so this is the one section that does not ' +
      'exclude them. Nothing here is a balance finding: it says whether an unlimited ' +
      'battlefield produced clutter, long turns, trigger overload or stalls under these ' +
      'pilots and these decks.',
    '',
    'measure | max | p90 | mean | widest match',
    '--- | ---: | ---: | ---: | ---',
  );

  const row = (label: string, value: BoardMeasure): string =>
    `${label} | ${value.max} | ${round(value.p90, 2)} | ${round(value.mean, 2)} | ${orDash(value.matchId)}`;

  lines.push(
    row('peak Units (one seat)', board.peakUnits),
    row('peak non-Token Units', board.peakNonTokenUnits),
    row('peak identical-Token stack', board.peakTokenStack),
    row('longest turn (actions)', board.longestTurnActions),
    row('largest combat (attackers)', board.largestCombatAttackers),
    row('costliest combat (events)', board.longestCombatEvents),
    row('busiest turn (triggers)', board.busiestTurnTriggers),
    row('busiest turn (choices)', board.busiestTurnChoices),
    '',
  );

  // The attack-opportunity totals, which are the evidence the verdict is cut
  // from. Printed before it, so the verdict is never the first thing read.
  lines.push(
    `**Attack opportunity.** ${board.attackSteps} attack step(s) across the batch: ` +
      `${board.attackStepsAble} where the seat could attack, of which ` +
      `${board.attackStepsDeclined} declined, and ${board.attackStepsUnable} where it could ` +
      `not attack at all. ${board.readyPreventions} Ready Step(s) were rewritten by an effect.`,
    '',
  );

  if (board.mixedStallDefinitions) {
    // Refusing to add up verdicts asked under different rules, rather than
    // presenting a count whose meaning varies from record to record.
    lines.push(
      '**Stalls: not summarised.** The records in this run were classified under more than one ' +
        'stall definition, so the verdicts are not one population and are not counted here. ' +
        'Each record still carries its own `board.attackOpportunity.stallDefinition`.',
    );
    return lines;
  }

  const definition = board.stallDefinition;
  lines.push(
    `**Stall rule.** ${definition ? describeStallDefinition(definition) : 'not recorded'}. ` +
      'A round in which anybody attacked, or which any living seat did not reach, or in which ' +
      'any asked seat could not legally have attacked, is not counted — so "no attackers this ' +
      'round" is never on its own evidence of a stall (Q43, M04 acceptance).',
    '',
    `**Stall verdict.** ${board.stalledMatches} of ${board.matches} match(es) classified ` +
      `\`stalled\`. Longest qualifying run in the batch: ${board.stallStreak.max} round(s) ` +
      `(mean ${round(board.stallStreak.mean, 2)}). For contrast, the permissive series the ` +
      'verdict does *not* read — quiet rounds where at least one seat could have attacked — ' +
      `reached ${board.declinedStreak.max} round(s), and quiet rounds where nobody could ` +
      `reached ${board.unableStreak.max}.`,
  );

  if (board.stalledMatchIds.length > 0) {
    lines.push(
      '',
      `Stalled matches: ${board.stalledMatchIds.join(', ')}` +
        (board.stalledMatches > board.stalledMatchIds.length
          ? ` … and ${board.stalledMatches - board.stalledMatchIds.length} more (see \`${inputs.matchesPath}\`)`
          : ''),
    );
  }

  return lines;
}

/* --------------------------------------------------------- matchup matrix */

/**
 * The ordered matchup matrix (M03.4).
 *
 * Deliberately written as a termination report rather than a results table. The
 * cells do carry who won, because a matrix that hid its own outcomes would be
 * unauditable, but every framing sentence around them says what the artifact is
 * for: showing that each ordered pair of decks finishes, deterministically and
 * cleanly. Win counts from one game per cell and heuristic pilots are not
 * evidence about balance, and this section refuses to present them as any.
 */
function matchupMatrixSection(inputs: ReportInputs): string[] {
  const matrix = inputs.matchupMatrix;
  if (!matrix) return [];

  const lines = ['## Ordered matchup matrix *(observation)*', ''];
  lines.push(
    `Every ordered pair of the ${matrix.decks.length} deck(s) below — each one in the first seat ` +
      `against each one in the second, mirrors on the diagonal — is ${matrix.expectedCells} cell(s), ` +
      `of which ${matrix.playedCells} were played over ${matrix.games} game(s) derived from root ` +
      `seed \`${matrix.seed}\`.`,
  );
  lines.push('');
  lines.push(
    '**This is a robustness artifact, not a balance measurement.** It exists to show that every ' +
      'ordered pair terminates deterministically with no illegal action, no loop and no crash. ' +
      'The winner column is here so the run is auditable, not so it can be read as a win rate: ' +
      'the pilots are transparent heuristics, the cells hold a handful of seeded games each, and ' +
      'nothing here is corrected for anything. No conclusion about deck strength may be drawn ' +
      'from this section.',
  );
  lines.push('');

  if (!matrix.complete) {
    lines.push(
      `⚠ **Incomplete.** ${matrix.missing.length} ordered pair(s) produced no record: ` +
        `${matrix.missing.map((pair) => `\`${pair}\``).join(', ')}. The grid below is therefore ` +
        'not the whole matrix.',
    );
    lines.push('');
  }

  // Grid: rows are the first seat, columns the second.
  const header = ['First seat ↓ / second seat →', ...matrix.decks.map((deck) => deck.deckId)];
  lines.push(`| ${header.join(' | ')} |`);
  lines.push(`| ${header.map(() => '---').join(' | ')} |`);
  for (const first of matrix.decks) {
    const cellsForRow = matrix.decks.map((second) => {
      const cell = matrix.cells.find(
        (entry) =>
          entry.firstSeatDeckId === first.deckId && entry.secondSeatDeckId === second.deckId,
      );
      if (!cell) return '— *(not played)*';
      const counts = `${cell.firstSeatWins}–${cell.secondSeatWins}`;
      const draws = cell.draws > 0 ? `, ${cell.draws} draw(s)` : '';
      const unclean = cell.unclean > 0 ? ` ⚠ ${cell.unclean}` : '';
      return `${counts}${draws}${unclean}`;
    });
    lines.push(`| **${first.deckId}** | ${cellsForRow.join(' | ')} |`);
  }
  lines.push('');
  lines.push(
    'Each cell reads *first-seat wins – second-seat wins*, counted over the games in that cell. ' +
      '⚠ marks games with an invariant failure.',
  );
  lines.push('');

  lines.push(
    `**Clean terminations:** ${matrix.cleanGames} of ${matrix.games} game(s). ` +
      (matrix.invariantFailures.length === 0
        ? 'No abnormal termination, engine diagnostic or pilot failure was recorded in any cell.'
        : `${matrix.invariantFailures.length} invariant failure(s) were recorded:`),
  );
  if (matrix.invariantFailures.length > 0) {
    lines.push('');
    lines.push('| Matchup | Match | Failure | Replay |');
    lines.push('| --- | --- | --- | --- |');
    for (const failure of matrix.invariantFailures.slice(0, ABNORMAL_LIMIT)) {
      lines.push(
        `| ${failure.firstSeatDeckId} → ${failure.secondSeatDeckId} | \`${failure.matchId}\` | ` +
          `${failure.detail} | ${failure.replayPath ? `\`${failure.replayPath}\`` : 'not retained'} |`,
      );
    }
    if (matrix.invariantFailures.length > ABNORMAL_LIMIT) {
      lines.push('');
      lines.push(
        `${matrix.invariantFailures.length - ABNORMAL_LIMIT} further failure(s) are in ` +
          '`matchup-matrix.json`.',
      );
    }
  }
  lines.push('');

  // The board per cell (M04.3). Kept in the matrix rather than only in the batch
  // section because a pairing that consistently stalls, or consistently produces
  // a very wide board, is a property of those two decks facing each other and is
  // invisible once every cell is averaged into one distribution.
  lines.push('**Unlimited board, per cell** — widest board / longest turn / largest combat:');
  lines.push('');
  const boardHeader = ['First seat ↓ / second seat →', ...matrix.decks.map((deck) => deck.deckId)];
  lines.push(`| ${boardHeader.join(' | ')} |`);
  lines.push(`| ${boardHeader.map(() => '---').join(' | ')} |`);
  for (const first of matrix.decks) {
    const cellsForRow = matrix.decks.map((second) => {
      const cell = matrix.cells.find(
        (entry) =>
          entry.firstSeatDeckId === first.deckId && entry.secondSeatDeckId === second.deckId,
      );
      if (!cell || cell.games.length === 0) return '—';
      // Worst case over the cell's games: a cell is a claim about a pairing, and
      // the pairing's worst board is what an unbounded battlefield is judged on.
      const peak = Math.max(...cell.games.map((game) => game.board.peakUnits));
      const turn = Math.max(...cell.games.map((game) => game.board.longestTurnActions));
      const combat = Math.max(...cell.games.map((game) => game.board.largestCombatAttackers));
      const stalled = cell.games.filter(
        (game) => game.board.stallClassification === 'stalled',
      ).length;
      return `${peak} / ${turn} / ${combat}${stalled > 0 ? ` ⚠ ${stalled} stalled` : ''}`;
    });
    lines.push(`| **${first.deckId}** | ${cellsForRow.join(' | ')} |`);
  }
  lines.push('');
  lines.push(
    'Each cell is the worst case over its games. ⚠ marks games the configured stall rule ' +
      'classified as stalled — see the unlimited-board section above for the rule itself.',
  );
  lines.push('');

  lines.push('**Decks, pilots and seeds:**');
  lines.push('');
  lines.push('| Deck | Precon | Commander | Deck hash |');
  lines.push('| --- | --- | --- | --- |');
  for (const deck of matrix.decks) {
    lines.push(
      `| ${deck.deckId} | ${deck.preconId ? `\`${deck.preconId}\`` : '—'} | ` +
        `\`${deck.commanderId}\` | \`${deck.deckHash}\` |`,
    );
  }
  lines.push('');
  lines.push(
    `Format \`${orDash(matrix.formatId)}\`, environment \`${matrix.environmentId}\` ` +
      `(content \`${matrix.environmentHash}\`), pilots ` +
      `${matrix.pilots.map((pilot) => `\`${pilot.id}\`@${pilot.version}`).join(', ') || '—'}. ` +
      'Every game’s full seed path, seat order, starting player, termination and replay ' +
      'reference is in `matchup-matrix.json` and `matchup-matrix.csv`; the same root seed and ' +
      `configuration hash reproduce the identical ${matrix.games} match ID(s).`,
  );

  return lines;
}

/* ---------------------------------------------------------------- clusters */

function clusters(inputs: ReportInputs): string[] {
  if (inputs.clustering.clusters.length === 0) return [];
  const lines = ['## Strategic clusters *(observation)*', ''];
  lines.push(
    'Decks grouped by named, inspectable features — colours, curve, type and role mix, keyword ' +
      'density. No model, no archetype naming.',
  );
  lines.push('');
  lines.push('| Cluster | Description | Decks | Win rate | Interval | Seat-matches |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const cluster of inputs.clustering.clusters) {
    lines.push(
      `| \`${cluster.id}\` | ${cluster.label} | ${cluster.deckHashes.length} | ` +
        `${pct(cluster.winRate.point)} | ${interval(cluster.winRate.low, cluster.winRate.high, pct)} | ` +
        `${cluster.matches} |`,
    );
  }
  lines.push('');
  lines.push(
    `Largest cluster holds ${pct(inputs.clustering.largestClusterShare)} of the decks. ` +
      `${inputs.inclusion.eligibleClusters} cluster(s) met the eligibility minimums; ` +
      `${inputs.inclusion.ineligibleClusters} did not and are excluded from cross-cluster ` +
      'denominators.',
  );
  return lines;
}

/* ------------------------------------------------------------------- cards */

function cards(inputs: ReportInputs): string[] {
  const { aggregate: agg, settings } = inputs;
  const lines = ['## Cards *(association)*', ''];
  lines.push(
    'Inclusion win rates are **correlations**: a card is not responsible for a win because it was ' +
      'in the deck. Use the controlled replacement section for anything causal.',
  );
  lines.push('');
  lines.push(
    '`plays/draw` is **unbounded** — a card returned to hand and replayed legitimately exceeds ' +
      '1×, so it is printed as a multiplier and never as a percentage. `copy conv.` and ' +
      '`game conv.` are the two bounded conversion measures: the share of drawn copies that were ' +
      'ever played, and the share of games where a drawn card was also played.',
  );
  lines.push('');

  const reported = [...agg.cards]
    .filter((card) => card.seatMatches >= settings.minMatchesPerCard)
    .sort(
      (left, right) =>
        right.inclusionWinRateLift - left.inclusionWinRateLift ||
        left.definitionId.localeCompare(right.definitionId),
    )
    .slice(0, TABLE_LIMIT);

  if (reported.length === 0) {
    lines.push(
      `No card reached ${settings.minMatchesPerCard} seat-matches, so no card-level number is ` +
        'reported. The raw per-card counts are in `card-usage.csv`.',
    );
    return lines;
  }

  lines.push(
    '| Card | Decks | Seat-matches | With | Without | Lift | plays/draw | copy conv. | game conv. | Dead in hand |',
  );
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const card of reported) {
    lines.push(
      `| \`${card.definitionId}\` | ${card.decksIncluding} | ${card.seatMatches} | ` +
        `${pct(card.winRateWhenIncluded.point)} | ${pct(card.winRateWhenAbsent.point)} | ` +
        `${pts(card.inclusionWinRateLift)} | ${ratio(card.playsPerDraw)} | ` +
        `${card.drawnCopyPlayConversion === null ? 'unavailable' : pct(card.drawnCopyPlayConversion)} | ` +
        `${pct(card.gamesDrawnAndPlayedShare)} | ${pct(card.deadInHandShare)} |`,
    );
  }

  lines.push('');
  lines.push(
    '**Dead in hand** splits into a mechanical half and a strategic half, because they are ' +
      'different findings: a card that could not legally be played says something about the card, ' +
      'and a card that was legal and passed over says something about these pilots.',
  );
  lines.push('');
  lines.push('| Card | Dead | Mechanically unusable | Strategically unused |');
  lines.push('| --- | --- | --- | --- |');
  for (const card of reported) {
    lines.push(
      `| \`${card.definitionId}\` | ${pct(card.deadInHandShare)} | ` +
        `${pct(card.mechanicallyUnusableShare)} | ${pct(card.strategicallyUnusedShare)} |`,
    );
  }

  return lines;
}

/* --------------------------------------------- cross-cluster inclusion (§5) */

function crossClusterInclusion(inputs: ReportInputs): string[] {
  const { inclusion } = inputs;
  const qualifying = inclusion.cards.filter((card) => card.qualifies);
  const lines = ['## Cross-cluster inclusion *(review signal)*', ''];

  lines.push(
    'Coverage of **strategic clusters**, not of individual decks. Thirty near-identical decks all ' +
      'running the same removal spell are one strategy counted thirty times, so deck share cannot ' +
      'answer "does every strategy want this card". A cluster only counts when it has at least ' +
      `${inclusion.thresholds.minDecksPerCluster} deck(s) and ` +
      `${inclusion.thresholds.minObservationsPerCluster} seat-match(es); a card covers a cluster ` +
      `when at least ${pct(inclusion.thresholds.withinClusterInclusionThreshold)} of that ` +
      "cluster's decks run it.",
  );
  lines.push('');
  lines.push(
    `${inclusion.eligibleClusters} eligible cluster(s), ${inclusion.ineligibleClusters} excluded ` +
      'as too small or too rarely observed.',
  );

  if (qualifying.length === 0) {
    lines.push('');
    lines.push(
      'No card met every condition. Deck-level inclusion is reported separately in ' +
        '`cluster-inclusion.csv` and is **not** the same measure.',
    );
    return lines;
  }

  lines.push('');
  lines.push(
    'Broad inclusion is a review signal for **low opportunity cost or broad generic utility**. ' +
      'It is not evidence that a card is unhealthy: a card every strategy wants may simply be a ' +
      'good generic card in a small pool.',
  );
  lines.push('');
  lines.push(
    '| Card | Covered / eligible clusters | Cross-cluster share | Deck share | Supporting seat-matches | Qualifying clusters |',
  );
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const card of qualifying.slice(0, TABLE_LIMIT)) {
    const covered = card.perCluster
      .filter((entry) => entry.covered)
      .map(
        (entry) =>
          `${entry.clusterId} ${entry.decksIncluding}/${entry.decksInCluster} (${pct(entry.inclusion)})`,
      )
      .join('; ');
    lines.push(
      `| \`${card.definitionId}\` | ${card.coveredClusters} / ${card.eligibleClusters} | ` +
        `${pct(card.crossClusterShare)} | ${pct(card.deckInclusionShare)} | ` +
        `${card.supportingObservations} | ${covered} |`,
    );
  }

  return lines;
}

/* ------------------------------------------------------------------- pairs */

function cardPairSection(inputs: ReportInputs): string[] {
  const { settings } = inputs;
  const reported = inputs.pairs.filter((pair) => pair.support >= settings.minPairSupport);
  const lines = ['## Card pairs *(association)*', ''];

  if (reported.length === 0) {
    lines.push(
      `No card pair reached the minimum support of ${settings.minPairSupport} co-occurrences. ` +
        'Pairs below that are not reported at all, because at this sample size they are noise.',
    );
    return lines;
  }

  lines.push(
    '**Estimand:** `(win rate with both − win rate with A only) − (win rate with B only − win ' +
      'rate with neither)`. In words: what the second card adds *on top of* the first, minus what ' +
      'it adds on its own. Two independently strong cards produce an interaction near zero however ' +
      'high their joint win rate is — which is the point.',
  );
  lines.push('');
  lines.push(
    'Intervals come from a stratified bootstrap over seat-matches, so all four cells contribute ' +
      'their sampling error. A pair with any cell below ' +
      `${settings.minPairCellSupport} seat-matches returns *insufficient evidence* rather than a ` +
      'number, because a difference-in-differences over an empty group is undefined, not imprecise.',
  );
  lines.push('');
  lines.push(
    '| A | B | Both | A only | B only | Neither | Interaction | Interval | Over best single | Effect |',
  );
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const pair of reported.slice(0, TABLE_LIMIT)) {
    const estimate = pair.insufficientEvidence
      ? `insufficient evidence (${pair.sparseCells.join(', ')})`
      : pts(pair.interaction);
    lines.push(
      `| \`${pair.cardA}\` | \`${pair.cardB}\` | ${pair.support} | ${pair.supportAOnly} | ` +
        `${pair.supportBOnly} | ${pair.supportNeither} | ${estimate} | ` +
        `${pair.insufficientEvidence ? '—' : interval(pair.low, pair.high, pts)} | ` +
        `${pts(pair.liftOverBestSingle)} | ${pair.effectSizeLabel} |`,
    );
  }
  lines.push('');
  lines.push(
    'These are observational associations over decks a search chose, never assignment ' +
      'experiments. The controlled replacement section is the tool for the causal question.',
  );
  return lines;
}

/* ------------------------------------------------------------- replacement */

function replacementSection(inputs: ReportInputs): string[] {
  if (inputs.replacements.length === 0) return [];
  const lines = ['## Controlled replacement and insertion *(controlled comparison)*', ''];
  lines.push(
    'One card changed, everything else held fixed: the same base deck, the same opponents, the ' +
      'same shuffles and the same pilot streams. Analysed as **paired** outcomes, because the two ' +
      'arms share their seeds by construction and treating them as independent samples would ' +
      'discard the design. A positive impact always means the deck did worse *without* the ' +
      'subject card, in both directions.',
  );
  lines.push('');
  lines.push(
    '`removal` takes the card out of a deck that ran it. `insertion` puts it into a deck that did ' +
      'not, cutting comparable cards to hold the deck size — the only controlled experiment ' +
      'available for a new card or a build-around no deck runs yet. An insertion into a deck with ' +
      'no support for the card is a **stress test**, and a poor result there is evidence about ' +
      'that pairing, not about the card.',
  );
  lines.push('');
  lines.push(
    '| Card | Direction | Swapped for / paid by | Base | Variant | Impact | Interval | Pairs | Discordant | Excluded | Confounds |',
  );
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const impact of inputs.replacements) {
    const paired = impact.paired as
      | {
          candidateOnlyWins: number;
          baselineOnlyWins: number;
          excludedPairs: number;
        }
      | undefined;
    const estimate = impact.insufficientData ? 'insufficient evidence' : pts(impact.impact);
    const paidBy =
      impact.direction === 'insertion'
        ? impact.removedCards.map((entry) => `${entry.quantity}× \`${entry.cardId}\``).join(', ') ||
          '—'
        : `\`${impact.replacementCardId ?? '—'}\``;
    lines.push(
      `| \`${impact.subjectCardId}\` | ${impact.direction} | ${paidBy} | ` +
        `${pct(impact.baseWinRate)} | ${pct(impact.variantWinRate)} | ${estimate} | ` +
        `${interval(impact.low, impact.high, pts)} | ${impact.pairedGames} | ` +
        `${orDash(
          paired ? `${paired.candidateOnlyWins}/${paired.baselineOnlyWins}` : null,
        )} | ${orDash(paired?.excludedPairs ?? null)} | ${impact.confounds.length} |`,
    );
  }

  const confounded = inputs.replacements.filter((entry) => entry.confounds.length > 0);
  if (confounded.length > 0) {
    lines.push('');
    for (const impact of confounded) {
      const label =
        impact.direction === 'insertion'
          ? `inserting \`${impact.subjectCardId}\``
          : `\`${impact.subjectCardId}\` → \`${impact.replacementCardId ?? 'nothing'}\``;
      lines.push(`- ${label} is **not a clean comparison**: ${impact.confounds.join('; ')}.`);
    }
  }

  lines.push('');
  lines.push(
    '*Discordant* is the candidate-only-wins / base-only-wins split. It is the whole sample the ' +
      'difference is estimated from: two hundred pairs with two discordant ones carry about as ' +
      'much information as two coin flips.',
  );
  return lines;
}

/* ------------------------------------------------------- counter breadth */

function counterSection(inputs: ReportInputs): string[] {
  const counters = inputs.counters;
  if (!counters) return [];

  const lines = ['## Counter breadth *(controlled comparison)*', ''];
  lines.push(`Target: ${counters.targetLabel} (${counters.targetDeckHashes.length} deck(s)).`);
  lines.push('');
  lines.push(
    `**Cluster matchup breadth:** ${counters.clusterMatchupBreadth} strategic cluster(s) beat the ` +
      'target in this run' +
      (counters.clustersBeatingTarget.length > 0
        ? ` (\`${counters.clustersBeatingTarget.join('`, `')}\`)`
        : '') +
      '. That is a statement about strategies, and deliberately not a claim that a *card* answers ' +
      'the target.',
  );
  lines.push('');

  if (counters.status === 'unavailable') {
    lines.push(`**Card-level counter breadth: unavailable.** ${counters.note}`);
    return lines;
  }

  lines.push(
    `**Card-level counter breadth: ${counters.counterBreadth}** practical answer(s), of which ` +
      `${counters.broadAnswers} held up against the rest of the field and ` +
      `${counters.narrowAnswers} did not. ${counters.note}`,
  );
  lines.push('');
  lines.push('| Card | Replaces | vs target | vs rest of field | Practical | Breadth |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const candidate of counters.candidates.slice(0, TABLE_LIMIT)) {
    lines.push(
      `| \`${candidate.cardId}\` | \`${candidate.replacedCardId}\` | ${pts(candidate.targetDelta)} | ` +
        `${pts(candidate.fieldDelta)} | ${candidate.practical ? 'yes' : 'no'} | ` +
        `${candidate.breadthLabel} |`,
    );
  }
  return lines;
}

/* ------------------------------------------- opponent-field sensitivity */

function sensitivitySection(inputs: ReportInputs): string[] {
  const sensitive = inputs.sensitivity.filter((entry) => entry.status === 'sensitive');
  const measured = inputs.sensitivity.filter((entry) => entry.status !== 'insufficient_evidence');
  if (inputs.sensitivity.length === 0) return [];

  const lines = ['## Opponent-field sensitivity *(observation)*', ''];
  lines.push(
    "How much a card's results depend on which strategic cluster it faced. This is **context " +
      'sensitivity, not a defect** — soft counter relationships are the shape a healthy plural ' +
      'meta takes, and a card with no unfavourable field is the more worrying finding. A field is ' +
      `only used when it reached ${inputs.settings.minMatchesPerOpponentField} seat-matches, and ` +
      'a spread is only called sensitive when the best and worst intervals do not overlap.',
  );
  lines.push('');
  lines.push(
    `${measured.length} subject(s) had at least ${inputs.settings.minOpponentFields} supported ` +
      `field(s); ${sensitive.length} of those showed a spread of at least ` +
      `${pts(inputs.settings.opponentFieldSpread)} with separated intervals.`,
  );

  if (sensitive.length === 0) return lines;

  lines.push('');
  lines.push(
    '| Subject | Best field | Worst field | Spread | Fields used | Fields dropped | Seat-matches |',
  );
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const entry of sensitive.slice(0, TABLE_LIMIT)) {
    lines.push(
      `| \`${entry.subject}\` | ${orDash(entry.best?.opponentClusterId)} ` +
        `${entry.best ? pct(entry.best.winRate) : ''} | ` +
        `${orDash(entry.worst?.opponentClusterId)} ${entry.worst ? pct(entry.worst.winRate) : ''} | ` +
        `${pts(entry.spread)} | ${entry.fields.length} | ${entry.droppedFields.length} | ` +
        `${entry.totalMatches} |`,
    );
  }
  return lines;
}

/* ------------------------------------------------------------ displacement */

function displacementSection(inputs: ReportInputs): string[] {
  if (inputs.displacement.length === 0) return [];

  const displaced = inputs.displacement.filter((entry) => entry.status === 'displaced');
  const poolRemovals = inputs.displacement.filter((entry) => entry.status === 'pool_removal');
  const unclear = inputs.displacement.filter(
    (entry) => entry.status === 'insufficient_evidence' && entry.shareDelta < 0,
  );

  const lines = ['## Displacement *(review signal)*', ''];
  lines.push(
    'Whether the change pushed comparable old cards out of the decks a search converged on. ' +
      'Measured as **normalized inclusion shares across independent search replicates**, not as ' +
      'raw archive counts: a single evolutionary run is one sample of a stochastic process, and ' +
      '"6 copies became 3" is well inside its own run-to-run variance. A drop is only reported ' +
      `when it clears ${pct(inputs.settings.displacementShareDrop)} relative, spans at least ` +
      `${inputs.settings.minDisplacementReplicates} replicate(s) of ` +
      `${inputs.settings.minDecksPerReplicate}+ decks, and is larger than the between-replicate ` +
      'variation of the same environment.',
  );

  if (displaced.length > 0) {
    lines.push('');
    lines.push(
      '| Card | Baseline share | Candidate share | Relative drop | Between-replicate variation | Replicates | Likely replaced by |',
    );
    lines.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const entry of displaced.slice(0, TABLE_LIMIT)) {
      lines.push(
        `| \`${entry.definitionId}\` | ${pct(entry.baselineMeanShare)} | ` +
          `${pct(entry.candidateMeanShare)} | ${pct(entry.relativeDrop)} | ` +
          `${pts(entry.betweenReplicateVariation)} | ${entry.replicates} | ` +
          `${orDash(entry.likelyReplacedBy.map((item) => item.definitionId).join(', '))} |`,
      );
    }
  } else {
    lines.push('');
    lines.push('No card met the displacement criteria.');
  }

  if (poolRemovals.length > 0) {
    lines.push('');
    lines.push(
      `${poolRemovals.length} card(s) disappeared because the candidate pool no longer contains ` +
        'them. That is a card-pool change, not evolutionary selection, and is reported separately: ' +
        `\`${poolRemovals.map((entry) => entry.definitionId).join('`, `')}\``,
    );
  }

  if (unclear.length > 0) {
    lines.push('');
    lines.push(
      `${unclear.length} card(s) fell but not by enough to separate from search variance, and are ` +
        `recorded as *insufficient evidence*: \`${unclear
          .slice(0, TABLE_LIMIT)
          .map((entry) => entry.definitionId)
          .join('`, `')}\``,
    );
  }

  return lines;
}

/* -------------------------------------------------------- pilot robustness */

function robustnessSection(inputs: ReportInputs): string[] {
  const robustness = inputs.robustness;
  if (!robustness) return [];

  const lines = ['## Pilot robustness *(controlled comparison)*', ''];
  lines.push(
    `Perturbation profile set \`${robustness.profileVersion}\`. Each profile plays the **same** ` +
      'schedule on the **same** derived seeds, and each is analysed on its own records. The arms ' +
      'are never pooled: a merged population would average away exactly the disagreement this ' +
      'experiment exists to expose.',
  );
  lines.push('');
  lines.push('| Profile | Matches | Usable | Review flags | Seat spread |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const arm of robustness.arms) {
    lines.push(
      `| \`${arm.profileId}\` | ${arm.matches} | ${arm.usableMatches} | ` +
        `${arm.reviewSubjects.length} | ${pts(arm.seatSpread)} |`,
    );
  }

  if (robustness.conclusions.length > 0) {
    lines.push('');
    lines.push('| Conclusion | Kind | Status | Agreement | Disagreeing profiles |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const conclusion of robustness.conclusions) {
      lines.push(
        `| \`${conclusion.subject}\` | ${conclusion.kind} | ${conclusion.status} | ` +
          `${pct(conclusion.agreement)} | ` +
          `${orDash(conclusion.disagreeingProfiles.join(', '))} |`,
      );
    }
    lines.push('');
    lines.push(
      `A conclusion is called *stable* when it survives in at least ${pct(robustness.threshold)} ` +
        'of the perturbed profiles. A *pilot_sensitive* conclusion is not wrong — it is ' +
        'conditional, and holds for the pilot that produced it.',
    );
  }

  return lines;
}

/* -------------------------------------------------------------- comparison */

function comparisonSection(inputs: ReportInputs): string[] {
  const comparison = inputs.comparison;
  if (!comparison) return [];

  const lines = ['## Baseline versus candidate', ''];
  lines.push(
    '**Reference impact** and **discovery impact** answer different questions and are kept apart. ' +
      'Reference impact is what the change did to decks that already existed; discovery impact is ' +
      'what the change made newly possible. A reference population cannot contain a card the ' +
      'candidate added, and a freshly searched candidate population measured against a stale ' +
      'baseline biases the other way — so both are run.',
  );
  lines.push('');
  lines.push(
    `Reference population \`${comparison.referencePopulationHash}\`, identical in both arms. ` +
      `${comparison.pairedGames} paired game(s) (${pct(comparison.pairedCoverage)} of the baseline ` +
      'run) shared their seeds with the candidate run.',
  );

  /* --------------------------------------------------------- reference impact */

  lines.push('');
  lines.push('### Reference impact — existing decks, unchanged *(controlled comparison)*');
  lines.push('');

  const moved = comparison.referenceDeckDeltas.filter(
    (delta) => !delta.insufficientEvidence && Math.abs(delta.delta) > 0.02,
  );
  const unclear = comparison.referenceDeckDeltas.filter((delta) => delta.insufficientEvidence);

  if (comparison.referenceDeckDeltas.length === 0) {
    lines.push('No reference deck was played in both arms, so there is no paired estimate.');
  } else if (moved.length === 0) {
    lines.push(
      'No reference deck moved by more than two win-rate points with adequate paired evidence.',
    );
  } else {
    lines.push('| Deck | Baseline | Candidate | Paired delta | Interval | Pairs | Discordant |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const delta of moved.slice(0, TABLE_LIMIT)) {
      const paired = delta.paired as
        { candidateOnlyWins: number; baselineOnlyWins: number } | undefined;
      lines.push(
        `| \`${delta.deckId}\` | ${pct(delta.baselineWinRate)} | ${pct(delta.candidateWinRate)} | ` +
          `${pts(delta.delta)} | ${interval(delta.low, delta.high, pts)} | ${delta.pairedGames} | ` +
          `${orDash(paired ? `${paired.candidateOnlyWins}/${paired.baselineOnlyWins}` : null)} |`,
      );
    }
  }

  if (unclear.length > 0) {
    lines.push('');
    lines.push(
      `${unclear.length} reference deck(s) produced too few complete pairs for an estimate and are ` +
        'marked *insufficient evidence* in `summary.json`. They are excluded here rather than ' +
        'shown with a number that would be read as a result.',
    );
  }

  const length = comparison.matchLengthDelta as
    | {
        pairs: number;
        baselineMean: number;
        candidateMean: number;
        meanDifference: number;
        low: number;
        high: number;
        insufficientEvidence: boolean;
      }
    | undefined;
  if (length && length.pairs > 0) {
    lines.push('');
    lines.push(
      `**Match length.** Paired difference over ${length.pairs} game(s): ` +
        `${length.baselineMean} → ${length.candidateMean} turns, ` +
        `${length.meanDifference >= 0 ? '+' : ''}${length.meanDifference} ` +
        `(${round(length.low, 3)} … ${round(length.high, 3)})` +
        (length.insufficientEvidence ? ', below the configured minimum pairs.' : '.'),
    );
  }

  /* --------------------------------------------------------- discovery impact */

  lines.push('');
  lines.push('### Discovery impact — independently searched decks *(observation)*');
  lines.push('');
  lines.push(
    `Independent search found ${comparison.strategiesGained.length} deck(s) only in the candidate ` +
      `environment and ${comparison.strategiesLost.length} only in the baseline. These are ` +
      'separate populations from the reference decks above and are never mixed into the reference ' +
      'estimate.',
  );

  if (comparison.newlyViableCards.length > 0) {
    lines.push('');
    lines.push(
      '**Newly viable cards** (appear in searched decks only after the change): ' +
        `\`${comparison.newlyViableCards.join('`, `')}\``,
    );
  }

  const displacement = comparison.displacement as readonly Displacement[];
  const confirmed = displacement.filter((entry) => entry.status === 'displaced');
  lines.push('');
  lines.push(
    confirmed.length === 0
      ? 'No card showed replicated, normalized evidence of displacement. See the displacement ' +
          'section for what was measured and why anything that fell short was downgraded.'
      : `${confirmed.length} card(s) showed replicated displacement evidence; they are listed in ` +
          'the displacement section with their between-replicate variation.',
  );

  return lines;
}

/* ------------------------------------------------------------ deck search */

function searchSection(inputs: ReportInputs): string[] {
  const history = inputs.searchHistory ?? [];
  if (history.length === 0) return [];

  const lines = ['## Deck search *(observation)*', ''];
  lines.push(
    '| Gen | Decks | Matches | Best score | Best win rate | Card entropy | Commanders | Mean distance |',
  );
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const generation of history) {
    lines.push(
      `| ${generation.generation} | ${generation.evaluated} | ${generation.matches} | ` +
        `${orDash(generation.best?.score)} | ` +
        `${generation.best ? pct(generation.best.winRate) : '—'} | ` +
        `${generation.cardEntropy} | ${generation.commanderCount} | ` +
        `${generation.meanPairwiseDistance} |`,
    );
  }

  const notes = history.flatMap((generation) =>
    generation.notes.map((note) => `- generation ${generation.generation}: ${note}`),
  );
  if (notes.length > 0) {
    lines.push('');
    lines.push('Diversity and quality notes, reported rather than corrected:');
    lines.push('');
    lines.push(...notes);
  }

  lines.push('');
  lines.push(
    'A discovered deck is a lead to investigate, never a conclusion: it describes what these ' +
      'pilots could exploit, not what a human could.',
  );
  return lines;
}

/* --------------------------------------------------------------- abnormal */

function abnormalSection(inputs: ReportInputs): string[] {
  if (inputs.abnormalMatches.length === 0) return [];

  const lines = ['## Abnormal matches *(observation)*', ''];
  lines.push(
    `${inputs.abnormalMatches.length} match(es) did not end in a normal victory or draw. They are ` +
      'excluded from every statistic above and never averaged in as though a turn-limit stall ' +
      'were a long game. Each one has a replay bundle:',
  );
  lines.push('');
  lines.push('| Match | Termination | Replay |');
  lines.push('| --- | --- | --- |');
  for (const entry of inputs.abnormalMatches.slice(0, ABNORMAL_LIMIT)) {
    lines.push(
      `| \`${entry.matchId}\` | ${entry.termination} | ${
        entry.replayPath ? `\`${entry.replayPath}\`` : 'not retained'
      } |`,
    );
  }
  if (inputs.abnormalMatches.length > ABNORMAL_LIMIT) {
    lines.push('');
    lines.push(
      `${inputs.abnormalMatches.length - ABNORMAL_LIMIT} further abnormal match(es) are listed in ` +
        '`errors.csv` and `manifest.json`.',
    );
  }
  lines.push('');
  lines.push(
    'A replay bundle carries the full action log, event log and the seed lineage the match was ' +
      'derived from, so it reproduces exactly on its own. To re-run the whole experiment and ' +
      'regenerate them:',
  );
  lines.push('');
  lines.push('```bash');
  lines.push('npm run simulate -- --config config.json');
  lines.push('```');
  lines.push('');
  lines.push(
    `The abnormal matches are stable across runs: the same configuration hash \`${inputs.configHash}\` ` +
      'always produces the same match IDs, so the identifiers above are citable.',
  );
  return lines;
}

/* ------------------------------------------------------------- provenance */

function reproducing(inputs: ReportInputs): string[] {
  return [
    '## Reproducing this',
    '',
    '```bash',
    'npm run simulate -- --config config.json',
    '```',
    '',
    `Raw records are in \`${inputs.matchesPath}\`, one runtime-validated line per match; every ` +
      'number above is recomputable from them. `manifest.json` records the configuration hash, ' +
      'the seeds, the schema versions and the software commit this run used, and `summary.json` ' +
      'holds the machine-readable form of everything in this document. The JSON is authoritative: ' +
      'this file and the CSVs are views of it.',
    '',
    `Running the same configuration again — at any worker count — reproduces the same records and ` +
      `the same summary. A resumed run continues from \`${inputs.matchesPath}\` and refuses to ` +
      'merge records written under a different configuration hash.',
  ];
}
