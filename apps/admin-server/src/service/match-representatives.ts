import {
  adminError,
  matchRepresentativesViewSchema,
  REPRESENTATIVE_MATCH_KINDS,
  type AbnormalMatchEntry,
  type AbnormalMatchList,
  type AdaptiveExperimentId,
  type AdminError,
  type MatchRepresentativesRequest,
  type MatchRepresentativesView,
  type RepresentativeMatch,
  type RepresentativeMatchEntry,
  type RepresentativeMatchKind,
} from '@tcg/admin-contracts';
import { err, isErr, ok, type Result } from '@tcg/shared';
import {
  filterLiveMatches,
  proportionDifference,
  readLiveMatchEnvelopes,
  seededIndex,
} from '@tcg/simulator';

import { type ResolvedCatalogRoots } from '../catalog/roots.js';
import { AdaptiveResultReader } from './adaptive-results.js';
import { decodeRowCursor, encodeRowCursor } from './results.js';

/**
 * M08.26E — the Match Representatives read model. See `match-representatives.ts`
 * (`@tcg/admin-contracts`) for the full design rationale (the matchup-strength
 * proxy for closest/upset/one-sided, the abandoned-`abnormal` restatement, the
 * seeded ordinary sample, and the named-experiment pre-adaptation lookup) —
 * this file is the thin execution of that design over exactly the evidence
 * `match-explorer.ts` already reads.
 */

type LiveMatchEnvelope = ReturnType<typeof readLiveMatchEnvelopes>['matches'][number];

/** Restates the three `LIVE_MATCH_TERMINATION_ORIGINS` nobody chose and the rules never concluded. See contract doc comment. */
const ABNORMAL_TERMINATION_ORIGINS = [
  'disconnect_timeout',
  'server_failure',
  'abandoned_unrecordable',
] as const;

function isAbnormalOrigin(origin: string): boolean {
  return (ABNORMAL_TERMINATION_ORIGINS as readonly string[]).includes(origin);
}

function liveMatchEvidenceOf(match: LiveMatchEnvelope) {
  return {
    realm: 'live_match' as const,
    source: match.source,
    contentVersion: match.provenance.contentVersion,
    rulesVersion: match.provenance.rulesVersion,
  };
}

function refOf(match: LiveMatchEnvelope): { kind: 'match'; matchId: string } {
  return { kind: 'match', matchId: match.matchId };
}

/** Exported only so tests can prove selection is independent of input order without depending on a filesystem's own directory-listing order (never guaranteed — see `betterCandidate`'s doc comment). */
export function decisiveMatchesOf(matches: readonly LiveMatchEnvelope[]): LiveMatchEnvelope[] {
  return matches.filter(
    (match) =>
      match.outcome !== null && match.outcome.outcome === 'win' && match.outcome.winnerId !== null,
  );
}

/** `{winner, loser}` seats of a decisive match — never called on anything `decisiveMatchesOf` did not select. */
function decisiveSeatsOf(match: LiveMatchEnvelope) {
  const winnerId = match.outcome!.winnerId!;
  const [seatA, seatB] = match.seats;
  const winner = seatA.playerId === winnerId ? seatA : seatB;
  const loser = winner === seatA ? seatB : seatA;
  return { winner, loser };
}

interface CommanderRecord {
  wins: number;
  total: number;
}

/** Each Commander's overall decisive win/loss record across the filtered set — the input `proportion()` needs, never a per-match margin (there is none). Exported for the same order-independence testing reason as `decisiveMatchesOf`. */
export function commanderRecordsOf(
  decisive: readonly LiveMatchEnvelope[],
): Map<string, CommanderRecord> {
  const records = new Map<string, CommanderRecord>();
  for (const match of decisive) {
    const { winner, loser } = decisiveSeatsOf(match);
    for (const [seat, won] of [
      [winner, true],
      [loser, false],
    ] as const) {
      const record = records.get(seat.deck.commanderId) ?? { wins: 0, total: 0 };
      record.total += 1;
      if (won) record.wins += 1;
      records.set(seat.deck.commanderId, record);
    }
  }
  return records;
}

/** `proportionDifference(winnerRecord, loserRecord).point` — positive when the winner was the overall favourite, negative when the underdog won. See contract doc comment. */
function skewOf(match: LiveMatchEnvelope, records: ReadonlyMap<string, CommanderRecord>): number {
  const { winner, loser } = decisiveSeatsOf(match);
  const winnerRecord = records.get(winner.deck.commanderId)!;
  const loserRecord = records.get(loser.deck.commanderId)!;
  return proportionDifference(
    { successes: winnerRecord.wins, total: winnerRecord.total },
    { successes: loserRecord.wins, total: loserRecord.total },
  ).point;
}

interface Candidate {
  readonly match: LiveMatchEnvelope;
  readonly skew: number;
  /** The value `prefer` actually orders on — not always `skew` itself (e.g. `closest` orders on `|skew|`). Tie-breaking must compare this, not `skew`, or equal-magnitude opposite-sign candidates never reach the `matchId` tie-break. */
  readonly key: number;
}

function betterCandidate(
  candidate: Candidate,
  best: Candidate | null,
  prefer: (key: number, bestKey: number) => boolean,
): boolean {
  if (best === null) return true;
  if (candidate.key !== best.key) return prefer(candidate.key, best.key);
  return candidate.match.matchId < best.match.matchId;
}

/** Exported for the same order-independence testing reason as `decisiveMatchesOf`. */
export function selectClosest(
  decisive: readonly LiveMatchEnvelope[],
  records: ReadonlyMap<string, CommanderRecord>,
): Candidate | null {
  let best: Candidate | null = null;
  for (const match of decisive) {
    const skew = skewOf(match, records);
    const candidate: Candidate = { match, skew, key: Math.abs(skew) };
    if (betterCandidate(candidate, best, (key, bestKey) => key < bestKey)) best = candidate;
  }
  return best;
}

function selectLargestUpset(
  decisive: readonly LiveMatchEnvelope[],
  records: ReadonlyMap<string, CommanderRecord>,
): Candidate | null {
  let best: Candidate | null = null;
  for (const match of decisive) {
    const skew = skewOf(match, records);
    if (skew >= 0) continue;
    const candidate: Candidate = { match, skew, key: skew };
    if (betterCandidate(candidate, best, (key, bestKey) => key < bestKey)) best = candidate;
  }
  return best;
}

function selectMostOneSided(
  decisive: readonly LiveMatchEnvelope[],
  records: ReadonlyMap<string, CommanderRecord>,
): Candidate | null {
  let best: Candidate | null = null;
  for (const match of decisive) {
    const skew = skewOf(match, records);
    if (skew <= 0) continue;
    const candidate: Candidate = { match, skew, key: skew };
    if (betterCandidate(candidate, best, (key, bestKey) => key > bestKey)) best = candidate;
  }
  return best;
}

function selectByActionCount(
  pool: readonly LiveMatchEnvelope[],
  prefer: (count: number, bestCount: number) => boolean,
): LiveMatchEnvelope | null {
  let best: LiveMatchEnvelope | null = null;
  for (const match of pool) {
    if (
      best === null ||
      prefer(match.actionCount, best.actionCount) ||
      (match.actionCount === best.actionCount && match.matchId < best.matchId)
    ) {
      best = match;
    }
  }
  return best;
}

function selectRandomOrdinary(matches: readonly LiveMatchEnvelope[]): LiveMatchEnvelope | null {
  const pool = matches.filter(
    (match) => match.outcome !== null && !isAbnormalOrigin(match.terminationOrigin),
  );
  if (pool.length === 0) return null;

  const sortedIds = pool.map((match) => match.matchId).sort();
  const seed = `match-representatives:random_ordinary|${sortedIds.join(',')}`;
  const index = seededIndex(seed, sortedIds.length);
  const chosenId = sortedIds[index];
  return pool.find((match) => match.matchId === chosenId) ?? null;
}

/** One `'revisions'` row, coerced permissively — mirrors `deck-explorer.ts`'s own `revisionOf`. */
interface RevisionLike {
  readonly side: 'incumbent' | 'opponent';
  readonly revisionId: string;
  readonly parentRevisionId: string | null;
  readonly generation: number;
  readonly deckHash: string;
}

async function readRevisions(
  adaptive: AdaptiveResultReader,
  experimentId: AdaptiveExperimentId,
): Promise<Result<RevisionLike[], readonly AdminError[]>> {
  const revisions: RevisionLike[] = [];
  let cursor: string | null = null;

  for (;;) {
    const page = await adaptive.readTable(experimentId, 'revisions', { limit: 200, cursor });
    if (isErr(page)) return page;

    for (const row of page.value.rows) {
      revisions.push({
        side: row.side === 'opponent' ? 'opponent' : 'incumbent',
        revisionId: String(row.revisionId ?? ''),
        parentRevisionId:
          row.parentRevisionId === null || row.parentRevisionId === undefined
            ? null
            : String(row.parentRevisionId),
        generation: Number(row.generation ?? 0),
        deckHash: String(row.deckHash ?? ''),
      });
    }

    cursor = page.value.page.nextCursor;
    if (cursor === null) break;
  }

  return ok(revisions);
}

interface PreAdaptationCandidate {
  readonly match: LiveMatchEnvelope;
  readonly side: RevisionLike['side'];
  readonly revision: RevisionLike;
  readonly supersededBy: string;
}

/**
 * The last live match played with a deck revision before its lineage
 * advanced past it, or `null` when the named experiment has no superseded
 * revision in either lineage, or no live match ever played the superseded
 * deck hash. See contract doc comment.
 */
async function selectPreAdaptation(
  adaptive: AdaptiveResultReader,
  experimentId: AdaptiveExperimentId,
  matches: readonly LiveMatchEnvelope[],
): Promise<Result<PreAdaptationCandidate | null, readonly AdminError[]>> {
  const revisions = await readRevisions(adaptive, experimentId);
  if (isErr(revisions)) return revisions;

  let boundary: { readonly revision: RevisionLike; readonly supersededBy: string } | null = null;
  for (const candidate of revisions.value) {
    const successor = revisions.value.find(
      (row) => row.side === candidate.side && row.parentRevisionId === candidate.revisionId,
    );
    if (successor === undefined) continue;
    if (
      boundary === null ||
      candidate.generation > boundary.revision.generation ||
      (candidate.generation === boundary.revision.generation &&
        candidate.side < boundary.revision.side) ||
      (candidate.generation === boundary.revision.generation &&
        candidate.side === boundary.revision.side &&
        candidate.revisionId < boundary.revision.revisionId)
    ) {
      boundary = { revision: candidate, supersededBy: successor.revisionId };
    }
  }
  if (boundary === null) return ok(null);

  let lastMatch: LiveMatchEnvelope | null = null;
  for (const match of matches) {
    if (!match.seats.some((seat) => seat.deck.deckHash === boundary.revision.deckHash)) continue;
    if (lastMatch === null || match.matchId > lastMatch.matchId) lastMatch = match;
  }
  if (lastMatch === null) return ok(null);

  return ok({
    match: lastMatch,
    side: boundary.revision.side,
    revision: boundary.revision,
    supersededBy: boundary.supersededBy,
  });
}

function representativeOf(
  kind: RepresentativeMatchKind,
  match: LiveMatchEnvelope,
  reason: string,
): RepresentativeMatch {
  return { kind, ref: refOf(match), observedIn: liveMatchEvidenceOf(match), reason };
}

const PERCENT = (value: number): string => `${(value * 100).toFixed(1)}%`;

async function buildRepresentatives(
  adaptive: AdaptiveResultReader,
  matches: readonly LiveMatchEnvelope[],
  adaptiveExperimentId: AdaptiveExperimentId | null,
): Promise<Result<RepresentativeMatchEntry[], readonly AdminError[]>> {
  const decisive = decisiveMatchesOf(matches);
  const records = commanderRecordsOf(decisive);

  const entries = new Map<RepresentativeMatchKind, RepresentativeMatch | null>();

  const closest = selectClosest(decisive, records);
  entries.set(
    'closest',
    closest === null
      ? null
      : representativeOf(
          'closest',
          closest.match,
          `The winning and losing Commanders' overall win rates in this filter differ by only ${PERCENT(Math.abs(closest.skew))}, the smallest matchup-strength gap of any decisive match here.`,
        ),
  );

  const upset = selectLargestUpset(decisive, records);
  entries.set(
    'largest_upset',
    upset === null
      ? null
      : representativeOf(
          'largest_upset',
          upset.match,
          `The winner's Commander held a lower overall win rate than the loser's by ${PERCENT(Math.abs(upset.skew))} — the largest upset, by matchup strength, of any decisive match here.`,
        ),
  );

  const oneSided = selectMostOneSided(decisive, records);
  entries.set(
    'most_one_sided',
    oneSided === null
      ? null
      : representativeOf(
          'most_one_sided',
          oneSided.match,
          `The winner's Commander held a higher overall win rate than the loser's by ${PERCENT(oneSided.skew)} — the largest favourite-wins-as-expected gap of any decisive match here.`,
        ),
  );

  const completed = matches.filter((match) => match.outcome !== null);
  const shortest = selectByActionCount(completed, (count, bestCount) => count < bestCount);
  entries.set(
    'shortest',
    shortest === null
      ? null
      : representativeOf(
          'shortest',
          shortest,
          `Shortest completed match in this filter: ${String(shortest.actionCount)} actions.`,
        ),
  );

  const longest = selectByActionCount(completed, (count, bestCount) => count > bestCount);
  entries.set(
    'longest',
    longest === null
      ? null
      : representativeOf(
          'longest',
          longest,
          `Longest completed match in this filter: ${String(longest.actionCount)} actions.`,
        ),
  );

  if (adaptiveExperimentId === null) {
    entries.set('pre_adaptation', null);
  } else {
    const preAdaptation = await selectPreAdaptation(adaptive, adaptiveExperimentId, matches);
    if (isErr(preAdaptation)) return preAdaptation;
    entries.set(
      'pre_adaptation',
      preAdaptation.value === null
        ? null
        : representativeOf(
            'pre_adaptation',
            preAdaptation.value.match,
            `Last live match played with the ${preAdaptation.value.side} lineage's revision \`${preAdaptation.value.revision.revisionId}\` (generation ${String(preAdaptation.value.revision.generation)}) before experiment \`${adaptiveExperimentId}\` superseded it with \`${preAdaptation.value.supersededBy}\`.`,
          ),
    );
  }

  const randomOrdinary = selectRandomOrdinary(matches);
  entries.set(
    'random_ordinary',
    randomOrdinary === null
      ? null
      : representativeOf(
          'random_ordinary',
          randomOrdinary,
          'Deterministically sampled ordinary (non-abnormal, completed) match from this filter — the same filter always reproduces the same pick.',
        ),
  );

  return ok(REPRESENTATIVE_MATCH_KINDS.map((kind) => ({ kind, match: entries.get(kind) ?? null })));
}

function abnormalReasonOf(origin: string): string {
  switch (origin) {
    case 'disconnect_timeout':
      return 'Terminated by a disconnect timeout — nobody conceded and the rules never concluded the match.';
    case 'server_failure':
      return 'Terminated by a server-side engine error — the rules never concluded the match.';
    case 'abandoned_unrecordable':
      return 'Abandoned before any recordable outcome — no `MatchResult` exists for this match.';
    default:
      return `Terminated by \`${origin}\`, one of this filter's abnormal termination origins.`;
  }
}

function readAbnormalMatches(
  matches: readonly LiveMatchEnvelope[],
  page: MatchRepresentativesRequest['page'],
): Result<AbnormalMatchList, readonly AdminError[]> {
  const abnormal = matches
    .filter((match) => isAbnormalOrigin(match.terminationOrigin))
    .sort((left, right) => (left.matchId < right.matchId ? -1 : 1));

  let offset = 0;
  if (page.cursor !== null) {
    const decoded = decodeRowCursor(page.cursor);
    if (isErr(decoded)) return decoded;
    offset = decoded.value;
  }

  const items: AbnormalMatchEntry[] = abnormal.slice(offset, offset + page.limit).map((match) => ({
    ref: refOf(match),
    observedIn: liveMatchEvidenceOf(match),
    reason: abnormalReasonOf(match.terminationOrigin),
  }));
  const consumed = offset + items.length;

  return ok({
    items,
    page: {
      returned: items.length,
      limit: page.limit,
      nextCursor: consumed < abnormal.length ? encodeRowCursor(consumed) : null,
      total: abnormal.length,
    },
  });
}

async function readMatchRepresentativesView(
  rootDirectory: string,
  adaptive: AdaptiveResultReader,
  request: MatchRepresentativesRequest,
): Promise<Result<MatchRepresentativesView, readonly AdminError[]>> {
  const { matches } = readLiveMatchEnvelopes(rootDirectory);
  const filtered = filterLiveMatches(matches, request.filter);

  const representatives = await buildRepresentatives(
    adaptive,
    filtered,
    request.adaptiveExperimentId,
  );
  if (isErr(representatives)) return representatives;

  const abnormalMatches = readAbnormalMatches(filtered, request.page);
  if (isErr(abnormalMatches)) return abnormalMatches;

  const parsed = matchRepresentativesViewSchema.safeParse({
    adaptiveExperimentId: request.adaptiveExperimentId,
    representatives: representatives.value,
    abnormalMatches: abnormalMatches.value,
  });
  if (!parsed.success) return err([builtBadly('match-representatives-view')]);
  return ok(parsed.data);
}

/* ---------------------------------------------------------- the HTTP reader */

export interface MatchRepresentativesReaderOptions {
  readonly roots: ResolvedCatalogRoots;
  readonly resultRootId: string;
}

/**
 * The thin HTTP-facing layer for M08.26E's `match-representatives` address,
 * reading live-match evidence out of the same server-configured default
 * result root every other explorer reads, and — only when a caller names one
 * — revision lineage out of an `AdaptiveResultReader` over that named
 * experiment, exactly as `DeckExplorerReader` already does.
 */
export class MatchRepresentativesReader {
  readonly #roots: ResolvedCatalogRoots;
  readonly #resultRootId: string;
  readonly #adaptive: AdaptiveResultReader;

  constructor(options: MatchRepresentativesReaderOptions) {
    this.#roots = options.roots;
    this.#resultRootId = options.resultRootId;
    this.#adaptive = new AdaptiveResultReader(options);
  }

  async readView(
    request: MatchRepresentativesRequest,
  ): Promise<Result<MatchRepresentativesView, readonly AdminError[]>> {
    const directory = this.#resolve();
    if (isErr(directory)) return directory;
    return readMatchRepresentativesView(directory.value, this.#adaptive, request);
  }

  #resolve(): Result<string, readonly AdminError[]> {
    const configured = this.#roots.resultRoots.get(this.#resultRootId);
    if (configured === undefined) {
      return err([
        adminError(
          'admin/unsafe_result_reference',
          `No result root named \`${this.#resultRootId}\` is configured, so Match Representatives cannot be read.`,
          { path: 'resultRootId', context: { rootId: this.#resultRootId } },
        ),
      ]);
    }
    return ok(configured);
  }
}

function builtBadly(what: string): AdminError {
  return adminError(
    'admin/schema',
    'This service built a Match Representatives view it could not validate against its own contract, ' +
      'so it was not sent. This is a defect in the build rather than a problem with the underlying matches.',
    { context: { view: what } },
  );
}
