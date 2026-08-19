import { readFileSync } from 'node:fs';
import {
  actionSchema,
  applyAction,
  createMatch,
  type Action,
  type GameEvent,
  type MatchState,
} from '@tcg/rules-engine';
import { isErr } from '@tcg/shared';
import { simDeckSchema, toMatchDeck, type SimDeck } from '@tcg/deck-generator';
import { restoreEnvironment } from './resolved-environment.js';
import { canonicalJson } from './hash.js';
import { replayBundleSchema, type ReplayBundle } from './telemetry/schema.js';

/**
 * Replaying one recorded match (readiness §9 G2).
 *
 * ## What this actually checks
 *
 * A replay bundle claims that a specific sequence of actions, applied to a
 * specific starting position, produces a specific event log and result. This
 * module re-derives all three and compares them. The comparison is the point:
 * re-running and *not* comparing would turn any divergence into a second
 * plausible-looking artefact instead of a failure.
 *
 * ## Why it cannot fall back to the card database
 *
 * The environment comes exclusively from the bundle's frozen snapshot, whose
 * hashes are verified against its own content before anything is created. There
 * is deliberately no path that reaches `loadBundledCardData()`. A bundle missing
 * a card must fail loudly, because the alternative — resolving against whatever
 * the repository holds today — is precisely the silent substitution that made
 * the old bundles untrustworthy.
 *
 * A consequence worth stating: this command reproduces a match recorded six
 * months ago even after the card has been renamed, recosted, rewritten, or
 * removed from the set entirely.
 *
 * ## Pilots are not consulted
 *
 * The recorded actions are replayed directly rather than re-asked of the pilots.
 * That keeps the check honest about what it verifies — engine determinism given
 * an action sequence — and keeps it meaningful for a bundle whose pilot has since
 * been retuned. Pilot reproducibility is a separate question, answered by the
 * `pilotInputHash` and the recorded pilot version and config hash.
 */

export interface ReplayDivergence {
  /** Where the two runs first disagree. */
  readonly kind: 'event' | 'result' | 'action_rejected' | 'action_count';
  /** Event sequence number, or the index of the action being applied. */
  readonly sequence: number;
  /** The action being applied when the divergence appeared, when there was one. */
  readonly actionIndex: number | null;
  readonly action: Action | null;
  readonly expected: string;
  readonly actual: string;
  readonly message: string;
}

export interface ReplayResult {
  readonly matchId: string;
  readonly ok: boolean;
  readonly environmentId: string;
  readonly mechanicsHash: string;
  /** Actions successfully re-applied before the comparison stopped. */
  readonly actionsApplied: number;
  readonly eventsCompared: number;
  readonly divergences: readonly ReplayDivergence[];
  /** Human-readable event trace, when `trace` was requested. */
  readonly trace: readonly string[];
  readonly state: MatchState | null;
}

export interface ReplayOptions {
  /** Collect a readable line per replayed event. */
  readonly trace?: boolean;
  /** Stop at the first divergence. Default: true. */
  readonly stopOnFirst?: boolean;
}

export function loadReplayBundle(path: string): ReplayBundle {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(
      `Could not read replay bundle "${path}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = replayBundleSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Replay bundle "${path}" is not valid:\n` +
        parsed.error.issues
          .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('\n'),
    );
  }
  return parsed.data;
}

export function replayBundle(bundle: ReplayBundle, options: ReplayOptions = {}): ReplayResult {
  const stopOnFirst = options.stopOnFirst ?? true;
  const divergences: ReplayDivergence[] = [];
  const trace: string[] = [];

  // Throws on a tampered snapshot. A bundle whose hashes disagree with its own
  // content is the one failure that must never be downgraded to a warning: every
  // other guarantee here is stated relative to that content.
  const environment = restoreEnvironment(bundle.environment);
  const { database, rulesConfig } = environment;

  const decks = bundle.decks.map((entry, index) => {
    const parsed = simDeckSchema.safeParse(entry);
    if (!parsed.success) {
      throw new Error(
        `Replay bundle "${bundle.matchId}" has an unreadable deck at seat ${index}: ` +
          parsed.error.issues.map((issue) => issue.message).join('; '),
      );
    }
    return parsed.data as SimDeck;
  });

  const seats = [...bundle.record.seats]
    .sort((left, right) => left.seatIndex - right.seatIndex)
    .map((seat) => {
      const deck = decks[seat.seatIndex];
      if (!deck) {
        throw new Error(
          `Replay bundle "${bundle.matchId}" records seat ${seat.seatIndex} ("${seat.playerId}") ` +
            'but carries no deck for it.',
        );
      }
      return { playerId: seat.playerId, name: seat.playerId, deck: toMatchDeck(deck) };
    });

  const created = createMatch({
    matchId: bundle.record.matchId,
    seed: bundle.record.seeds.matchSeed,
    database,
    config: rulesConfig,
    // Both must match the original run exactly, or the replay starts from a
    // different position and every later comparison is meaningless.
    preserveSeatOrder: true,
    seats,
  });
  if (isErr(created)) {
    throw new Error(
      `Replaying "${bundle.matchId}" could not recreate the match: ` +
        `${created.error.code} — ${created.error.message}`,
    );
  }

  const expectedEvents = bundle.events.map((event) => event as GameEvent);
  let state = created.value.state;
  const produced: GameEvent[] = [...created.value.events];

  const compareFrom = (cursor: number, actionIndex: number | null, action: Action | null): void => {
    for (let index = cursor; index < produced.length; index += 1) {
      const actual = produced[index] as GameEvent;
      if (options.trace) trace.push(describeEvent(actual));
      const expected = expectedEvents[index];
      if (expected === undefined) {
        divergences.push({
          kind: 'event',
          sequence: sequenceOf(actual, index),
          actionIndex,
          action,
          expected: '(no further recorded events)',
          actual: canonicalJson(actual),
          message: `The replay produced event ${index + 1}, but the bundle recorded only ${expectedEvents.length}.`,
        });
        return;
      }
      const expectedJson = canonicalJson(expected);
      const actualJson = canonicalJson(actual);
      if (expectedJson === actualJson) continue;
      divergences.push({
        kind: 'event',
        sequence: sequenceOf(actual, index),
        actionIndex,
        action,
        expected: expectedJson,
        actual: actualJson,
        message: `Event ${index + 1} differs from the recorded log.`,
      });
      return;
    }
  };

  compareFrom(0, null, null);

  let applied = 0;
  for (const [index, rawAction] of bundle.actions.entries()) {
    if (divergences.length > 0 && stopOnFirst) break;

    const parsedAction = actionSchema.safeParse(rawAction);
    if (!parsedAction.success) {
      divergences.push({
        kind: 'action_rejected',
        sequence: state.sequence,
        actionIndex: index,
        action: null,
        expected: 'a valid recorded action',
        actual: canonicalJson(rawAction),
        message:
          `Recorded action ${index} does not parse against the current action schema: ` +
          parsedAction.error.issues.map((issue) => issue.message).join('; '),
      });
      break;
    }
    const action = parsedAction.data as Action;

    const cursor = produced.length;
    const result = applyAction(state, action, { database, config: rulesConfig });
    if (isErr(result)) {
      // The engine accepted this exact action during the original run. Rejecting
      // it now means the engine's behaviour moved, which is the single most
      // valuable thing a replay can catch.
      divergences.push({
        kind: 'action_rejected',
        sequence: state.sequence,
        actionIndex: index,
        action,
        expected: 'the action to be accepted, as it was when recorded',
        actual: `${result.error.code}: ${result.error.message}`,
        message: `The engine rejected recorded action ${index} (${action.type}).`,
      });
      break;
    }

    state = result.value.state;
    produced.push(...result.value.events);
    applied += 1;
    compareFrom(cursor, index, action);
  }

  if (divergences.length === 0 || !stopOnFirst) {
    if (produced.length < expectedEvents.length) {
      divergences.push({
        kind: 'event',
        sequence: produced.length,
        actionIndex: null,
        action: null,
        expected: canonicalJson(expectedEvents[produced.length]),
        actual: '(the replay stopped producing events)',
        message: `The bundle records ${expectedEvents.length} events; the replay produced ${produced.length}.`,
      });
    }
    if (applied !== bundle.actions.length) {
      divergences.push({
        kind: 'action_count',
        sequence: state.sequence,
        actionIndex: applied,
        action: null,
        expected: `${bundle.actions.length} action(s)`,
        actual: `${applied} action(s)`,
        message: 'The replay did not consume every recorded action.',
      });
    }

    // The result is checked separately from the events because a match can agree
    // event-for-event and still end differently if the final state-based check
    // changed — and "who won" is the claim a reader takes away from the record.
    const outcome = state.result?.outcome ?? 'none';
    const winnerId = state.result?.winnerId ?? null;
    const reason = state.result?.reason ?? null;
    const expectedResult = {
      outcome: bundle.record.outcome,
      winnerId: bundle.record.winnerId,
      reason: bundle.record.endReason,
      turns: bundle.record.turns,
    };
    const actualResult = { outcome, winnerId, reason, turns: state.turn };
    if (canonicalJson(expectedResult) !== canonicalJson(actualResult)) {
      divergences.push({
        kind: 'result',
        sequence: state.sequence,
        actionIndex: null,
        action: null,
        expected: canonicalJson(expectedResult),
        actual: canonicalJson(actualResult),
        message: 'The replayed match ended differently from the recorded one.',
      });
    }
  }

  return {
    matchId: bundle.matchId,
    ok: divergences.length === 0,
    environmentId: bundle.environment.environmentId,
    mechanicsHash: bundle.environment.hashes.mechanicsHash,
    actionsApplied: applied,
    eventsCompared: Math.min(produced.length, expectedEvents.length),
    divergences,
    trace,
    state,
  };
}

export function replayFile(path: string, options: ReplayOptions = {}): ReplayResult {
  return replayBundle(loadReplayBundle(path), options);
}

/** The report a divergence deserves: what, where, expected, actual. */
export function formatReplayResult(result: ReplayResult): string {
  const lines: string[] = [
    `match:       ${result.matchId}`,
    `environment: ${result.environmentId} (mechanics ${result.mechanicsHash})`,
    `actions:     ${result.actionsApplied} applied`,
    `events:      ${result.eventsCompared} compared`,
  ];

  if (result.ok) {
    lines.push('', 'Reproduced exactly: events and result match the recorded bundle.');
    return lines.join('\n');
  }

  const first = result.divergences[0] as ReplayDivergence;
  lines.push('', `DIVERGED (${result.divergences.length} difference(s)). First divergence:`, '');
  lines.push(`  kind:     ${first.kind}`);
  lines.push(`  sequence: ${first.sequence}`);
  if (first.actionIndex !== null) {
    lines.push(`  action:   #${first.actionIndex}${first.action ? ` (${first.action.type})` : ''}`);
    if (first.action) lines.push(`            ${canonicalJson(first.action)}`);
  }
  lines.push(`  expected: ${first.expected}`);
  lines.push(`  actual:   ${first.actual}`);
  lines.push('', `  ${first.message}`);
  return lines.join('\n');
}

function sequenceOf(event: GameEvent, fallback: number): number {
  const sequence = (event as { sequence?: unknown }).sequence;
  return typeof sequence === 'number' ? sequence : fallback;
}

function describeEvent(event: GameEvent): string {
  const sequence = (event as { sequence?: unknown }).sequence;
  const prefix = typeof sequence === 'number' ? String(sequence).padStart(5, ' ') : '    ?';
  return `${prefix}  ${event.type}  ${canonicalJson(event)}`;
}
