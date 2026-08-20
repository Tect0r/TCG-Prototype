import { describe, expect, it } from 'vitest';
import {
  AVAILABLE_DIFFICULTIES,
  BOT_CONFIG_SCHEMA_VERSION,
  DEFAULT_BOT_DIFFICULTY,
  difficultyDefinition,
  DIFFICULTY_REGISTRY_VERSION,
  EASY_SELECTION,
  IMMEDIATE_BOT_PACING,
  type BotSeatConfig,
  type BotStyle,
} from '@tcg/bot-config';
import {
  createPilot,
  createRandomLegalPilot,
  type BotObservation,
  type BotPolicy,
} from '@tcg/bot-interface';
import { loadFormatCardData, resolveFormatId } from '@tcg/card-data';
import { deckFormatOf } from '@tcg/deck';
import {
  CURRENT_VERSIONS,
  encode,
  type ClientMessageInput,
  type ServerMessage,
} from '@tcg/protocol';
import {
  createRngState,
  DEFAULT_RULES_CONFIG,
  legalActions,
  playerView,
  type LegalActions,
  type MatchState,
  type PlayerId,
  type RngState,
} from '@tcg/rules-engine';
import {
  ACTIONS_A_LIVE_BOT_NEVER_SUBMITS,
  botSeedFor,
  BotRunner,
  createBotPilot,
  hasBotDecision,
  type BotRunReport,
} from './bot-runner.js';
import { MatchServer, type ServerConnection } from './match-server.js';

/**
 * The immediate authoritative bot runner (M09.4).
 *
 * The six claims under test are the tranche's own: one pilot and one independent
 * stream per bot seat; every eligible decision taken exactly once, with no
 * duplicate action identity; the observation rebuilt at decision time and the
 * answer revalidated before submission; failure and fallback recorded rather than
 * disguised as an intentional play; no ordinary concession and no bot-originated
 * `server_timeout`; and a long match that is stack-safe and cancelled cleanly at
 * completion.
 *
 * Most of it is driven the way a real match is — messages in, and a scripted
 * opponent that decides from its own seat's legality — so what is being tested is
 * the live path rather than a fixture of it. `whenBotsIdle` is the one concession
 * to the fact that a bot decision is asynchronous while `receive` is not: a test
 * that looked at the board immediately would be reading it mid-turn.
 *
 * Two seeds are named rather than arbitrary. `BOT_FIRST_SEED` and
 * `HUMAN_FIRST_SEED` put each side on the first turn, and both produce matches in
 * which the bot answers a mulligan, a pending choice, a Reaction window, an
 * attack, a block and a Main Phase — which is how "pending choice" and "Reaction"
 * are covered by a real game rather than by a hand-built board. The bot plays
 * `precon_containment_control` because it is the deck that actually holds
 * Reaction cards; a window only opens when somebody could use it.
 */

const shipping = loadFormatCardData(resolveFormatId());
if (!shipping.ok) throw new Error('The shipping format did not resolve to a card pool.');
const { database, format } = shipping.value;
const deckFormat = deckFormatOf(format);
const config = DEFAULT_RULES_CONFIG;

const BOT_PRECON_ID = 'precon_containment_control';
const HUMAN_PRECON_ID = 'precon_bastion_guardians';

/** The bot takes the first turn. */
const BOT_FIRST_SEED = 's1';
/** The human takes the first turn. */
const HUMAN_FIRST_SEED = 's6';

function botSetup(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: BOT_CONFIG_SCHEMA_VERSION,
    difficultyRegistryVersion: DIFFICULTY_REGISTRY_VERSION,
    difficulty: DEFAULT_BOT_DIFFICULTY,
    style: 'value' as const,
    deck: { mode: 'exact_precon' as const, preconId: BOT_PRECON_ID },
    pacing: IMMEDIATE_BOT_PACING,
    displayName: null,
    ...overrides,
  };
}

class FakeConnection implements ServerConnection {
  readonly sent: ServerMessage[] = [];
  closed = false;

  constructor(readonly id: string) {}

  send(message: ServerMessage): void {
    this.sent.push(message);
  }

  close(): void {
    this.closed = true;
  }

  last<T extends ServerMessage['type']>(type: T): Extract<ServerMessage, { type: T }> | undefined {
    for (let i = this.sent.length - 1; i >= 0; i -= 1) {
      const message = this.sent[i];
      if (message?.type === type) return message as Extract<ServerMessage, { type: T }>;
    }
    return undefined;
  }
}

interface Harness {
  readonly server: MatchServer;
  readonly host: FakeConnection;
  readonly inviteCode: string;
  /** How many times a bot crossed the stack-safety boundary between decisions. */
  readonly yields: { count: number };
  send(connection: FakeConnection, message: ClientMessageInput): void;
  state(): MatchState | null;
  report(): BotRunReport | undefined;
}

interface HarnessOptions {
  readonly seed?: string;
  readonly botDecisionLimit?: number;
  readonly pilot?: BotPolicy;
}

/** A lobby with the host seated, ready for a bot. */
function createHarness(options: HarnessOptions = {}): Harness {
  let counter = 0;
  const yields = { count: 0 };
  const pilot = options.pilot;
  const server = new MatchServer({
    database,
    deckFormat,
    random: () => {
      counter += 1;
      return ((counter * 2654435761) % 4294967296) / 4294967296;
    },
    schedule: () => () => {},
    seedFor: () => options.seed ?? BOT_FIRST_SEED,
    now: () => 1_000_000,
    yieldToScheduler: () => {
      yields.count += 1;
      return Promise.resolve();
    },
    ...(options.botDecisionLimit === undefined
      ? {}
      : { botDecisionLimit: options.botDecisionLimit }),
    ...(pilot === undefined ? {} : { botPilotFor: () => pilot }),
  });

  const send = (connection: FakeConnection, message: ClientMessageInput): void => {
    server.receive(connection, encode(message as never));
  };

  const host = new FakeConnection('conn_host');
  server.connect(host);
  send(host, {
    type: 'create_lobby',
    versions: CURRENT_VERSIONS,
    displayName: 'Host',
    maxSeats: 2,
  });
  const joined = host.last('lobby_joined');
  if (!joined) throw new Error('The host did not create a lobby.');

  const inviteCode = joined.lobby.inviteCode;
  return {
    server,
    host,
    inviteCode,
    yields,
    send,
    state: () => server.lobbyByCode(inviteCode)?.state ?? null,
    report: () => server.botReport(inviteCode),
  };
}

/** Seats the bot, submits the human's precon and readies up — the match starts. */
function startBotMatch(harness: Harness, setup = botSetup()): void {
  harness.send(harness.host, { type: 'add_bot', setup });
  harness.send(harness.host, { type: 'submit_precon', preconId: HUMAN_PRECON_ID });
  harness.send(harness.host, { type: 'set_ready', ready: true });
}

/**
 * A scripted opponent for the human seat.
 *
 * It reads the authoritative state through the same test accessor the other
 * server suites use, computes its **own** seat's legality, and submits through
 * `submit_action` — so the bot is playing a real socket-shaped opponent rather
 * than a fixture, and every human move takes the ordinary path.
 */
class ScriptedHuman {
  readonly #pilot = createPilot({ id: 'aggressive' });
  #rng: RngState;
  #decisions = 0;

  constructor(
    private readonly harness: Harness,
    private readonly playerId: PlayerId = 'player_1',
    seed = 'scripted-human',
  ) {
    this.#rng = createRngState(seed);
  }

  get decisions(): number {
    return this.#decisions;
  }

  /** One move if the engine is offering this seat one. Says whether it acted. */
  act(state: MatchState): boolean {
    const legal = legalActions(state, this.playerId, { database, config });
    if (!hasBotDecision(legal)) return false;

    const view = playerView(state, this.playerId, database, config);
    const observation: BotObservation = {
      view,
      legal,
      history: view.log,
      database,
      rulesConfig: config,
      decisionIndex: this.#decisions,
    };
    const decision = this.#pilot.decide(observation, this.#rng);
    if (decision instanceof Promise) throw new Error('The scripted human must be synchronous.');
    this.#rng = decision.rng;
    this.#decisions += 1;

    this.harness.send(this.harness.host, {
      type: 'submit_action',
      actionId: `human_${this.#decisions}`,
      lastSequence: state.sequence,
      action: decision.action,
    });
    return true;
  }
}

/** Plays the match out until it completes or nothing can move it forward. */
async function playToCompletion(harness: Harness, human = new ScriptedHuman(harness)) {
  for (let step = 0; step < 5000; step += 1) {
    await harness.server.whenBotsIdle();
    const state = harness.state();
    if (!state || state.status === 'complete') return { state, human, blocked: false };
    if (!human.act(state)) {
      // The bot is idle and the human has nothing either: the match cannot move.
      return { state, human, blocked: true };
    }
  }
  throw new Error('The match did not finish inside 5000 human turns.');
}

/** Every `LegalActions` field zeroed, for the eligibility table below. */
function noLegalActions(overrides: Partial<LegalActions> = {}): LegalActions {
  return {
    playerId: 'player_2',
    canConcede: true,
    mulligan: null,
    playableCards: [],
    activatableAbilities: [],
    canPassPhase: false,
    attacking: null,
    blocking: null,
    reaction: null,
    awaitingDefenders: [],
    pendingChoice: null,
    eliminated: false,
    ...overrides,
  };
}

function botConfigFor(style: BotStyle): BotSeatConfig {
  return {
    schemaVersion: BOT_CONFIG_SCHEMA_VERSION,
    difficultyRegistryVersion: DIFFICULTY_REGISTRY_VERSION,
    controller: { botId: 'bot_1', displayName: 'Bot 2' },
    difficulty: DEFAULT_BOT_DIFFICULTY,
    style,
    deck: { mode: 'exact_precon', preconId: BOT_PRECON_ID },
    pacing: IMMEDIATE_BOT_PACING,
  };
}

/** A pilot that always answers with the same thing, whatever it was asked. */
function stubPilot(decide: BotPolicy['decide']): BotPolicy {
  return { id: 'stub', version: '0.0.0', config: Object.freeze({}), decide };
}

/* ------------------------------------------------------- a complete match */

describe('a bot plays a whole live match', () => {
  it('finishes a 1v1 against a scripted human, acting through the ordinary path', async () => {
    const harness = createHarness();
    startBotMatch(harness);

    const { state, blocked } = await playToCompletion(harness);
    expect(blocked).toBe(false);
    expect(state?.status).toBe('complete');
    expect(state?.result).not.toBeNull();

    const report = harness.report();
    const bot = report?.seats[0];
    expect(report?.seats).toHaveLength(1);
    expect(bot?.seatId).toBe('seat_2');
    expect(bot?.playerId).toBe('player_2');
    expect(bot?.pilotId).toBe('value');
    expect(bot?.decisions).toBeGreaterThan(10);
    expect(bot?.halted).toBeNull();
    expect(report?.stalled).toBeNull();
    expect(report?.crashed).toBeNull();
    expect(report?.incidents).toEqual([]);
  });

  it('answers every decision surface the engine can present, including a Reaction', async () => {
    const harness = createHarness();
    startBotMatch(harness);
    await playToCompletion(harness);

    const actions = harness.report()?.seats[0]?.actions ?? {};
    // A real game rather than a hand-built board: the mulligan, the Main Phase,
    // combat on both sides, a pending choice and an open Reaction window all
    // happened, and the bot answered each of them.
    expect(actions.mulligan).toBeGreaterThan(0);
    expect(actions.pass_phase).toBeGreaterThan(0);
    expect(actions.play_card).toBeGreaterThan(0);
    expect(actions.declare_attackers).toBeGreaterThan(0);
    expect(actions.assign_blockers).toBeGreaterThan(0);
    expect(actions.submit_choice).toBeGreaterThan(0);
    expect((actions.play_reaction ?? 0) + (actions.pass_reaction ?? 0)).toBeGreaterThan(0);
  });

  it('plays out whichever side takes the first turn', async () => {
    const botFirst = createHarness({ seed: BOT_FIRST_SEED });
    startBotMatch(botFirst);
    expect(botFirst.state()?.activePlayerId).toBe('player_2');
    const first = await playToCompletion(botFirst);
    expect(first.state?.status).toBe('complete');
    expect(botFirst.report()?.incidents).toEqual([]);

    const humanFirst = createHarness({ seed: HUMAN_FIRST_SEED });
    startBotMatch(humanFirst);
    expect(humanFirst.state()?.activePlayerId).toBe('player_1');
    const second = await playToCompletion(humanFirst);
    expect(second.state?.status).toBe('complete');
    expect(humanFirst.report()?.incidents).toEqual([]);
  });

  it('acts before the human has done anything, at the mulligan', async () => {
    const harness = createHarness();
    startBotMatch(harness);
    await harness.server.whenBotsIdle();

    // Nothing has been submitted from the human seat, and the bot has already
    // answered its own mulligan: the two are independent decisions, and the
    // runner is woken by the match starting rather than by an opponent's move.
    const lobby = harness.server.lobbyByCode(harness.inviteCode);
    expect(lobby?.seats.get('seat_1')?.appliedActions.size).toBe(0);
    expect(lobby?.seats.get('seat_2')?.appliedActions.size).toBeGreaterThan(0);
    expect(harness.report()?.seats[0]?.actions.mulligan).toBe(1);
  });

  it('records one applied action identity per decision, and never applies one twice', async () => {
    const harness = createHarness();
    startBotMatch(harness);
    await playToCompletion(harness);

    const seat = harness.server.lobbyByCode(harness.inviteCode)?.seats.get('seat_2');
    const decisions = harness.report()?.seats[0]?.decisions ?? 0;
    const identities = [...(seat?.appliedActions.keys() ?? [])];

    expect(decisions).toBeGreaterThan(10);
    expect(identities).toHaveLength(decisions);
    expect(new Set(identities).size).toBe(identities.length);
    // Server-generated and monotonic: nothing on the wire chooses one, so no
    // client can collide with a bot's.
    expect(identities).toEqual(
      Array.from({ length: decisions }, (_unused, index) => `bot_1#${index}`),
    );
  });

  it('never submits a concession or a server timeout', async () => {
    const harness = createHarness();
    startBotMatch(harness);
    const { state } = await playToCompletion(harness);

    const committed = Object.keys(harness.report()?.seats[0]?.actions ?? {});
    for (const forbidden of ACTIONS_A_LIVE_BOT_NEVER_SUBMITS) {
      expect(committed).not.toContain(forbidden);
    }
    expect(state?.result?.reason).not.toBe('concede');
  });

  it('runs the whole match iteratively, crossing the yield boundary each decision', async () => {
    const harness = createHarness();
    startBotMatch(harness);
    await playToCompletion(harness);

    // The pump is a loop with an await in it, so a long match costs one stack
    // frame. The yield count is the visible half of that claim: it tracks the
    // decisions rather than staying at zero, and nothing overflowed producing it.
    const decisions = harness.report()?.seats[0]?.decisions ?? 0;
    expect(decisions).toBeGreaterThan(10);
    expect(harness.yields.count).toBeGreaterThanOrEqual(decisions - 1);
  });

  it('stops and cancels its work when the match completes', async () => {
    const harness = createHarness();
    startBotMatch(harness);
    await playToCompletion(harness);

    const before = harness.report()?.seats[0]?.decisions ?? 0;
    // Waking a finished match is a no-op rather than one more move.
    harness.send(harness.host, { type: 'ping' });
    await harness.server.whenBotsIdle();
    expect(harness.report()?.seats[0]?.decisions).toBe(before);
    expect(harness.state()?.status).toBe('complete');
  });
});

/* ------------------------------------------------------------ determinism */

describe('one independent deterministic stream per bot seat', () => {
  it('derives the stream from the match seed and the seat', () => {
    expect(botSeedFor('abc', 'seat_2')).toBe('abc:bot:seat_2');
    expect(botSeedFor('abc', 'seat_3')).not.toBe(botSeedFor('abc', 'seat_2'));
    expect(botSeedFor('abd', 'seat_2')).not.toBe(botSeedFor('abc', 'seat_2'));
    // Closely related seeds must not start adjacent. `createRngState` discards a
    // warm-up run, which is why no separate hash step is needed here.
    expect(createRngState(botSeedFor('abc', 'seat_2'))).not.toEqual(
      createRngState(botSeedFor('abc', 'seat_3')),
    );
  });

  it('replays the same match from the same seed, and a different one otherwise', async () => {
    const first = createHarness({ seed: 'replay-seed' });
    startBotMatch(first);
    const a = await playToCompletion(first);

    const second = createHarness({ seed: 'replay-seed' });
    startBotMatch(second);
    const b = await playToCompletion(second);

    expect(second.report()?.seats[0]?.seed).toBe(first.report()?.seats[0]?.seed);
    expect(b.state?.sequence).toBe(a.state?.sequence);
    expect(b.state?.turn).toBe(a.state?.turn);
    expect(b.state?.result).toEqual(a.state?.result);
    expect(b.human.decisions).toBe(a.human.decisions);
    expect(second.report()?.seats[0]?.actions).toEqual(first.report()?.seats[0]?.actions);

    const other = createHarness({ seed: 'a-different-seed' });
    startBotMatch(other);
    const c = await playToCompletion(other);
    expect(other.report()?.seats[0]?.seed).not.toBe(first.report()?.seats[0]?.seed);
    expect(c.state?.sequence).not.toBe(a.state?.sequence);
  });

  it('flies the pilot the style names, at the only available difficulty', () => {
    const value = createBotPilot(botConfigFor('value'));
    const aggressive = createBotPilot(botConfigFor('aggressive'));
    expect(value.id).toBe('value');
    expect(aggressive.id).toBe('aggressive');
    expect(value.version.length).toBeGreaterThan(0);
    // Two seats flying one style are two instances, so neither can be handed the
    // other's state by accident.
    expect(createBotPilot(botConfigFor('value'))).not.toBe(value);
  });

  it('refuses a difficulty that has no decision procedure behind it', () => {
    // Hard is the only one left: M09.13 gave Easy a procedure and turned it on,
    // and M09.15 built Hard's behaviour without publishing it — the registry is
    // still the only thing that decides, and it still says no. The refusal comes
    // from `difficultySelection` in `@tcg/bot-config`, so there is one wording
    // rather than one per caller that builds a pilot, and the tranche it names
    // is read from the registry rather than spelled here.
    expect(() => createBotPilot({ ...botConfigFor('value'), difficulty: 'hard' })).toThrow(
      new RegExp(difficultyDefinition('hard').plannedIn ?? 'never'),
    );
    for (const difficulty of AVAILABLE_DIFFICULTIES) {
      expect(() => createBotPilot({ ...botConfigFor('value'), difficulty })).not.toThrow();
    }
  });

  it('builds an Easy bot from the registry rather than from a name in the runner', () => {
    // Style picks the weights, difficulty picks the selection, and neither can
    // reach the other's half. A difficulty added to the registry needs no change
    // here, which is what stops the two lists drifting.
    const easy = createBotPilot({ ...botConfigFor('aggressive'), difficulty: 'easy' });
    const normal = createBotPilot({ ...botConfigFor('aggressive'), difficulty: 'normal' });
    expect(easy.id).toBe('aggressive');
    expect(easy.config.weights).toEqual(normal.config.weights);
    expect(easy.config.selection).toEqual(EASY_SELECTION);
    expect(normal.config.selection).toEqual({ kind: 'best' });
  });

  it('seats a bot whose pilot cannot be built without taking the match with it', async () => {
    const harness = createHarness();
    harness.send(harness.host, { type: 'add_bot', setup: botSetup() });
    harness.send(harness.host, { type: 'submit_precon', preconId: HUMAN_PRECON_ID });

    const lobby = harness.server.lobbyByCode(harness.inviteCode);
    const seat = lobby?.seats.get('seat_2');
    if (!seat || seat.controller !== 'bot') throw new Error('The bot seat is missing.');
    // No message can reach this state — the lobby refuses `hard` — so it is set
    // directly. The point is that a pilot that cannot be built sits the match out
    // instead of throwing inside `start_match`.
    seat.config = { ...seat.config, difficulty: 'hard' };
    harness.send(harness.host, { type: 'set_ready', ready: true });
    await harness.server.whenBotsIdle();

    expect(harness.state()?.status).not.toBe('complete');
    const report = harness.report();
    expect(report?.seats[0]?.halted).toBe('pilot_unavailable');
    expect(report?.incidents[0]?.kind).toBe('pilot_unavailable');
    expect(report?.seats[0]?.decisions).toBe(0);
  });
});

/* ---------------------------------------------------------- eligibility */

describe('what counts as a decision', () => {
  it('is offered for every family the engine can ask a seat to answer', () => {
    expect(hasBotDecision(noLegalActions({ canPassPhase: true }))).toBe(true);
    expect(
      hasBotDecision(noLegalActions({ mulligan: { handInstanceIds: ['card_1'], maxReturn: 1 } })),
    ).toBe(true);
    // Only its presence is read here, so the fixture carries the identifying
    // half of a `PendingChoice` rather than a whole provenance and continuation
    // that nothing in this function looks at.
    const pendingChoice = { id: 'choice_1', playerId: 'player_2' } as unknown as NonNullable<
      LegalActions['pendingChoice']
    >;
    expect(hasBotDecision(noLegalActions({ pendingChoice }))).toBe(true);
    expect(
      hasBotDecision(
        noLegalActions({
          reaction: {
            windowId: 'window_1',
            windows: ['after_attackers_declared'],
            subjectInstanceId: null,
            playableCards: [],
            canPass: true,
          },
        }),
      ),
    ).toBe(true);
    expect(
      hasBotDecision(
        noLegalActions({
          blocking: {
            attackerInstanceIds: ['unit_1'],
            blockerInstanceIds: ['unit_2'],
            guardianInstanceIds: [],
            mustBlockCount: 0,
          },
        }),
      ),
    ).toBe(true);
    expect(
      hasBotDecision(
        noLegalActions({ attacking: { legalAttackers: ['unit_1'], legalDefenders: ['player_1'] } }),
      ),
    ).toBe(true);
    expect(
      hasBotDecision(
        noLegalActions({
          playableCards: [{ instanceId: 'card_1', definitionId: 'card_a', energyCost: 1 }],
        }),
      ),
    ).toBe(true);
    expect(
      hasBotDecision(
        noLegalActions({
          activatableAbilities: [
            { sourceInstanceId: 'unit_1', abilityId: 'ability_1', energyCost: 1 },
          ],
        }),
      ),
    ).toBe(true);
  });

  it('is not offered when conceding is the only thing available', () => {
    expect(hasBotDecision(noLegalActions())).toBe(false);
    expect(hasBotDecision(noLegalActions({ canConcede: false }))).toBe(false);
  });

  it('is not offered to an eliminated seat', () => {
    expect(hasBotDecision(noLegalActions({ eliminated: true, canPassPhase: true }))).toBe(false);
  });

  it('excludes exactly the state in which the substituted fallback pilot throws', () => {
    // The finding M09.4 was told to contain: `decideSafely` substitutes
    // `createRandomLegalPilot()`, and that pilot throws when it is asked to
    // decide with nothing but a concession available. The eligibility gate is
    // what keeps the live runner out of that state, and this is the two halves
    // of the claim standing next to each other.
    const concedeOnly = noLegalActions();
    expect(hasBotDecision(concedeOnly)).toBe(false);
    expect(() =>
      createRandomLegalPilot().decide(
        {
          view: {} as never,
          legal: concedeOnly,
          history: [],
          database,
          rulesConfig: config,
          decisionIndex: 0,
        },
        createRngState('anything'),
      ),
    ).toThrow(/no legal action available/);
  });
});

/* ----------------------------------------------- failure, honestly recorded */

describe('pilot failure and fallback are recorded, never disguised as a play', () => {
  it('substitutes a legal decision and records the throw behind it', async () => {
    let thrown = 0;
    const harness = createHarness({
      pilot: stubPilot(() => {
        thrown += 1;
        throw new Error('this pilot is broken');
      }),
    });
    startBotMatch(harness);
    const { state } = await playToCompletion(harness);

    expect(thrown).toBeGreaterThan(0);
    expect(state?.status).toBe('complete');

    const report = harness.report();
    const fallbacks = report?.incidents.filter((entry) => entry.kind === 'pilot_fallback') ?? [];
    // Every decision was a fallback, and every one of them says so: the match
    // still finished, and nothing in the record calls this play.
    expect(fallbacks).toHaveLength(report?.seats[0]?.decisions ?? -1);
    expect(fallbacks[0]?.pilotFailure).toBe('threw');
    expect(fallbacks[0]?.message).toContain('this pilot is broken');
    expect(fallbacks[0]?.seatId).toBe('seat_2');
    expect(fallbacks[0]?.botId).toBe('bot_1');
    expect(report?.seats[0]?.halted).toBeNull();
  });

  it('records an illegal pilot answer as a fallback rather than sending it to the engine', async () => {
    const harness = createHarness({
      // `submit_choice` against a choice that is not pending: refused by
      // `checkActionOffered` before it can reach `applyAction`.
      pilot: stubPilot((observation, rng) => ({
        action: {
          type: 'submit_choice',
          playerId: observation.legal.playerId,
          choiceId: 'no_such_choice',
          selectedIds: [],
        },
        rng,
        diagnostics: null,
      })),
    });
    startBotMatch(harness);
    const { state } = await playToCompletion(harness);

    expect(state?.status).toBe('complete');
    const incidents = harness.report()?.incidents ?? [];
    expect(incidents.every((entry) => entry.kind === 'pilot_fallback')).toBe(true);
    expect(incidents[0]?.pilotFailure).toBe('illegal_action');
    expect(incidents.some((entry) => entry.kind === 'engine_rejected')).toBe(false);
  });

  it('refuses a concession from a pilot, and does not lose the match doing it', async () => {
    const harness = createHarness({
      pilot: stubPilot((observation, rng) => ({
        action: { type: 'concede', playerId: observation.legal.playerId },
        rng,
        diagnostics: null,
      })),
    });
    startBotMatch(harness);
    await harness.server.whenBotsIdle();

    // `checkActionOffered` lets a concession through — it is a legal action for a
    // living seat — so the runner's own guard is the thing being tested here.
    const report = harness.report();
    expect(report?.incidents.map((entry) => entry.kind)).toEqual(['forbidden_action']);
    expect(report?.incidents[0]?.message).toContain('concede');
    expect(report?.seats[0]?.halted).toBe('forbidden_action');
    expect(report?.seats[0]?.actions).toEqual({});

    const state = harness.state();
    expect(state?.status).not.toBe('complete');
    expect(state?.players.player_2?.lost).toBe(false);
  });

  it('refuses a server timeout from a pilot for the same reason', async () => {
    const harness = createHarness({
      pilot: stubPilot((observation, rng) => ({
        action: { type: 'server_timeout', playerId: observation.legal.playerId },
        rng,
        diagnostics: null,
      })),
    });
    startBotMatch(harness);
    await harness.server.whenBotsIdle();

    // Caught twice over: `checkActionOffered` refuses it as an illegal pilot
    // answer, so the substituted decision is what actually reaches the board.
    // `server_timeout` stays server-originated either way (ADR 0024 §2).
    const report = harness.report();
    expect(report?.incidents[0]?.kind).toBe('pilot_fallback');
    expect(report?.incidents[0]?.pilotFailure).toBe('illegal_action');
    expect(Object.keys(report?.seats[0]?.actions ?? {})).not.toContain('server_timeout');
  });

  it('stops asking a seat that reaches its decision ceiling', async () => {
    const harness = createHarness({ botDecisionLimit: 3 });
    startBotMatch(harness);
    const { state, blocked } = await playToCompletion(harness);

    expect(state?.status).not.toBe('complete');
    expect(blocked).toBe(true);
    const report = harness.report();
    expect(report?.seats[0]?.decisions).toBe(3);
    expect(report?.seats[0]?.halted).toBe('decision_limit');
    expect(report?.incidents.map((entry) => entry.kind)).toContain('decision_limit');
    // The match is not "stalled": the bot has legal actions and has simply
    // stopped being asked for them, and the record must not confuse the two.
    expect(report?.stalled).toBeNull();
  });
});

/* --------------------------------------------- revalidation and cancellation */

describe('a scheduled decision is an opportunity, not a stored action', () => {
  /** Two real states, one strictly later than the other. */
  function twoStates(): { before: MatchState; after: MatchState } {
    const harness = createHarness();
    startBotMatch(harness);
    const before = harness.state();
    if (!before) throw new Error('The match did not start.');
    return { before, after: { ...structuredClone(before), sequence: before.sequence + 1 } };
  }

  it('discards an answer the board has already moved past, and asks again', async () => {
    const { before, after } = twoStates();
    let reads = 0;
    const submitted: string[] = [];
    const runner = new BotRunner({
      matchSeed: 'stale',
      database,
      config,
      seats: [{ seatId: 'seat_2', playerId: 'player_2', config: botConfigFor('value') }],
      // The first two reads are the pre-decision and post-decision reads of one
      // opportunity, and the board moves between them — exactly what a human
      // action landing inside the pilot's await looks like.
      state: () => {
        reads += 1;
        return reads <= 1 ? before : after;
      },
      submit: (_seatId, actionId) => {
        submitted.push(actionId);
        return { ok: true };
      },
      decisionLimit: 2,
    });

    runner.wake();
    await runner.pending;

    const report = runner.report();
    const stale = report.incidents.filter((entry) => entry.kind === 'stale_decision');
    expect(stale).toHaveLength(1);
    expect(stale[0]?.message).toContain('discarded');
    // The discarded answer consumed no action identity and no decision index:
    // the first thing that reaches the board is still `bot_1#0`, decided against
    // the newer board. Nothing was stored during the gap and nothing was
    // submitted out of it.
    expect(submitted).toEqual(['bot_1#0', 'bot_1#1']);
    expect(report.seats[0]?.decisions).toBe(2);
  });

  it('records an engine refusal against the seat instead of retrying forever', async () => {
    const { before } = twoStates();
    const runner = new BotRunner({
      matchSeed: 'rejected',
      database,
      config,
      seats: [{ seatId: 'seat_2', playerId: 'player_2', config: botConfigFor('value') }],
      state: () => before,
      submit: () => ({ ok: false, reason: 'rejected', message: 'rules/not_your_turn — nope' }),
    });

    runner.wake();
    await runner.pending;

    const report = runner.report();
    expect(report.incidents.map((entry) => entry.kind)).toEqual(['engine_rejected']);
    expect(report.incidents[0]?.message).toContain('rules/not_your_turn');
    expect(report.seats[0]?.halted).toBe('engine_rejected');
    expect(report.seats[0]?.decisions).toBe(1);
  });

  it('records a repeated action identity rather than applying one twice', async () => {
    const { before } = twoStates();
    const runner = new BotRunner({
      matchSeed: 'duplicate',
      database,
      config,
      seats: [{ seatId: 'seat_2', playerId: 'player_2', config: botConfigFor('value') }],
      state: () => before,
      submit: () => ({ ok: false, reason: 'duplicate', message: 'bot_1#0 was already applied.' }),
    });

    runner.wake();
    await runner.pending;

    const report = runner.report();
    expect(report.incidents.map((entry) => entry.kind)).toEqual(['duplicate_action']);
    expect(report.seats[0]?.halted).toBe('duplicate_action');
  });

  it('does not start a second pump while one is in flight', async () => {
    const { before } = twoStates();
    const submitted: string[] = [];
    const runner = new BotRunner({
      matchSeed: 'reentrant',
      database,
      config,
      seats: [{ seatId: 'seat_2', playerId: 'player_2', config: botConfigFor('value') }],
      state: () => before,
      submit: (_seatId, actionId) => {
        submitted.push(actionId);
        // Waking from inside a submission is what every broadcast could do. It
        // must be a no-op rather than a second concurrent pump on one seat.
        runner.wake();
        return { ok: true };
      },
      decisionLimit: 3,
    });

    runner.wake();
    runner.wake();
    await runner.pending;

    // Three decisions and no more: the same state is offered every time, so the
    // ceiling stops it, and every identity is distinct.
    expect(submitted).toEqual(['bot_1#0', 'bot_1#1', 'bot_1#2']);
    expect(new Set(submitted).size).toBe(3);
  });

  it('records a board on which nobody can act, and never concedes to unstick it', async () => {
    const { before } = twoStates();
    // Every seat eliminated while the match is still running: no seat has a legal
    // action, and the honest answer is to write that down. It is deliberately
    // built by hand — an engine that produces it has a defect, and this test is
    // about what the runner does when it meets one.
    const stuck = structuredClone(before);
    for (const playerId of stuck.seatOrder) {
      const player = stuck.players[playerId];
      if (player) player.lost = true;
    }

    const submitted: string[] = [];
    const runner = new BotRunner({
      matchSeed: 'stuck',
      database,
      config,
      seats: [{ seatId: 'seat_2', playerId: 'player_2', config: botConfigFor('value') }],
      state: () => stuck,
      submit: (_seatId, actionId) => {
        submitted.push(actionId);
        return { ok: true };
      },
    });

    runner.wake();
    await runner.pending;
    runner.wake();
    await runner.pending;

    expect(submitted).toEqual([]);
    expect(runner.report().stalled).toContain('no seat has a legal action');
    expect(runner.report().incidents).toEqual([]);
  });

  it('submits nothing at all once it has been stopped', async () => {
    const { before } = twoStates();
    const submitted: string[] = [];
    const runner = new BotRunner({
      matchSeed: 'stopped',
      database,
      config,
      seats: [{ seatId: 'seat_2', playerId: 'player_2', config: botConfigFor('value') }],
      state: () => before,
      submit: (_seatId, actionId) => {
        submitted.push(actionId);
        return { ok: true };
      },
      // Stopping inside the pilot's await is the case that matters: a match that
      // finished while a bot was thinking must not receive one last action.
      yieldToScheduler: () => {
        runner.stop();
        return Promise.resolve();
      },
    });

    runner.wake();
    await runner.pending;
    expect(submitted).toEqual(['bot_1#0']);
    expect(runner.stopped).toBe(true);

    runner.wake();
    expect(runner.pending).toBeNull();
    expect(submitted).toEqual(['bot_1#0']);
  });

  it('contains a pump that throws, rather than rejecting a promise nobody awaits', async () => {
    const { before } = twoStates();
    const runner = new BotRunner({
      matchSeed: 'crash',
      database,
      config,
      seats: [{ seatId: 'seat_2', playerId: 'player_2', config: botConfigFor('value') }],
      state: () => before,
      submit: () => {
        throw new Error('the submission path exploded');
      },
    });

    runner.wake();
    // An unhandled rejection ends a Node process by default, so this must
    // resolve: the bot is lost, the server is not.
    await expect(runner.pending).resolves.toBeUndefined();
    expect(runner.report().crashed).toContain('the submission path exploded');
    expect(runner.stopped).toBe(true);
  });

  it('lets a closed lobby go, with its bot work cancelled and joined', async () => {
    const harness = createHarness();
    startBotMatch(harness);
    await playToCompletion(harness);

    harness.server.disconnect(harness.host);
    await harness.server.whenBotsIdle();

    // The lobby and its runner are both gone: a finished match must not keep a
    // whole `MatchState` alive behind a stopped pump.
    expect(harness.server.lobbyByCode(harness.inviteCode)).toBeUndefined();
    expect(harness.report()).toBeUndefined();
  });
});
