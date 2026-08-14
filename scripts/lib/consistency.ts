/**
 * The repository consistency check — M07's closing gate.
 *
 * M07 removed the drift between the documents and the software one tranche at a
 * time, by hand. This module is what stops it coming back: each thing M07.7
 * names is a function here, and `consistency.test.ts` runs all of them, so a
 * document that starts teaching a rule the game does not have fails the suite
 * rather than waiting for somebody to notice.
 *
 * Several checks were already enforced elsewhere and are *retained* rather than
 * rebuilt — an unimplemented card or an inert mechanic in a playable set is a
 * content-build error and a mistargeted card is a display-text lint warning
 * promoted to one (`content/build.ts`), and the counts in `docs/status-audit.md`
 * are compared byte-for-byte by `status-audit.test.ts`. They are re-run here
 * anyway, against the same registries, so one command answers the whole question
 * instead of four commands answering a quarter of it each.
 *
 * M07.8 added the three the pass found missing: an **inert mechanic** in a
 * playable set (the `implemented: false` check beside it only reads a flag an
 * author typed), the **target-semantic** class where prose and structured
 * targets disagree about who an effect reaches, and the **question ledger**,
 * which `audit:status` rendered into a document without ever failing on it.
 *
 * The judgement calls, all of them deliberate:
 *
 * - **Historical documents are exempt from the prose checks.** An accepted ADR
 *   keeps the text it was accepted with, and M07.3 corrected it with a
 *   supersession block rather than a rewrite; a milestone file records what was
 *   true when the tranche ran. Holding either to today's vocabulary would mean
 *   editing the record, which is the opposite of what M07 did. They are still
 *   link-checked, because a broken link is broken in a historical document too.
 * - **A quoted term is a mention, not a claim.** `docs/open-questions.md` has to
 *   be able to write that a deleted file said "the enemy Commander", and
 *   `confirmed-rules.md` has to be able to say there is no `unitSlots`. Text
 *   inside backticks, quotation marks, fenced code and link targets is blanked
 *   before the retired-term scan, so discussing a retired term is free and
 *   asserting one is an error.
 * - **Nothing here judges game design.** Every expected value is read from the
 *   constant, registry or content that defines it. The checker has no opinion
 *   about what the deck size should be, only that every document agrees with
 *   `content/formats/`.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, posix, relative, resolve, sep } from 'node:path';

import {
  BUNDLED_FORMATS,
  BUNDLED_PRECONS,
  COLOR_IDS,
  KEYWORD_IDS,
  KEYWORD_LIST,
  STRICT_SET_STATUSES,
  describeCardSupport,
  limitingMechanics,
  lintDisplayText,
  loadBundledCardData,
  mechanicKey,
} from '@tcg/card-data';
import { GLOSSARY_ENTRIES, loadRulebook, resolvedKeywords } from '@tcg/help-content';
import { DEFAULT_RULES_CONFIG } from '@tcg/rules-engine';
import { analysisSettingsSchema } from '@tcg/simulator';

/* ------------------------------------------------------------------ results */

export interface ConsistencyFinding {
  /** Which of the six checks produced it. */
  readonly check: ConsistencyCheckId;
  /** Repo-relative, forward slashes. `null` for a finding about code, not a file. */
  readonly file: string | null;
  /** 1-based, or `null` when the finding is not anchored to a line. */
  readonly line: number | null;
  readonly message: string;
}

export const CONSISTENCY_CHECK_IDS = [
  'retired-term',
  'markdown-link',
  'path-reference',
  'documented-value',
  'unimplemented-card',
  'count-claim',
  /** A card in a playable set built on a mechanic the engine does not execute. */
  'inert-mechanic',
  /** Prose and structured targets that disagree about who an effect reaches. */
  'target-semantics',
  /** The two question documents contradicting each other about what is open. */
  'question-ledger',
] as const;
export type ConsistencyCheckId = (typeof CONSISTENCY_CHECK_IDS)[number];

export interface ConsistencyReport {
  readonly findings: readonly ConsistencyFinding[];
  readonly ok: boolean;
  readonly counts: {
    readonly documents: number;
    readonly activeDocuments: number;
    readonly links: number;
    readonly pathReferences: number;
    readonly documentedValues: number;
    readonly countClaims: number;
    /**
     * Cards in a `playtest` or `active` set, which is the population the
     * unimplemented-card, inert-mechanic and target-semantic checks walk.
     *
     * Reported for the same reason `countClaims` is: a content check that found
     * no cards to look at reports a clean repository in the same words as one
     * that works, so the suite asserts this is non-zero.
     */
    readonly playableCards: number;
    /** Questions compared between the plan's short list and the question file. */
    readonly questions: number;
  };
}

/** Cards in every set people are expected to play with. */
function playableCardCount(): number {
  return loadBundledCardData()
    .sets.filter((set) => STRICT_SET_STATUSES.includes(set.status))
    .reduce((total, set) => total + set.cards.length, 0);
}

function finding(
  check: ConsistencyCheckId,
  file: string | null,
  line: number | null,
  message: string,
): ConsistencyFinding {
  return { check, file, line, message };
}

/* ------------------------------------------------------------- the document set */

/** Directories that hold no authored Markdown. `results/` is git-ignored output. */
const IGNORED_DIRS = new Set(['node_modules', 'dist', 'coverage', 'results']);

export interface MarkdownDocument {
  /** Repo-relative path with forward slashes, e.g. `docs/rules/open-decisions.md`. */
  readonly path: string;
  readonly text: string;
}

/** Every authored Markdown file in the repository, sorted by path. */
export function markdownDocuments(repoRoot: string): readonly MarkdownDocument[] {
  const found: string[] = [];

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      if (entry.startsWith('.') || IGNORED_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.md')) found.push(full);
    }
  };
  walk(repoRoot);

  return found.map((full) => ({
    path: relative(repoRoot, full).split(sep).join('/'),
    text: readFileSync(full, 'utf8'),
  }));
}

/**
 * Documents that record what *was* true and are exempt from the prose checks.
 *
 * `docs/project-status.md` is here for the same reason as the milestone files:
 * M07.4 kept its Phase 1–3 history and corrected the stale claims in place
 * rather than deleting the record, so it quotes the old game by design.
 */
export const HISTORICAL_DOC_PREFIXES: readonly string[] = [
  'docs/architecture/',
  'docs/history/',
  'docs/milestones/',
];

export const HISTORICAL_DOCS: readonly string[] = [
  'docs/PHASE4_HARDENING.md',
  'docs/project-status.md',
];

/** Written by `npm run audit:status`, and guarded by `status-audit.test.ts`. */
export const GENERATED_DOCS: readonly string[] = ['docs/status-audit.md'];

/** A document that must describe the game as it is today. */
export function isActiveDocument(path: string): boolean {
  if (GENERATED_DOCS.includes(path)) return false;
  if (HISTORICAL_DOCS.includes(path)) return false;
  return !HISTORICAL_DOC_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/* ------------------------------------------------------------------ scanning */

/** 1-based line number of a character offset. */
function lineOf(text: string, index: number): number {
  let line = 1;
  for (let at = 0; at < index && at < text.length; at += 1) {
    if (text[at] === '\n') line += 1;
  }
  return line;
}

/** Replaces a matched span with spaces, so every other offset still holds. */
function blank(text: string, pattern: RegExp): string {
  return text.replace(pattern, (match) => match.replace(/[^\n]/g, ' '));
}

/**
 * Everything a document *asserts*, with everything it merely *quotes* blanked.
 *
 * Offsets are preserved, so a finding still reports the line it was on. The
 * spans removed are the four ways this repository's documents refer to a term
 * without claiming it: fenced code, inline code, quotation marks (straight and
 * curly), and the target half of a Markdown link.
 */
export function assertedText(markdown: string): string {
  let text = blank(markdown, /```[\s\S]*?```/g);
  text = blank(text, /<!--[\s\S]*?-->/g);
  text = blank(text, /`[^`\n]*`/g);
  text = blank(text, /"[^"\n]*"/g);
  text = blank(text, /“[^”\n]*”/g);
  text = blank(text, /\]\([^)\n]*\)/g);
  return text;
}

/**
 * A negation sitting in the term's own determiner slot, as in "no separate
 * recovery zone".
 *
 * Denying a retired rule is the *correct* thing for a document to do — the
 * rulebook tells a player there is no recovery zone, which is precisely the
 * sentence this check exists to protect — so a denial is not a finding.
 *
 * The window is deliberately tiny. "Does not use a unit slot" is not a denial
 * that unit slots exist, and `not` is not `no`, so it is still reported.
 */
const NEGATED = /\b(?:no|never)\b\s+(?:\w+\s+)?$/i;

function isNegated(text: string, index: number): boolean {
  return NEGATED.test(text.slice(Math.max(0, index - 20), index));
}

/* --------------------------------------------------- 1. retired rule vocabulary */

export interface RetiredTerm {
  readonly pattern: RegExp;
  /** What the game does instead, and where that is enforced. */
  readonly why: string;
}

/**
 * Rule vocabulary this game retired, each one grounded in code rather than in
 * another document.
 *
 * Deliberately terms and not numbers: a wrong number is caught precisely by
 * `checkDocumentedValues` against the constant that owns it, and a lexicon of
 * numbers would go stale the first time a dial moved.
 *
 * "Token stack" is deliberately absent. M06 made it a real presentation concept
 * with a glossary entry and a component; what M07.6 found stale was a *card*
 * reaching for it as a game object, which is a content-lint question rather
 * than a vocabulary one.
 */
export const RETIRED_TERMS: readonly RetiredTerm[] = [
  {
    pattern: /\bunit slots?\b/gi,
    why: 'the battlefield has no Unit limit and `RulesConfig` has no `unitSlots` (rules-engine/src/config.ts)',
  },
  {
    pattern: /\bsummoning[- ]sick/gi,
    why: '`Newly Deployed` replaced summoning sickness (rules-engine/src/keywords.ts)',
  },
  {
    pattern: /\bswift\b/gi,
    why: 'the `swift` keyword was renamed `rush` by the v2 → v3 card migration (card-data/src/schema/primitives.ts)',
  },
  {
    pattern: /\brecovery zone\b/gi,
    why: 'a defeated Commander returns immediately to the Command Zone; there is no Recovery Zone (rules-engine/src/effects.ts#restDefeated)',
  },
  {
    pattern: /\bnever deployed\b/gi,
    why: 'a Commander is deployed from the Command Zone onto the battlefield as a Unit (docs/rules/confirmed-rules.md#commanders)',
  },
  {
    pattern: /\bbattlefield is full\b/gi,
    why: 'the battlefield is unbounded, so it can never be full (rules-engine/src/config.ts)',
  },
  {
    pattern: /\bon_deploy\b/g,
    why: "there is no `on_deploy` trigger; arrival behaviour is the card's top-level `effects` (docs/ADDING_CARDS.md)",
  },
  {
    pattern: /\bprototype_core\.json\b/g,
    why: 'the monolithic catalogue was replaced by per-set directories under `content/` (ADR 0015)',
  },
];

/** Retired vocabulary asserted by an active document. */
export function checkRetiredTerms(
  documents: readonly MarkdownDocument[],
): readonly ConsistencyFinding[] {
  const findings: ConsistencyFinding[] = [];

  for (const document of documents) {
    if (!isActiveDocument(document.path)) continue;
    const text = assertedText(document.text);
    for (const term of RETIRED_TERMS) {
      for (const match of text.matchAll(term.pattern)) {
        if (isNegated(text, match.index)) continue;
        findings.push(
          finding(
            'retired-term',
            document.path,
            lineOf(text, match.index),
            `asserts the retired term "${match[0].trim()}" — ${term.why}. Quote it in backticks or quotation marks if the mention is deliberate.`,
          ),
        );
      }
    }
  }

  return findings;
}

/**
 * The same sweep over the player-facing help, which is data rather than a file.
 *
 * The rulebook's keyword and glossary indexes are rendered into its section
 * text, so resolving the book covers all three at once; the keyword and
 * glossary definitions are checked separately as well because a surface may
 * render either one on its own.
 */
export function checkRetiredTermsInHelp(): readonly ConsistencyFinding[] {
  const findings: ConsistencyFinding[] = [];
  const rulebook = loadRulebook();

  const sources: { readonly where: string; readonly text: string }[] = [
    { where: 'rulebook intro', text: rulebook.intro },
    ...rulebook.sections.map((section) => ({
      where: `rulebook section "${section.id}"`,
      text: section.searchText,
    })),
    ...resolvedKeywords().map((keyword) => ({
      where: `keyword "${keyword.id}"`,
      text: `${keyword.shortDefinition} ${keyword.fullDefinition}`,
    })),
    ...GLOSSARY_ENTRIES.map((entry) => ({
      where: `glossary entry "${entry.id}"`,
      text: `${entry.term} ${entry.definition}`,
    })),
  ];

  for (const source of sources) {
    for (const term of RETIRED_TERMS) {
      for (const match of source.text.matchAll(term.pattern)) {
        if (isNegated(source.text, match.index)) continue;
        findings.push(
          finding(
            'retired-term',
            null,
            null,
            `${source.where} uses the retired term "${match[0].trim()}" — ${term.why}.`,
          ),
        );
      }
    }
  }

  return findings;
}

/* ------------------------------------------------------- 2. internal Markdown links */

/** GitHub's heading slug: lowercase, punctuation dropped, spaces hyphenated. */
export function headingSlug(heading: string): string {
  return heading
    .replace(/`/g, '')
    .replace(/\*\*?/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, '')
    .replace(/ /g, '-');
}

/** Every anchor a document offers, with GitHub's `-1`, `-2` disambiguation. */
export function headingAnchors(markdown: string): ReadonlySet<string> {
  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  let inFence = false;

  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (!heading?.[1]) continue;
    const base = headingSlug(heading[1]);
    if (base.length === 0) continue;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }

  // Explicit HTML anchors, which a hand-written index may rely on.
  for (const match of markdown.matchAll(/<a\s+(?:name|id)="([^"]+)"/g)) {
    if (match[1]) anchors.add(match[1].toLowerCase());
  }

  return anchors;
}

const LINK = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

export interface LinkCheckResult {
  readonly findings: readonly ConsistencyFinding[];
  readonly links: number;
}

/**
 * Every relative link and anchor in every Markdown file resolves.
 *
 * Historical documents are included: their text is preserved, but a link out of
 * one still has to land somewhere, and M07 moved a great deal of content.
 */
export function checkMarkdownLinks(
  repoRoot: string,
  documents: readonly MarkdownDocument[],
): LinkCheckResult {
  const findings: ConsistencyFinding[] = [];
  const byPath = new Map(documents.map((document) => [document.path, document.text]));
  const anchorCache = new Map<string, ReadonlySet<string>>();
  let links = 0;

  const anchorsOf = (path: string): ReadonlySet<string> => {
    const cached = anchorCache.get(path);
    if (cached) return cached;
    const text = byPath.get(path) ?? readFileSync(join(repoRoot, path), 'utf8');
    const anchors = headingAnchors(text);
    anchorCache.set(path, anchors);
    return anchors;
  };

  for (const document of documents) {
    const text = blank(document.text, /```[\s\S]*?```/g);
    const dir = posix.dirname(document.path);

    for (const match of text.matchAll(LINK)) {
      const raw = match[1];
      if (raw === undefined) continue;
      if (/^(?:https?:|mailto:|#!)/.test(raw)) continue;
      links += 1;

      const line = lineOf(text, match.index);
      const hash = raw.indexOf('#');
      const targetPath = hash === -1 ? raw : raw.slice(0, hash);
      const anchor = hash === -1 ? '' : decodeURIComponent(raw.slice(hash + 1)).toLowerCase();

      // A bare `#anchor` points inside the document it is written in.
      const resolvedPath =
        targetPath === ''
          ? document.path
          : posix.normalize(posix.join(dir === '.' ? '' : dir, decodeURIComponent(targetPath)));

      if (resolvedPath.startsWith('..')) {
        findings.push(
          finding('markdown-link', document.path, line, `link "${raw}" escapes the repository.`),
        );
        continue;
      }

      let exists: boolean;
      try {
        exists = statSync(resolve(repoRoot, resolvedPath)).isFile() || targetPath.endsWith('/');
      } catch {
        exists = false;
      }
      if (!exists) {
        try {
          exists = statSync(resolve(repoRoot, resolvedPath)).isDirectory();
        } catch {
          exists = false;
        }
      }
      if (!exists) {
        findings.push(
          finding(
            'markdown-link',
            document.path,
            line,
            `link "${raw}" points at ${resolvedPath}, which does not exist.`,
          ),
        );
        continue;
      }

      if (anchor === '' || !resolvedPath.endsWith('.md')) continue;
      if (!anchorsOf(resolvedPath).has(anchor)) {
        findings.push(
          finding(
            'markdown-link',
            document.path,
            line,
            `link "${raw}" points at anchor #${anchor}, which ${resolvedPath} has no heading for.`,
          ),
        );
      }
    }
  }

  return { findings, links };
}

/* ----------------------------------------------- 3. path references in prose */

/**
 * Top-level entries a backticked token must start with to be read as a path.
 *
 * Without this, `M07.1/M07.2` and `playtest/active` would be checked as files.
 * A token naming one of these and then not existing is a claim about the
 * repository that is false — which is exactly what M07.7 asks to catch in
 * `IMPLEMENTATION_PLAN.md`, and is worth catching in every active document.
 */
export const PATH_ROOTS: readonly string[] = [
  'apps',
  'assets',
  'content',
  'docs',
  'packages',
  'scripts',
];

const BACKTICKED = /`([^`\n]+)`/g;

export interface PathReferenceResult {
  readonly findings: readonly ConsistencyFinding[];
  readonly references: number;
}

/** Every backticked repository path an active document names exists. */
export function checkPathReferences(
  repoRoot: string,
  documents: readonly MarkdownDocument[],
): PathReferenceResult {
  const findings: ConsistencyFinding[] = [];
  let references = 0;

  for (const document of documents) {
    if (!isActiveDocument(document.path)) continue;
    const text = blank(document.text, /```[\s\S]*?```/g);

    for (const match of text.matchAll(BACKTICKED)) {
      const token = match[1]?.trim();
      if (token === undefined || token.length === 0) continue;
      // A path claim, not a glob, a package name, a command or a prose slash.
      if (!token.includes('/') || token.includes('*') || token.includes(' ')) continue;
      if (token.startsWith('@') || token.startsWith('http')) continue;
      // `content/sets/<setId>/cards/<card_id>.json` is a shape, not a file.
      if (token.includes('<') || token.includes('>')) continue;

      const [root] = token.split('/');
      if (root === undefined || !PATH_ROOTS.includes(root)) continue;

      // An issue code — `content/unimplemented_card` — is a namespaced
      // identifier that happens to be spelled with a slash. A real path claim
      // either names a file, or reaches past the first directory, or says it is
      // a directory by ending in one.
      const looksLikePath =
        /\.[a-z0-9]{2,5}$/i.test(token) || token.split('/').length > 2 || token.endsWith('/');
      if (!looksLikePath) continue;

      references += 1;
      // A trailing `#member` names something inside the file, not a path.
      const path = token.replace(/\/$/, '').split('#')[0] ?? token;
      let exists = false;
      try {
        exists = statSync(resolve(repoRoot, path)) !== null;
      } catch {
        exists = false;
      }
      if (!exists) {
        findings.push(
          finding(
            'path-reference',
            document.path,
            lineOf(text, match.index),
            `names \`${token}\`, which does not exist in the repository.`,
          ),
        );
      }
    }
  }

  return { findings, references };
}

/* ------------------------------------------ 4. documented values versus source */

/** A `| a | b | c |` row's cells, or `null` for a separator or non-row. */
function tableCells(line: string): readonly string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return null;
  if (/^\|[\s|:-]+\|$/.test(trimmed)) return null;
  return trimmed
    .slice(1, -1)
    .split('|')
    .map((cell) => cell.trim());
}

/** Rows of the table under `## heading`, with their 1-based line numbers. */
function tableUnder(
  markdown: string,
  heading: RegExp,
): readonly { readonly cells: readonly string[]; readonly line: number }[] {
  const lines = markdown.split(/\r?\n/);
  const rows: { cells: readonly string[]; line: number }[] = [];
  let inSection = false;
  let started = false;

  for (const [index, line] of lines.entries()) {
    const isHeading = /^#{2,3}\s+/.test(line);
    if (isHeading) {
      if (inSection && started) break;
      inSection = heading.test(line);
      continue;
    }
    if (!inSection) continue;
    const cells = tableCells(line);
    if (cells) {
      started = true;
      rows.push({ cells, line: index + 1 });
    } else if (started && line.trim().length === 0) {
      break;
    }
  }

  // The first row is the header.
  return rows.slice(1);
}

/** Backticked identifiers in a cell, e.g. `` `a`, `b` `` → `['a','b']`. */
function identifiers(cell: string): readonly string[] {
  return [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1] as string);
}

/**
 * Whether a documented cell states `value`.
 *
 * The tables are written for a reader, so they say `yes`, `+1`, `90s` and
 * `2000/20` rather than JSON. Normalising here keeps the documents readable and
 * still lets the comparison be exact.
 */
function statesValue(cell: string, value: unknown): boolean {
  const text = cell.trim();
  if (typeof value === 'boolean') return /^(yes|true)$/i.test(text) === value;
  if (typeof value === 'number') {
    const numeric = Number.parseFloat(text.replace(/^\+/, '').replace(/s$/i, ''));
    return Number.isFinite(numeric) && numeric === value;
  }
  return text.replace(/`/g, '') === String(value);
}

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};

const OPEN_DECISIONS = 'docs/rules/open-decisions.md';

export interface DocumentedValueResult {
  readonly findings: readonly ConsistencyFinding[];
  readonly values: number;
}

/**
 * The transcribed tables in `docs/rules/open-decisions.md` against their source.
 *
 * This document is the one place the project deliberately copies configuration
 * into prose, because a playtester needs to read the dials without opening
 * TypeScript. M07.2 had to repair it by hand and found six dials missing, so
 * both directions are checked: every documented row must match the live value,
 * and every live field must have a row.
 */
export function checkDocumentedValues(repoRoot: string): DocumentedValueResult {
  const findings: ConsistencyFinding[] = [];
  const markdown = readFileSync(join(repoRoot, OPEN_DECISIONS), 'utf8');
  let values = 0;

  const report = (line: number | null, message: string): void => {
    findings.push(finding('documented-value', OPEN_DECISIONS, line, message));
  };

  /* --- the RulesConfig dials --------------------------------------------- */
  const config = DEFAULT_RULES_CONFIG as unknown as Record<string, unknown>;
  const documentedFields = new Set<string>();

  for (const row of tableUnder(markdown, /Match rules/i)) {
    const [, current, fieldCell] = row.cells;
    if (current === undefined || fieldCell === undefined) continue;
    const fields = identifiers(fieldCell);
    if (fields.length === 0) continue;

    // `1 / +1` documents two fields in one cell, in the order they are named.
    const stated = fields.length === 1 ? [current] : current.split('/').map((part) => part.trim());
    for (const [index, field] of fields.entries()) {
      documentedFields.add(field);
      values += 1;
      if (!(field in config)) {
        report(row.line, `documents \`${field}\`, which is not a field on \`RulesConfig\`.`);
        continue;
      }
      const cell = stated[index];
      if (cell === undefined || !statesValue(cell, config[field])) {
        report(
          row.line,
          `says \`${field}\` is "${cell ?? current}", but \`DEFAULT_RULES_CONFIG.${field}\` is ${String(config[field])}.`,
        );
      }
    }
  }

  for (const field of Object.keys(config)) {
    if (field === 'version' || documentedFields.has(field)) continue;
    report(null, `\`RulesConfig.${field}\` has no row in the provisional-numbers table.`);
  }

  /* --- deck construction, per format ------------------------------------- */
  for (const row of tableUnder(markdown, /Deck construction/i)) {
    const [formatCell, size, copies, colors] = row.cells;
    const formatId = identifiers(formatCell ?? '')[0];
    if (formatId === undefined) continue;
    const format = BUNDLED_FORMATS.find((entry) => entry.formatId === formatId);
    values += 1;
    if (!format) {
      report(row.line, `documents format \`${formatId}\`, which is not bundled.`);
      continue;
    }
    if (size === undefined || !statesValue(size, format.deck.size)) {
      report(
        row.line,
        `says \`${formatId}\` is ${size ?? '?'} cards, but the format declares ${format.deck.size}.`,
      );
    }
    if (colors === undefined || !statesValue(colors, format.deck.maxCommanderColors)) {
      report(
        row.line,
        `says \`${formatId}\` caps Commander colours at ${colors ?? '?'}, but the format declares ${format.deck.maxCommanderColors}.`,
      );
    }
    if (/singleton/i.test(copies ?? '') !== format.deck.singleton) {
      report(
        row.line,
        `describes \`${formatId}\` copies as "${copies ?? ''}", but the format's \`singleton\` is ${String(format.deck.singleton)}.`,
      );
    }
  }

  /* --- the keyword table ------------------------------------------------- */
  const documentedKeywords = new Set<string>();
  for (const row of tableUnder(markdown, /^#{2,3}\s+Keywords\s*$/i)) {
    const [keywordCell, behaviour] = row.cells;
    const keywordId = identifiers(keywordCell ?? '')[0];
    if (keywordId === undefined) continue;
    documentedKeywords.add(keywordId);
    values += 1;

    const definition = KEYWORD_LIST.find((entry) => entry.id === keywordId);
    if (!definition) {
      report(row.line, `documents keyword \`${keywordId}\`, which is not in \`KEYWORD_REGISTRY\`.`);
      continue;
    }
    const calledInert = /\binert\b/i.test(behaviour ?? '');
    if (calledInert === definition.implemented) {
      report(
        row.line,
        calledInert
          ? `calls \`${keywordId}\` inert, but the registry marks it implemented.`
          : `describes \`${keywordId}\` as working, but the registry marks it unimplemented.`,
      );
    }
  }
  for (const keywordId of KEYWORD_IDS) {
    if (!documentedKeywords.has(keywordId)) {
      report(null, `keyword \`${keywordId}\` has no row in the keyword table.`);
    }
  }

  /* --- the analyser's thresholds ----------------------------------------- */
  // Only one direction here, unlike the dials above. The provisional-numbers
  // table says "every provisional numeric rule is a field on `RulesConfig`", so
  // a missing row breaks a promise the document makes; the thresholds table is
  // openly the subset a reader asks about most, and `analysisSettingsSchema` is
  // the complete list. A documented row must still be right.
  const analysis = analysisSettingsSchema.parse({}) as unknown as Record<string, unknown>;
  for (const row of tableUnder(markdown, /Simulator analysis thresholds/i)) {
    const [settingCell, current] = row.cells;
    const setting = identifiers(settingCell ?? '')[0];
    if (setting === undefined) continue;
    values += 1;
    if (!(setting in analysis)) {
      report(row.line, `documents \`${setting}\`, which is not an analysis setting.`);
      continue;
    }
    if (current === undefined || !statesValue(current, analysis[setting])) {
      report(
        row.line,
        `says \`${setting}\` defaults to "${current ?? '?'}", but the schema's default is ${String(analysis[setting])}.`,
      );
    }
  }

  /* --- the two counts the document states in words ------------------------ */
  const keywordCount = /\b([A-Za-z]+) keywords exist\b/i.exec(markdown);
  if (keywordCount?.[1]) {
    values += 1;
    const stated = NUMBER_WORDS[keywordCount[1].toLowerCase()];
    if (stated !== KEYWORD_IDS.length) {
      report(
        lineOf(markdown, keywordCount.index),
        `says ${keywordCount[1]} keywords exist, but \`KEYWORD_IDS\` has ${KEYWORD_IDS.length}.`,
      );
    }
  }

  const colorCount = /\b([A-Za-z]+) placeholder colours\b/i.exec(markdown);
  if (colorCount?.[1]) {
    values += 1;
    const stated = NUMBER_WORDS[colorCount[1].toLowerCase()];
    if (stated !== COLOR_IDS.length) {
      report(
        lineOf(markdown, colorCount.index),
        `says ${colorCount[1]} placeholder colours, but \`COLOR_IDS\` has ${COLOR_IDS.length}.`,
      );
    }
  }

  return { findings, values };
}

/* -------------------------------------- 5. unimplemented cards in playable sets */

/**
 * No `implemented: false` card sits in a `playtest` or `active` set.
 *
 * Retained rather than new: `content/build.ts` already refuses to build such a
 * bundle. Re-asserted here against the shipped content so the consistency
 * command covers it too — the build gate protects the input, this protects what
 * actually got bundled.
 */
export function checkUnimplementedCards(): readonly ConsistencyFinding[] {
  const findings: ConsistencyFinding[] = [];

  for (const set of loadBundledCardData().sets) {
    if (!STRICT_SET_STATUSES.includes(set.status)) continue;
    for (const card of set.cards) {
      if (card.implemented) continue;
      findings.push(
        finding(
          'unimplemented-card',
          null,
          null,
          `"${card.name}" (${card.id}) is \`implemented: false\` in \`${set.setId}\`, whose status is \`${set.status}\`.`,
        ),
      );
    }
  }

  return findings;
}

/* ------------------- 5b. inert mechanics and mistargeted prose in playable sets */

/**
 * No card in a `playtest` or `active` set is built on a mechanic the engine does
 * not execute.
 *
 * The sibling of {@link checkUnimplementedCards}, and the more important half:
 * `implemented: false` is a sentence an author typed, while this walks the
 * structured data the engine really runs and asks the mechanic support registry
 * about every piece of it. A card can be marked implemented and still be built
 * on `resilient`.
 *
 * Retained rather than rebuilt — `content/build.ts` already refuses to build such
 * a bundle — and re-asserted here against the shipped content, so the build gate
 * protects the input and this protects what actually got bundled.
 */
export function checkInertMechanics(): readonly ConsistencyFinding[] {
  const findings: ConsistencyFinding[] = [];

  for (const set of loadBundledCardData().sets) {
    if (!STRICT_SET_STATUSES.includes(set.status)) continue;
    for (const card of set.cards) {
      const support = describeCardSupport(card);
      if (support.executable) continue;
      const inert = limitingMechanics(support.mechanics, 'engine').map(mechanicKey);
      findings.push(
        finding(
          'inert-mechanic',
          `content/sets/${set.setId}/cards/${card.id}.json`,
          null,
          `"${card.name}" (${card.id}) is built on ${inert.join(', ')}, which the rules engine does not execute, in \`${set.setId}\` (status \`${set.status}\`).`,
        ),
      );
    }
  }

  return findings;
}

/**
 * Shipped card prose agrees with its structured targets about **who is reached**.
 *
 * `lintDisplayText` owns the rule and the content build already promotes its
 * warnings to errors for a strict set. This re-runs it over the bundled content
 * and reports only the semantic codes, because those are the class M07.8 found:
 * `goblin_powder_runner` printed damage at a battlefield permanent when the rule
 * says an opponent, `mourning_keeper` said "your Commander" where the engine
 * healed the player, and every mechanic marker passed both.
 *
 * Deliberately narrower than the linter as a whole. The mechanic and keyword
 * codes are a different check that the content build already fails on; repeating
 * them here would report the same drift twice under two names.
 */
const TARGET_SEMANTIC_CODES: ReadonlySet<string> = new Set([
  'display_text/player_as_commander',
  'display_text/unstated_player_target',
  'display_text/entry_timing',
]);

export function checkTargetSemantics(): readonly ConsistencyFinding[] {
  const findings: ConsistencyFinding[] = [];

  for (const set of loadBundledCardData().sets) {
    if (!STRICT_SET_STATUSES.includes(set.status)) continue;
    for (const card of set.cards) {
      for (const issue of lintDisplayText(card)) {
        if (!TARGET_SEMANTIC_CODES.has(issue.code)) continue;
        findings.push(
          finding(
            'target-semantics',
            `content/sets/${set.setId}/cards/${card.id}.json`,
            null,
            `${issue.message} (${issue.code})`,
          ),
        );
      }
    }
  }

  return findings;
}

/* --------------------------------------------------- 5c. the question ledger */

const OPEN_QUESTIONS = 'docs/open-questions.md';
const PLAN = 'IMPLEMENTATION_PLAN.md';

interface QuestionEntry {
  readonly id: string;
  readonly line: number;
  readonly answered: boolean;
}

/** Every `### Qn.` heading in the question file, and whether it is answered. */
function questionsIn(markdown: string): readonly QuestionEntry[] {
  const entries: QuestionEntry[] = [];
  let section = '';

  for (const [index, line] of markdown.split(/\r?\n/).entries()) {
    const heading = /^##\s+(.*)$/.exec(line);
    if (heading?.[1] !== undefined) section = heading[1];
    const question = /^###\s+(Q\d+)\.\s+(.*)$/.exec(line);
    if (question?.[1] === undefined || question[2] === undefined) continue;
    entries.push({
      id: question[1],
      line: index + 1,
      // Two independent signals, because the document uses both: the entry
      // lives under `## Answered`, and its own title carries the ruling date.
      answered: /^answered$/i.test(section.trim()) || /answered/i.test(question[2]),
    });
  }

  return entries;
}

/** Question IDs the plan's owner-decision list calls open, with their lines. */
function planOpenQuestions(markdown: string): ReadonlyMap<string, number> {
  const found = new Map<string, number>();
  let inSection = false;

  for (const [index, line] of markdown.split(/\r?\n/).entries()) {
    const heading = /^##\s+(.*)$/.exec(line);
    if (heading) inSection = /owner decisions still open/i.test(heading[1] ?? '');
    if (!inSection) continue;
    const listed = /^-\s+(Q\d+):/.exec(line);
    if (listed?.[1] !== undefined && !found.has(listed[1])) found.set(listed[1], index + 1);
  }

  return found;
}

/**
 * The two question documents agree about what is still open.
 *
 * `npm run audit:status` already *renders* this comparison into the audit, but
 * rendering a contradiction is not failing on one: the audit stayed byte-current
 * and the contradiction sat inside it. M07.7 asks for the check, so this is the
 * check.
 *
 * Only one direction is a contradiction, and the asymmetry is deliberate. The
 * plan's list is the curated short set a tranche might have to **stop** on, so a
 * question open in the file and absent from the plan is ordinary. A question the
 * plan calls open that the file has answered — or has no entry for at all — is
 * the plan asking a tranche to stop on a decision that has already been made, or
 * on one with no durable record to read.
 */
export function checkQuestionLedger(repoRoot: string): readonly ConsistencyFinding[] {
  const findings: ConsistencyFinding[] = [];
  const questions = questionsIn(readFileSync(join(repoRoot, OPEN_QUESTIONS), 'utf8'));
  const planOpen = planOpenQuestions(readFileSync(join(repoRoot, PLAN), 'utf8'));
  const byId = new Map(questions.map((entry) => [entry.id, entry]));

  for (const [id, line] of planOpen) {
    const entry = byId.get(id);
    if (entry === undefined) {
      findings.push(
        finding(
          'question-ledger',
          PLAN,
          line,
          `lists ${id} as an open owner decision, but \`${OPEN_QUESTIONS}\` has no entry for it — an open question with no durable record.`,
        ),
      );
      continue;
    }
    if (entry.answered) {
      findings.push(
        finding(
          'question-ledger',
          PLAN,
          line,
          `lists ${id} as an open owner decision, but \`${OPEN_QUESTIONS}:${entry.line}\` records it as answered.`,
        ),
      );
    }
  }

  // The same question written twice is a record that can disagree with itself.
  const seen = new Set<string>();
  for (const entry of questions) {
    if (seen.has(entry.id)) {
      findings.push(
        finding(
          'question-ledger',
          OPEN_QUESTIONS,
          entry.line,
          `has a second entry for ${entry.id}; a question has exactly one durable record.`,
        ),
      );
    }
    seen.add(entry.id);
  }

  return findings;
}

/* ------------------------------------------- 6. counts claimed in active prose */

/**
 * Count claims an active document makes, against the content they describe.
 *
 * M07.5 stripped countable facts out of `README.md` and pointed at the audit
 * instead, precisely because they drift. The handful that remain are load
 * bearing — a test protocol has to say how big the batch it describes was — so
 * they are checked rather than banned.
 */
export interface CountClaimResult {
  readonly findings: readonly ConsistencyFinding[];
  /**
   * Claims actually found and compared.
   *
   * Reported so the suite can assert it is non-zero: a count check whose
   * patterns match nothing passes for the wrong reason, and would keep passing
   * after somebody reworded the sentence it was written for.
   */
  readonly claims: number;
}

export function checkCountClaims(documents: readonly MarkdownDocument[]): CountClaimResult {
  const findings: ConsistencyFinding[] = [];
  let claims = 0;

  const waveOne = BUNDLED_FORMATS.find((format) => format.formatId === 'precon_wave_1');
  const waveOneSet = loadBundledCardData().sets.find((set) => set.setId === 'precon_wave_1');

  const patterns: {
    readonly pattern: RegExp;
    readonly expected: number | undefined;
    readonly describe: string;
  }[] = [
    {
      pattern: /(\d+)-card\s+(?:\n\s*)?Wave 1/gi,
      expected: waveOneSet?.cards.length,
      describe: 'cards in the `precon_wave_1` set',
    },
    {
      pattern: /(\d+)-card singleton/gi,
      expected: waveOne?.deck.size,
      describe: 'the `precon_wave_1` deck size',
    },
    {
      pattern: /\b(\d+) bundled precons\b/gi,
      expected: BUNDLED_PRECONS.length,
      describe: 'bundled precons',
    },
  ];

  for (const document of documents) {
    if (!isActiveDocument(document.path)) continue;
    const text = document.text;

    for (const claim of patterns) {
      for (const match of text.matchAll(claim.pattern)) {
        if (claim.expected === undefined) continue;
        claims += 1;
        const stated = Number.parseInt(match[1] ?? '', 10);
        if (stated === claim.expected) continue;
        findings.push(
          finding(
            'count-claim',
            document.path,
            lineOf(text, match.index),
            `claims ${stated} for ${claim.describe}, but the content has ${claim.expected}.`,
          ),
        );
      }
    }
  }

  return { findings, claims };
}

/* ---------------------------------------------------------------- the whole run */

export function runConsistencyChecks(repoRoot: string): ConsistencyReport {
  const documents = markdownDocuments(repoRoot);
  const links = checkMarkdownLinks(repoRoot, documents);
  const paths = checkPathReferences(repoRoot, documents);
  const values = checkDocumentedValues(repoRoot);
  const counts = checkCountClaims(documents);

  const findings = [
    ...checkRetiredTerms(documents),
    ...checkRetiredTermsInHelp(),
    ...links.findings,
    ...paths.findings,
    ...values.findings,
    ...checkUnimplementedCards(),
    ...checkInertMechanics(),
    ...checkTargetSemantics(),
    ...checkQuestionLedger(repoRoot),
    ...counts.findings,
  ];

  return {
    findings,
    ok: findings.length === 0,
    counts: {
      documents: documents.length,
      activeDocuments: documents.filter((document) => isActiveDocument(document.path)).length,
      links: links.links,
      pathReferences: paths.references,
      documentedValues: values.values,
      countClaims: counts.claims,
      playableCards: playableCardCount(),
      questions: planOpenQuestions(readFileSync(join(repoRoot, PLAN), 'utf8')).size,
    },
  };
}

/** The report as a person reads it on a terminal. */
export function formatConsistencyReport(report: ConsistencyReport): string {
  const lines: string[] = [];
  const { counts } = report;

  lines.push(
    `Checked ${counts.documents} Markdown documents (${counts.activeDocuments} active), ` +
      `${counts.links} internal links, ${counts.pathReferences} path references, ` +
      `${counts.documentedValues} documented values, ${counts.countClaims} count claims, ` +
      `${counts.playableCards} cards in playable sets, ` +
      `${counts.questions} owner decisions on the plan's short list.`,
  );

  if (report.ok) {
    lines.push('No inconsistency found.');
    return lines.join('\n');
  }

  lines.push('', `${report.findings.length} finding(s):`, '');
  for (const id of CONSISTENCY_CHECK_IDS) {
    const group = report.findings.filter((entry) => entry.check === id);
    if (group.length === 0) continue;
    lines.push(`  ${id} (${group.length}):`);
    for (const entry of group) {
      const where =
        entry.file === null ? '' : `${entry.file}${entry.line === null ? '' : `:${entry.line}`} `;
      lines.push(`    ${where}${entry.message}`);
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}
