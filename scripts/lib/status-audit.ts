/**
 * The status audit — the data behind `docs/status-audit.md` (M07.1).
 *
 * M07 exists because the documents drifted away from the software. The defence
 * against that happening again is not a better-written document: it is a
 * document nobody writes by hand. Everything in the "derived facts" half below
 * is read out of the code and content it describes — the version constants the
 * software actually stamps on its artifacts, the bundled sets, formats, precons
 * and plans, the support registry, the behaviour contracts, the calibration
 * suite — and `status-audit.test.ts` fails when the committed document and this
 * collector disagree. A stale number is therefore a failing test rather than a
 * sentence somebody has to notice.
 *
 * The other half, the **run record**, is a measurement rather than a derivation:
 * the commit it was taken at, whether the tree was clean, the verification chain
 * and its outcome, and the test totals from a real `vitest list`. It is written
 * once per audit and deliberately *not* re-checked, because reproducing it means
 * running the suite. The two halves are separated by markers so the drift test
 * can tell them apart, and the document says which is which.
 *
 * Nothing here judges anything. "Known limitations" is a list of facts the
 * registries already assert — a keyword the engine does not execute, a mechanic
 * no pilot values, a precon with one spare card in its colour-legal pool — and
 * the audit's contribution is that they are counted from source in one place
 * rather than remembered in five documents.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  ARCHETYPE_REGISTRY_VERSION,
  BUNDLED_DECK_PLANS,
  BUNDLED_FORMATS,
  BUNDLED_PRECONS,
  CARD_SCHEMA_VERSION,
  CONTENT_BUNDLE_SCHEMA_VERSION,
  DECKABLE_CARD_TYPES,
  DECK_PLAN_SCHEMA_VERSION,
  FORMAT_SCHEMA_VERSION,
  GENERATED_BUNDLE_PATH,
  KEYWORD_REGISTRY_SCHEMA_VERSION,
  MAX_PLAN_SHARE,
  MECHANIC_SUPPORT_LIST,
  PRECON_SCHEMA_VERSION,
  STRICT_SET_STATUSES,
  SUPPORT_REGISTRY_VERSION,
  UNIMPLEMENTED_KEYWORDS,
  describeCardSupport,
  formatCardPool,
  formatDatabase,
  isColorIdentityLegal,
  loadBundledCardData,
  mechanicKey,
  planSlotCount,
  type CardDefinition,
  type ColorId,
  type MechanicRef,
  type SupportDimension,
} from '@tcg/card-data';
import {
  AGENT_CLASSES_WITHOUT_PILOTS,
  AGENT_CLASS_REGISTRY_VERSION,
  AGGRESSIVE_VERSION,
  DEFENSIVE_VERSION,
  PERTURBATION_PROFILE_VERSION,
  PILOT_AGENT_CLASSES,
  PILOT_IDS,
  RANDOM_LEGAL_VERSION,
  TACTICAL_PROFILE_IDS,
  TACTICS_REGISTRY_VERSION,
  VALUE_VERSION,
  type PilotId,
} from '@tcg/bot-interface';
import { CALIBRATION_FIXTURES, CALIBRATION_SUITE_VERSION } from '@tcg/bot-interface/calibration';
import {
  AVAILABLE_DIFFICULTIES,
  BOT_CONFIG_SCHEMA_VERSION,
  BOT_SUMMARY_SCHEMA_VERSION,
  DIFFICULTY_REGISTRY_VERSION,
  PACING_CONFIG_VERSION,
} from '@tcg/bot-config';
import { BOARD_TELEMETRY_VERSION, STALL_DEFINITION_VERSION } from '@tcg/board-telemetry';
import { DECK_GENERATOR_VERSION, SUPPORTED_RUNTIMES } from '@tcg/deck-generator';
import {
  DECK_FINGERPRINT_VERSION,
  DECK_SCHEMA_VERSION,
  deckFormatOf,
  reviewPrecon,
} from '@tcg/deck';
import { GLOSSARY_ENTRIES, GLOSSARY_SCHEMA_VERSION } from '@tcg/help-content';
import { RULEBOOK_SCHEMA_VERSION, RULEBOOK_SECTION_IDS } from '@tcg/help-content';
import { PROTOCOL_VERSION } from '@tcg/protocol';
import { MATCH_SCHEMA_VERSION, RULES_VERSION } from '@tcg/rules-engine';
import { CARD_CONTRACTS, CONTRACT_SET_ID } from '@tcg/rules-engine/card-contracts';
import { SPECTATOR_REPLAY_VERSION } from '@tcg/spectator';
import {
  CONFIG_SCHEMA_VERSION,
  HASH_VERSION,
  MANIFEST_SCHEMA_VERSION,
  MATCHUP_MATRIX_SCHEMA_VERSION,
  MATCH_STREAM_HEADER_VERSION,
  REFERENCE_POPULATION_VERSION,
  REPORT_SCHEMA_VERSION,
  RESOLVED_ENVIRONMENT_SCHEMA_VERSION,
  SEARCH_CHECKPOINT_VERSION,
  SEED_DERIVATION_VERSION,
  SUMMARY_SCHEMA_VERSION,
  TELEMETRY_SCHEMA_VERSION,
} from '@tcg/simulator';

/* ------------------------------------------------------------------ markers */

/** The generated document's own banner, so a hand-edited copy is obvious. */
export const AUDIT_BANNER =
  'GENERATED FILE — do not edit. Rebuild with `npm run audit:status`. ' +
  'Every number below the derived-facts marker is read out of the code and ' +
  'content it describes, and `scripts/lib/status-audit.test.ts` fails when this ' +
  'file and the collector disagree.';

export const DERIVED_START = '<!-- audit:derived:start -->';
export const DERIVED_END = '<!-- audit:derived:end -->';

/**
 * The derived half of a written audit, or `null` when the markers are missing.
 *
 * The run record above the marker is a measurement and moves every time the
 * audit is taken; comparing it would make the drift test fail for the one reason
 * that is not drift.
 */
export function derivedSectionOf(markdown: string): string | null {
  const start = markdown.indexOf(DERIVED_START);
  const end = markdown.indexOf(DERIVED_END);
  if (start === -1 || end === -1 || end < start) return null;
  return markdown.slice(start + DERIVED_START.length, end).trim();
}

/* ------------------------------------------------------------- run measuring */

export const VERIFY_OUTCOMES = ['passed', 'failed', 'not_run'] as const;
export type VerifyOutcome = (typeof VERIFY_OUTCOMES)[number];

export interface ProjectTests {
  readonly project: string;
  readonly files: number;
  readonly tests: number;
}

export interface TestTotals {
  readonly projects: readonly ProjectTests[];
  readonly files: number;
  readonly tests: number;
}

/**
 * Test totals from `vitest list`, which enumerates every case without running
 * one.
 *
 * Counting `it(` in the sources would be a guess: several suites build their
 * cases from a vocabulary with a loop, and a guess is exactly what this document
 * exists to remove. Lines the runner prints around the list — npm noise, an
 * empty line — do not match and are ignored rather than counted as tests.
 */
export function parseVitestList(output: string): TestTotals {
  const byProject = new Map<string, { files: Set<string>; tests: number }>();

  for (const raw of output.split(/\r?\n/)) {
    const match = /^\[([^\]]+)\]\s+(\S.*?)\s+>\s+\S/.exec(raw.trim());
    if (!match) continue;
    const [, project = '', file = ''] = match;
    const entry = byProject.get(project) ?? { files: new Set<string>(), tests: 0 };
    entry.files.add(file);
    entry.tests += 1;
    byProject.set(project, entry);
  }

  const projects = [...byProject.entries()]
    .map(([project, entry]) => ({ project, files: entry.files.size, tests: entry.tests }))
    .sort((left, right) => left.project.localeCompare(right.project));

  return {
    projects,
    files: projects.reduce((sum, entry) => sum + entry.files, 0),
    tests: projects.reduce((sum, entry) => sum + entry.tests, 0),
  };
}

/**
 * The steps `npm run verify` runs, in order, read off the script itself.
 *
 * The chain is the project's single gate (CLAUDE.md), and a document that listed
 * its steps by hand would be the first thing to go stale when one is added.
 */
export function verifySteps(packageJsonText: string): readonly string[] {
  const parsed: unknown = JSON.parse(packageJsonText);
  const scripts =
    typeof parsed === 'object' && parsed !== null && 'scripts' in parsed
      ? (parsed as { scripts?: Record<string, unknown> }).scripts
      : undefined;
  const verify = scripts?.['verify'];
  if (typeof verify !== 'string') return [];
  return verify
    .split('&&')
    .map((step) => step.trim())
    .filter((step) => step.length > 0);
}

export interface AuditRun {
  /** Full commit the audit was taken at. */
  readonly commit: string;
  /** Whether `git status --porcelain` was empty when it was taken. */
  readonly treeClean: boolean;
  /** ISO date. The audit is a dated reading, not a running total. */
  readonly takenOn: string;
  readonly nodeVersion: string;
  readonly verify: VerifyOutcome;
  readonly verifySteps: readonly string[];
  readonly tests: TestTotals;
}

/* --------------------------------------------------------------- derivation */

export interface VersionEntry {
  readonly constant: string;
  readonly value: string;
  readonly pins: string;
}

export interface VersionGroup {
  readonly title: string;
  readonly note: string;
  readonly entries: readonly VersionEntry[];
}

export interface SetFacts {
  readonly setId: string;
  readonly name: string;
  readonly status: string;
  readonly schemaVersion: number;
  readonly playable: number;
  readonly tokens: number;
  readonly unimplemented: number;
  readonly pilotBlind: number;
  readonly telemetryBlind: number;
}

export interface FormatFacts {
  readonly formatId: string;
  readonly name: string;
  readonly setIds: readonly string[];
  readonly deckSize: number;
  readonly singleton: boolean;
  readonly maxCommanderColors: number;
  readonly commanderOutsideDeck: boolean;
  readonly banned: number;
  readonly poolSize: number;
}

export interface PreconFacts {
  readonly preconId: string;
  readonly name: string;
  readonly formatId: string;
  readonly commanderId: string;
  readonly commanderColors: readonly ColorId[];
  readonly cards: number;
  readonly legal: boolean;
  readonly issues: readonly string[];
  readonly planId: string | null;
  /** Cards in the format pool this Commander's colour identity allows. */
  readonly colorLegalPool: number;
  /** Colour-legal pool minus the deck size: the room a mutation has to work in. */
  readonly spareSlots: number;
}

export interface DeckPlanFacts {
  readonly planId: string;
  /** `null` for a plan that describes an archetype rather than a shipped deck. */
  readonly preconId: string | null;
  readonly archetypeId: string;
  readonly packages: number;
  readonly corePackages: number;
  readonly slots: number;
  readonly shareOfDeck: number;
}

export interface CoverageFacts {
  readonly contractSetId: string;
  readonly contracts: number;
  readonly contractSetCards: number;
  readonly calibrationFixtures: number;
  readonly fixturesWithKnownGaps: number;
  readonly gapsByPilot: readonly { readonly pilotId: string; readonly gaps: number }[];
  readonly glossaryEntries: number;
  readonly rulebookSections: number;
}

export interface SupportFacts {
  readonly mechanics: number;
  readonly byDimension: readonly {
    readonly dimension: SupportDimension;
    readonly counts: readonly { readonly level: string; readonly count: number }[];
  }[];
  readonly engineInert: readonly string[];
  readonly pilotBlindMechanics: readonly string[];
  readonly telemetryBlindMechanics: readonly string[];
}

export interface QuestionRow {
  readonly id: string;
  readonly number: number;
  readonly title: string;
  /** `open`, `answered`, or `absent` when the question file has no entry. */
  readonly inQuestions: 'open' | 'answered' | 'absent';
  readonly inPlan: boolean;
}

export interface QuestionLedger {
  readonly rows: readonly QuestionRow[];
  /**
   * A question the plan calls open that the question file does not.
   *
   * Only this direction is a contradiction. The plan's list is the short set of
   * decisions a tranche might have to stop on, deliberately curated rather than
   * exhaustive, so a question open in the file and absent from the plan is
   * ordinary — it is counted below rather than reported as a problem.
   */
  readonly contradictions: readonly string[];
  /** Questions open in the question file and not on the plan's short list. */
  readonly openNotListed: number;
}

export interface RepoFacts {
  readonly rootFiles: readonly string[];
  readonly unexpectedRootFiles: readonly string[];
  readonly workspaces: readonly string[];
  readonly adrs: readonly { readonly file: string; readonly title: string }[];
  readonly milestones: readonly string[];
}

export interface AuditFacts {
  readonly versions: readonly VersionGroup[];
  readonly sets: readonly SetFacts[];
  readonly formats: readonly FormatFacts[];
  readonly precons: readonly PreconFacts[];
  readonly deckPlans: readonly DeckPlanFacts[];
  readonly coverage: CoverageFacts;
  readonly support: SupportFacts;
  readonly limitations: readonly string[];
  readonly questions: QuestionLedger;
  readonly repo: RepoFacts;
}

/** The three documents M07.5 allows at the repository root. */
export const PERMITTED_ROOT_DOCS: readonly string[] = [
  'README.md',
  'CLAUDE.md',
  'IMPLEMENTATION_PLAN.md',
];

function versionGroups(): readonly VersionGroup[] {
  return [
    {
      title: 'Play contract',
      note: 'What a client, a server and a saved deck must agree on to play at all.',
      entries: [
        { constant: 'RULES_VERSION', value: RULES_VERSION, pins: 'The rules configuration.' },
        {
          constant: 'PROTOCOL_VERSION',
          value: String(PROTOCOL_VERSION),
          pins: 'Every message shape, refused at the handshake.',
        },
        {
          constant: 'MATCH_SCHEMA_VERSION',
          value: String(MATCH_SCHEMA_VERSION),
          pins: 'Serialized match state.',
        },
        {
          constant: 'CARD_SCHEMA_VERSION',
          value: String(CARD_SCHEMA_VERSION),
          pins: 'A card definition, owned per set by its manifest.',
        },
        {
          constant: 'DECK_SCHEMA_VERSION',
          value: String(DECK_SCHEMA_VERSION),
          pins: 'A saved deck.',
        },
        {
          constant: 'FORMAT_SCHEMA_VERSION',
          value: String(FORMAT_SCHEMA_VERSION),
          pins: 'A play format and its construction rules.',
        },
        {
          constant: 'PRECON_SCHEMA_VERSION',
          value: String(PRECON_SCHEMA_VERSION),
          pins: 'A bundled precon definition.',
        },
        {
          constant: 'DECK_PLAN_SCHEMA_VERSION',
          value: String(DECK_PLAN_SCHEMA_VERSION),
          pins: "A deck's authored package structure.",
        },
        {
          constant: 'CONTENT_BUNDLE_SCHEMA_VERSION',
          value: String(CONTENT_BUNDLE_SCHEMA_VERSION),
          pins: `The generated bundle envelope (\`${GENERATED_BUNDLE_PATH}\`).`,
        },
        {
          constant: 'GLOSSARY_SCHEMA_VERSION',
          value: String(GLOSSARY_SCHEMA_VERSION),
          pins: 'The player-facing glossary.',
        },
        {
          constant: 'RULEBOOK_SCHEMA_VERSION',
          value: String(RULEBOOK_SCHEMA_VERSION),
          pins: 'The in-app rulebook.',
        },
      ],
    },
    {
      title: 'Recorded artifacts',
      note: 'Documents a finished run leaves behind. Every move so far has been a refusal rather than a migration.',
      entries: [
        {
          constant: 'SPECTATOR_REPLAY_VERSION',
          value: String(SPECTATOR_REPLAY_VERSION),
          pins: 'A spectator replay log.',
        },
        {
          constant: 'BOARD_TELEMETRY_VERSION',
          value: String(BOARD_TELEMETRY_VERSION),
          pins: 'The shared board-size and attack-opportunity schema.',
        },
        {
          constant: 'TELEMETRY_SCHEMA_VERSION',
          value: String(TELEMETRY_SCHEMA_VERSION),
          pins: 'A simulator match record.',
        },
        {
          constant: 'MATCH_STREAM_HEADER_VERSION',
          value: String(MATCH_STREAM_HEADER_VERSION),
          pins: '`matches.header.json`, which decides whether a run may resume.',
        },
        {
          constant: 'REPORT_SCHEMA_VERSION',
          value: String(REPORT_SCHEMA_VERSION),
          pins: '`report.md`.',
        },
        {
          constant: 'MANIFEST_SCHEMA_VERSION',
          value: String(MANIFEST_SCHEMA_VERSION),
          pins: '`manifest.json`.',
        },
        {
          constant: 'SUMMARY_SCHEMA_VERSION',
          value: String(SUMMARY_SCHEMA_VERSION),
          pins: '`summary.json`.',
        },
        {
          constant: 'MATCHUP_MATRIX_SCHEMA_VERSION',
          value: String(MATCHUP_MATRIX_SCHEMA_VERSION),
          pins: '`matchup-matrix.json` and its CSV.',
        },
        {
          constant: 'SEARCH_CHECKPOINT_VERSION',
          value: String(SEARCH_CHECKPOINT_VERSION),
          pins: 'A deck-search checkpoint.',
        },
        {
          constant: 'RESOLVED_ENVIRONMENT_SCHEMA_VERSION',
          value: String(RESOLVED_ENVIRONMENT_SCHEMA_VERSION),
          pins: 'A frozen environment snapshot.',
        },
        {
          constant: 'REFERENCE_POPULATION_VERSION',
          value: String(REFERENCE_POPULATION_VERSION),
          pins: 'A shared reference population.',
        },
        {
          constant: 'CONFIG_SCHEMA_VERSION',
          value: String(CONFIG_SCHEMA_VERSION),
          pins: 'An experiment configuration file.',
        },
        {
          constant: 'SEED_DERIVATION_VERSION',
          value: String(SEED_DERIVATION_VERSION),
          pins: 'How every seed in a run is derived.',
        },
        {
          constant: 'HASH_VERSION',
          value: String(HASH_VERSION),
          pins: 'How a hash over content or configuration is taken.',
        },
      ],
    },
    {
      title: 'Bot seats',
      note: 'What a bot seat is configured by. Independent of the play contract on purpose (ADR 0024 §7): a difficulty can improve, and a pacing dial can move, without a card, a rule or a message shape changing.',
      entries: [
        {
          constant: 'BOT_CONFIG_SCHEMA_VERSION',
          value: String(BOT_CONFIG_SCHEMA_VERSION),
          pins: "One bot seat's configuration — controller, difficulty, style, deck source and pacing.",
        },
        {
          constant: 'DIFFICULTY_REGISTRY_VERSION',
          value: String(DIFFICULTY_REGISTRY_VERSION),
          pins: `Which difficulty IDs exist and what each claims. Available today: ${AVAILABLE_DIFFICULTIES.join(', ')}.`,
        },
        {
          constant: 'PACING_CONFIG_VERSION',
          value: String(PACING_CONFIG_VERSION),
          pins: 'The bot pacing budget shape and the percentage-to-delay calculation. Not a rules version.',
        },
        {
          constant: 'BOT_SUMMARY_SCHEMA_VERSION',
          value: String(BOT_SUMMARY_SCHEMA_VERSION),
          pins: 'One match’s bot pacing and provenance summary, as broadcast at completion and exported to a file. Separate from `PROTOCOL_VERSION`, which an exported file has no handshake to be refused at.',
        },
        {
          constant: 'DECK_FINGERPRINT_VERSION',
          value: String(DECK_FINGERPRINT_VERSION),
          pins: 'How a saved deck frozen into bot configuration is fingerprinted, so a browser and the server agree. Separate from `HASH_VERSION`, which is the simulator’s content address.',
        },
      ],
    },
    {
      title: 'Registries and instruments',
      note: 'Classifications a citation is made against. A move here re-judges evidence rather than refusing it.',
      entries: [
        {
          constant: 'SUPPORT_REGISTRY_VERSION',
          value: String(SUPPORT_REGISTRY_VERSION),
          pins: 'How well each mechanic is supported, in four dimensions.',
        },
        {
          constant: 'ARCHETYPE_REGISTRY_VERSION',
          value: String(ARCHETYPE_REGISTRY_VERSION),
          pins: 'The archetype vocabulary and the roles each one requires.',
        },
        {
          constant: 'KEYWORD_REGISTRY_SCHEMA_VERSION',
          value: String(KEYWORD_REGISTRY_SCHEMA_VERSION),
          pins: 'The keyword registry entry shape.',
        },
        {
          constant: 'AGENT_CLASS_REGISTRY_VERSION',
          value: String(AGENT_CLASS_REGISTRY_VERSION),
          pins: 'Which agent class may make which evidence claim.',
        },
        {
          constant: 'CALIBRATION_SUITE_VERSION',
          value: String(CALIBRATION_SUITE_VERSION),
          pins: 'The tactical fixtures a calibration standing was measured on.',
        },
        {
          constant: 'TACTICS_REGISTRY_VERSION',
          value: String(TACTICS_REGISTRY_VERSION),
          pins: `Which tactical profiles a pilot can be built with — the scoring half of a difficulty. Today: ${TACTICAL_PROFILE_IDS.join(', ')}. A profile's own behaviour version moves separately.`,
        },
        {
          constant: 'STALL_DEFINITION_VERSION',
          value: String(STALL_DEFINITION_VERSION),
          pins: 'The rule a quiet round is judged a stall by.',
        },
        {
          constant: 'PERTURBATION_PROFILE_VERSION',
          value: String(PERTURBATION_PROFILE_VERSION),
          pins: 'How a pilot is perturbed for a robustness arm.',
        },
        {
          constant: 'DECK_GENERATOR_VERSION',
          value: DECK_GENERATOR_VERSION,
          pins: `The construction procedure a generated deck cites. Runs on ${SUPPORTED_RUNTIMES.join(', ')} only.`,
        },
        ...PILOT_IDS.map((pilotId) => ({
          constant: `pilot ${pilotId}`,
          value: pilotVersion(pilotId),
          pins: `Decision procedure; agent class \`${PILOT_AGENT_CLASSES[pilotId]}\`.`,
        })),
      ],
    },
  ];
}

function pilotVersion(pilotId: PilotId): string {
  switch (pilotId) {
    case 'random_legal':
      return RANDOM_LEGAL_VERSION;
    case 'aggressive':
      return AGGRESSIVE_VERSION;
    case 'defensive':
      return DEFENSIVE_VERSION;
    case 'value':
      return VALUE_VERSION;
  }
}

function setFacts(): readonly SetFacts[] {
  const loaded = loadBundledCardData();
  return loaded.sets.map((set) => {
    const playable = set.cards.filter((card) => card.type !== 'token');
    const support = set.cards.map((card) => describeCardSupport(card));
    return {
      setId: set.setId,
      name: set.name,
      status: set.status,
      schemaVersion: set.schemaVersion,
      playable: playable.length,
      tokens: set.cards.length - playable.length,
      unimplemented: set.cards.filter((card) => !card.implemented).length,
      pilotBlind: support.filter((entry) => entry.pilotBlind).length,
      telemetryBlind: support.filter((entry) => entry.telemetryBlind).length,
    };
  });
}

function formatFacts(): readonly FormatFacts[] {
  return BUNDLED_FORMATS.map((format) => ({
    formatId: format.formatId,
    name: format.name,
    setIds: format.setIds,
    deckSize: format.deck.size,
    singleton: format.deck.singleton,
    maxCommanderColors: format.deck.maxCommanderColors,
    commanderOutsideDeck: format.deck.commanderOutsideDeck,
    banned: format.bannedCardIds.length,
    poolSize: formatCardPool(format.formatId).length,
  }));
}

/**
 * Cards a deck in `formatId` could hold under `commanderColors`.
 *
 * The same three conditions the deck validator applies, and no fourth: a
 * deckable type, collectible, and colour-identity legal. Unimplemented cards
 * stay in, because they are legal content that `validateDeck` refuses for a
 * different reason — filtering them here would understate the pool for the one
 * question this number is asked for, which is how much room a mutation has.
 */
function colorLegalPool(formatId: string, commanderColors: readonly ColorId[]): number {
  return formatCardPool(formatId).filter(
    (card: CardDefinition) =>
      DECKABLE_CARD_TYPES.includes(card.type) &&
      card.collectible &&
      isColorIdentityLegal(card.colorIdentity, commanderColors),
  ).length;
}

function preconFacts(): readonly PreconFacts[] {
  return BUNDLED_PRECONS.map((precon) => {
    const format = BUNDLED_FORMATS.find((entry) => entry.formatId === precon.formatId);
    if (!format) {
      throw new Error(`Precon ${precon.id} names format ${precon.formatId}, which is not bundled.`);
    }

    const database = formatDatabase(precon.formatId);
    const review = reviewPrecon(precon, database, deckFormatOf(format));
    const commander = database.get(precon.commanderId);
    const commanderColors = commander?.colorIdentity ?? [];
    const pool = colorLegalPool(precon.formatId, commanderColors);
    const plan = BUNDLED_DECK_PLANS.find((entry) => entry.preconId === precon.id);

    return {
      preconId: precon.id,
      name: precon.name,
      formatId: precon.formatId,
      commanderId: precon.commanderId,
      commanderColors,
      cards: precon.cardIds.length,
      legal: review.legal,
      issues: review.issues.map((issue) => issue.code),
      planId: plan?.id ?? null,
      colorLegalPool: pool,
      spareSlots: pool - format.deck.size,
    };
  });
}

function deckPlanFacts(): readonly DeckPlanFacts[] {
  return BUNDLED_DECK_PLANS.map((plan) => {
    const format = BUNDLED_FORMATS.find((entry) => entry.formatId === plan.formatId);
    const slots = planSlotCount(plan);
    return {
      planId: plan.id,
      preconId: plan.preconId ?? null,
      archetypeId: plan.archetypeId,
      packages: plan.packages.length,
      corePackages: plan.packages.filter((entry) => entry.core).length,
      slots,
      shareOfDeck: format ? slots / format.deck.size : 0,
    };
  });
}

function coverageFacts(): CoverageFacts {
  const loaded = loadBundledCardData();
  const contractSet = loaded.sets.find((set) => set.setId === CONTRACT_SET_ID);
  const gapsByPilot = PILOT_IDS.map((pilotId) => ({
    pilotId,
    gaps: CALIBRATION_FIXTURES.filter((fixture) => fixture.knownGaps?.[pilotId] !== undefined)
      .length,
  })).filter((entry) => entry.gaps > 0);

  return {
    contractSetId: CONTRACT_SET_ID,
    contracts: Object.keys(CARD_CONTRACTS).length,
    contractSetCards: contractSet?.cards.length ?? 0,
    calibrationFixtures: CALIBRATION_FIXTURES.length,
    fixturesWithKnownGaps: CALIBRATION_FIXTURES.filter(
      (fixture) => Object.keys(fixture.knownGaps ?? {}).length > 0,
    ).length,
    gapsByPilot,
    glossaryEntries: GLOSSARY_ENTRIES.length,
    rulebookSections: RULEBOOK_SECTION_IDS.length,
  };
}

const SUPPORT_LEVELS: Readonly<Record<SupportDimension, readonly string[]>> = {
  engine: ['full', 'none'],
  help: ['full', 'partial', 'none'],
  pilot: ['full', 'approximate', 'legal_only'],
  telemetry: ['full', 'partial', 'none'],
};

function supportFacts(): SupportFacts {
  const dimensions: SupportDimension[] = ['engine', 'help', 'pilot', 'telemetry'];
  return {
    mechanics: MECHANIC_SUPPORT_LIST.length,
    byDimension: dimensions.map((dimension) => ({
      dimension,
      counts: (SUPPORT_LEVELS[dimension] ?? []).map((level) => ({
        level,
        count: MECHANIC_SUPPORT_LIST.filter((entry) => entry[dimension] === level).length,
      })),
    })),
    engineInert: mechanicKeys(MECHANIC_SUPPORT_LIST.filter((entry) => entry.engine === 'none')),
    pilotBlindMechanics: mechanicKeys(
      MECHANIC_SUPPORT_LIST.filter((entry) => entry.pilot === 'legal_only'),
    ),
    telemetryBlindMechanics: mechanicKeys(
      MECHANIC_SUPPORT_LIST.filter((entry) => entry.telemetry === 'none'),
    ),
  };
}

function mechanicKeys(refs: readonly MechanicRef[]): readonly string[] {
  return refs.map((ref) => mechanicKey(ref)).sort((left, right) => left.localeCompare(right));
}

function limitationFacts(
  sets: readonly SetFacts[],
  precons: readonly PreconFacts[],
  support: SupportFacts,
  coverage: CoverageFacts,
): readonly string[] {
  const limitations: string[] = [];

  if (UNIMPLEMENTED_KEYWORDS.length > 0) {
    limitations.push(
      `Keywords the engine does not execute: ${UNIMPLEMENTED_KEYWORDS.join(', ')}. ` +
        'Barred from a `playtest` or `active` set by the content build, so no shipped card carries one (Q4).',
    );
  }
  limitations.push(
    `Of ${support.mechanics} classified mechanics, no pilot values ${support.pilotBlindMechanics.length} ` +
      `and no counter records ${support.telemetryBlindMechanics.length}. Both lists are in the section above.`,
  );

  for (const set of sets) {
    if (!STRICT_SET_STATUSES.includes(set.status as never)) continue;
    limitations.push(
      `Set \`${set.setId}\` (${set.status}): ${set.unimplemented} card(s) marked \`implemented: false\`; ` +
        `no pilot values ${set.pilotBlind} of its cards; no match record observes ${set.telemetryBlind}.`,
    );
  }

  for (const precon of precons) {
    if (precon.spareSlots > 5) continue;
    limitations.push(
      `\`${precon.preconId}\` has ${precon.colorLegalPool} colour-legal cards for a ${precon.cards}-card deck ` +
        `(${precon.spareSlots} spare). A package-scale mutation has nowhere to put what it frees.`,
    );
  }

  if (AGENT_CLASSES_WITHOUT_PILOTS.length > 0) {
    limitations.push(
      `No pilot in this build implements agent class(es): ${AGENT_CLASSES_WITHOUT_PILOTS.join(', ')}. ` +
        'Every claim resting on one is declined by every run this build can produce.',
    );
  }
  if (coverage.fixturesWithKnownGaps > 0) {
    limitations.push(
      `${coverage.fixturesWithKnownGaps} of ${coverage.calibrationFixtures} calibration fixtures record a ` +
        'pilot that misses the characteristic decision. The record is asserted in both directions, so a ' +
        'closed gap fails as loudly as a regression.',
    );
  }
  if (coverage.contracts !== coverage.contractSetCards) {
    limitations.push(
      `Behaviour contracts cover ${coverage.contracts} of ${coverage.contractSetCards} cards in ` +
        `\`${coverage.contractSetId}\`.`,
    );
  }

  return limitations;
}

/* ------------------------------------------------------------- doc scanning */

function questionLedger(repoRoot: string): QuestionLedger {
  const questionsDoc = readFileSync(join(repoRoot, 'docs', 'open-questions.md'), 'utf8');
  const planDoc = readFileSync(join(repoRoot, 'IMPLEMENTATION_PLAN.md'), 'utf8');

  const inQuestions = new Map<string, { title: string; answered: boolean }>();
  let section = '';
  for (const line of questionsDoc.split(/\r?\n/)) {
    const heading = /^##\s+(.*)$/.exec(line);
    if (heading?.[1]) section = heading[1];
    const question = /^###\s+(Q\d+)\.\s+(.*)$/.exec(line);
    if (!question?.[1] || question[2] === undefined) continue;
    const title = question[2].trim();
    inQuestions.set(question[1], {
      title,
      answered: /^answered$/i.test(section.trim()) || /answered/i.test(title),
    });
  }

  const planOpen = new Set<string>();
  let inOwnerSection = false;
  for (const line of planDoc.split(/\r?\n/)) {
    const heading = /^##\s+(.*)$/.exec(line);
    if (heading) inOwnerSection = /owner decisions still open/i.test(heading[1] ?? '');
    if (!inOwnerSection) continue;
    const listed = /^-\s+(Q\d+):/.exec(line);
    if (listed?.[1]) planOpen.add(listed[1]);
  }

  const ids = [...new Set([...inQuestions.keys(), ...planOpen])].sort(
    (left, right) => questionNumber(left) - questionNumber(right),
  );

  const rows: QuestionRow[] = ids.map((id) => {
    const entry = inQuestions.get(id);
    return {
      id,
      number: questionNumber(id),
      title: entry?.title ?? '(no entry in docs/open-questions.md)',
      inQuestions: entry ? (entry.answered ? 'answered' : 'open') : 'absent',
      inPlan: planOpen.has(id),
    };
  });

  const contradictions = rows
    .filter((row) => row.inPlan && row.inQuestions !== 'open')
    .map(
      (row) =>
        `${row.id} is listed open in \`IMPLEMENTATION_PLAN.md\`, but \`docs/open-questions.md\` records it as ${row.inQuestions}.`,
    );

  return {
    rows,
    contradictions,
    openNotListed: rows.filter((row) => row.inQuestions === 'open' && !row.inPlan).length,
  };
}

function questionNumber(id: string): number {
  return Number.parseInt(id.slice(1), 10);
}

function repoFacts(repoRoot: string): RepoFacts {
  const rootFiles = readdirSync(repoRoot)
    .filter((name) => !name.startsWith('.'))
    .filter((name) => statSync(join(repoRoot, name)).isFile())
    .sort();

  const adrDir = join(repoRoot, 'docs', 'architecture');
  const adrs = readdirSync(adrDir)
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((file) => ({ file, title: firstHeading(join(adrDir, file)) }));

  const milestoneDir = join(repoRoot, 'docs', 'milestones');
  const milestones = readdirSync(milestoneDir)
    .filter((name) => name.endsWith('.md'))
    .sort();

  const workspaceRoots = ['packages', 'apps'];
  const workspaces = workspaceRoots.flatMap((root) =>
    readdirSync(join(repoRoot, root))
      .filter((name) => statSync(join(repoRoot, root, name)).isDirectory())
      .sort()
      .map((name) => `${root}/${name}`),
  );

  return {
    rootFiles,
    unexpectedRootFiles: rootFiles.filter(
      (name) => name.endsWith('.md') && !PERMITTED_ROOT_DOCS.includes(name),
    ),
    workspaces,
    adrs,
    milestones,
  };
}

function firstHeading(path: string): string {
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const heading = /^#\s+(.*)$/.exec(line);
    if (heading?.[1]) return heading[1].trim();
  }
  return '(no heading)';
}

/** Every derived fact, read from the code and content at this commit. */
export function collectAudit(repoRoot: string): AuditFacts {
  const sets = setFacts();
  const precons = preconFacts();
  const support = supportFacts();
  const coverage = coverageFacts();

  return {
    versions: versionGroups(),
    sets,
    formats: formatFacts(),
    precons,
    deckPlans: deckPlanFacts(),
    coverage,
    support,
    limitations: limitationFacts(sets, precons, support, coverage),
    questions: questionLedger(repoRoot),
    repo: repoFacts(repoRoot),
  };
}

/* ---------------------------------------------------------------- rendering */

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|');
}

/** A padded Markdown table. Padding is cosmetic; the drift test compares bytes. */
function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? '').length)),
  );
  const line = (cells: readonly string[]): string =>
    `| ${cells.map((cell, column) => cell.padEnd(widths[column] ?? cell.length)).join(' | ')} |`;

  return [
    line(headers),
    `| ${widths.map((width) => '-'.repeat(Math.max(width, 3))).join(' | ')} |`,
    ...rows.map((row) => line(row.map(escapeCell))),
  ].join('\n');
}

function yesNo(value: boolean): string {
  return value ? 'yes' : 'no';
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/** The run record: what was measured, when, and at which commit. */
export function renderRunRecord(run: AuditRun): string {
  const lines: string[] = ['## Audit run', ''];
  lines.push(
    'A measurement rather than a derivation, so it is not re-checked by the drift test:',
    'reproducing it means running the suite again.',
    '',
  );
  lines.push(
    table(
      ['Reading', 'Value'],
      [
        ['Commit', `\`${run.commit}\``],
        ['Working tree', run.treeClean ? 'clean' : 'dirty — the audit includes uncommitted work'],
        ['Taken on', run.takenOn],
        ['Node', run.nodeVersion],
        ['`npm run verify`', verifyLabel(run.verify)],
      ],
    ),
    '',
    '### Verification chain',
    '',
    `\`npm run verify\` runs ${run.verifySteps.length} steps, in order:`,
    '',
    ...run.verifySteps.map((step, index) => `${index + 1}. \`${step}\``),
    '',
    '### Tests',
    '',
    table(
      ['Vitest project', 'Files', 'Tests'],
      [
        ...run.tests.projects.map((project) => [
          project.project,
          String(project.files),
          String(project.tests),
        ]),
        ['**total**', `**${run.tests.files}**`, `**${run.tests.tests}**`],
      ],
    ),
    '',
    'Enumerated with `vitest list`, which collects every case without running it.',
  );
  return lines.join('\n');
}

function verifyLabel(outcome: VerifyOutcome): string {
  switch (outcome) {
    case 'passed':
      return 'passed at this commit';
    case 'failed':
      return '**failed** at this commit';
    case 'not_run':
      return 'not run for this audit';
  }
}

/** Everything the drift test compares. */
export function renderDerivedFacts(facts: AuditFacts): string {
  const parts: string[] = [];

  parts.push('## Versions', '');
  parts.push(
    'Read from the constants themselves. A version below is what the software',
    'stamps today, not what a document remembers it stamping.',
    '',
  );
  for (const group of facts.versions) {
    parts.push(
      `### ${group.title}`,
      '',
      group.note,
      '',
      table(
        ['Constant', 'Value', 'Pins'],
        group.entries.map((entry) => [`\`${entry.constant}\``, entry.value, entry.pins]),
      ),
      '',
    );
  }

  parts.push('## Content', '', '### Sets', '');
  parts.push(
    table(
      [
        'Set',
        'Status',
        'Card schema',
        'Playable cards',
        'Tokens',
        'Unimplemented',
        'No pilot values',
        'No record observes',
      ],
      facts.sets.map((set) => [
        `\`${set.setId}\``,
        set.status,
        `v${set.schemaVersion}`,
        String(set.playable),
        String(set.tokens),
        String(set.unimplemented),
        String(set.pilotBlind),
        String(set.telemetryBlind),
      ]),
    ),
    '',
    '### Formats',
    '',
    table(
      ['Format', 'Sets', 'Pool', 'Deck size', 'Singleton', 'Max Commander colours', 'Banned'],
      facts.formats.map((format) => [
        `\`${format.formatId}\``,
        format.setIds.map((setId) => `\`${setId}\``).join(', '),
        String(format.poolSize),
        String(format.deckSize),
        yesNo(format.singleton),
        String(format.maxCommanderColors),
        String(format.banned),
      ]),
    ),
    '',
    '### Precons',
    '',
    table(
      ['Precon', 'Format', 'Commander', 'Colours', 'Cards', 'Legal', 'Plan', 'Colour-legal pool'],
      facts.precons.map((precon) => [
        `\`${precon.preconId}\``,
        `\`${precon.formatId}\``,
        `\`${precon.commanderId}\``,
        precon.commanderColors.join('/') || 'neutral',
        String(precon.cards),
        precon.legal ? 'yes' : `no — ${precon.issues.join(', ')}`,
        precon.planId ? `\`${precon.planId}\`` : '—',
        `${precon.colorLegalPool} (${precon.spareSlots >= 0 ? '+' : ''}${precon.spareSlots})`,
      ]),
    ),
    '',
    "The last column is the cards a Commander's colour identity allows against the deck size it has to fill.",
    '',
    '### Deck plans',
    '',
    table(
      ['Plan', 'Precon', 'Archetype', 'Packages', 'Core', 'Slots', 'Share of deck'],
      facts.deckPlans.map((plan) => [
        `\`${plan.planId}\``,
        plan.preconId ? `\`${plan.preconId}\`` : '—',
        plan.archetypeId,
        String(plan.packages),
        String(plan.corePackages),
        String(plan.slots),
        percent(plan.shareOfDeck),
      ]),
    ),
    '',
    `A plan may cover at most ${percent(MAX_PLAN_SHARE)} of a deck, enforced by the content build, so every`,
    'plan-generated deck keeps free slots no generator setting can take away.',
    '',
  );

  parts.push(
    '## Coverage',
    '',
    table(
      ['Instrument', 'Reading'],
      [
        [
          'Card behaviour contracts',
          `${facts.coverage.contracts} of ${facts.coverage.contractSetCards} cards in \`${facts.coverage.contractSetId}\``,
        ],
        [
          'Tactical calibration fixtures',
          `${facts.coverage.calibrationFixtures}, of which ${facts.coverage.fixturesWithKnownGaps} record a known pilot gap`,
        ],
        ['Glossary entries', String(facts.coverage.glossaryEntries)],
        ['Rulebook sections', String(facts.coverage.rulebookSections)],
      ],
    ),
    '',
  );
  if (facts.coverage.gapsByPilot.length > 0) {
    parts.push(
      table(
        ['Pilot', 'Fixtures it misses'],
        facts.coverage.gapsByPilot.map((entry) => [`\`${entry.pilotId}\``, String(entry.gaps)]),
      ),
      '',
    );
  }

  parts.push(
    '## Mechanic support',
    '',
    `${facts.support.mechanics} classified mechanics across seven executable vocabularies.`,
    '',
    table(
      ['Dimension', 'Levels'],
      facts.support.byDimension.map((entry) => [
        entry.dimension,
        entry.counts.map((count) => `${count.level} ${count.count}`).join(', '),
      ]),
    ),
    '',
  );
  parts.push(
    ...describeMechanicList('The engine does not execute', facts.support.engineInert),
    ...describeMechanicList('No pilot values', facts.support.pilotBlindMechanics),
    ...describeMechanicList('No match record observes', facts.support.telemetryBlindMechanics),
  );

  parts.push('## Known limitations', '');
  parts.push(...facts.limitations.map((limitation) => `- ${limitation}`), '');

  parts.push(
    '## Question ledger',
    '',
    '`docs/open-questions.md` against the owner-decision list in `IMPLEMENTATION_PLAN.md`.',
    '',
    table(
      ['Question', 'Title', 'Question file', 'Listed open in the plan'],
      facts.questions.rows.map((row) => [
        row.id,
        row.title.length > 70 ? `${row.title.slice(0, 67)}...` : row.title,
        row.inQuestions,
        yesNo(row.inPlan),
      ]),
    ),
    '',
  );
  parts.push(
    `${facts.questions.openNotListed} question(s) are open in the question file and not on the plan's`,
    'short list, which is the curated set a tranche might have to stop on rather than an index.',
    '',
  );
  if (facts.questions.contradictions.length > 0) {
    parts.push(
      'The other direction is a contradiction, and there is one for each of:',
      '',
      ...facts.questions.contradictions.map((entry) => `- ${entry}`),
      '',
    );
  } else {
    parts.push('No question the plan calls open is missing or answered in the question file.', '');
  }

  parts.push(
    '## Repository inventory',
    '',
    table(
      ['Reading', 'Value'],
      [
        ['Workspaces', facts.repo.workspaces.map((name) => `\`${name}\``).join(', ')],
        ['Root files', facts.repo.rootFiles.map((name) => `\`${name}\``).join(', ')],
        [
          'Root Markdown beyond the three permitted',
          facts.repo.unexpectedRootFiles.length === 0
            ? 'none'
            : facts.repo.unexpectedRootFiles.map((name) => `\`${name}\``).join(', '),
        ],
        ['Architecture decision records', String(facts.repo.adrs.length)],
        ['Milestone documents', String(facts.repo.milestones.length)],
      ],
    ),
    '',
    '### Architecture decision records',
    '',
    table(
      ['File', 'Title'],
      facts.repo.adrs.map((adr) => [`\`${adr.file}\``, adr.title]),
    ),
    '',
  );

  return parts.join('\n').trimEnd();
}

function describeMechanicList(label: string, keys: readonly string[]): readonly string[] {
  if (keys.length === 0) return [`${label}: none.`, ''];
  return [`${label} (${keys.length}):`, '', keys.map((key) => `\`${key}\``).join(', '), ''];
}

/** The whole document: banner, run record, then the derived facts in markers. */
export function renderAuditDocument(facts: AuditFacts, run: AuditRun): string {
  return [
    '# Status audit',
    '',
    AUDIT_BANNER,
    '',
    renderRunRecord(run),
    '',
    DERIVED_START,
    '',
    renderDerivedFacts(facts),
    '',
    DERIVED_END,
    '',
  ].join('\n');
}
