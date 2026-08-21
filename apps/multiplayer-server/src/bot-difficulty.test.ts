import { describe, expect, it } from 'vitest';
import {
  AVAILABLE_DIFFICULTIES,
  BOT_CONFIG_SCHEMA_VERSION,
  BOT_DIFFICULTIES,
  DIFFICULTY_REGISTRY,
  DIFFICULTY_REGISTRY_VERSION,
  EASY_SELECTION,
  IMMEDIATE_BOT_PACING,
  PLANNED_DIFFICULTIES,
  difficultyDefinition,
  type BotDifficulty,
} from '@tcg/bot-config';
import { createPilot } from '@tcg/bot-interface';
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
  type MatchState,
  type PlayerId,
  type RngState,
} from '@tcg/rules-engine';
import { createBotPilot, hasBotDecision, type BotRunReport } from './bot-runner.js';
import { MatchServer, type ServerConnection } from './match-server.js';

/**
 * Easy at a live table (M09.13).
 *
 * The pilot-level properties — the bound, the reproducibility, the fact that
 * Easy is one parameter over the same scored candidates — belong to
 * `@tcg/bot-interface` and are asserted there. What is asserted here is
 * everything that only exists once a person has actually sat down opposite one:
 *
 * 1. The lobby **accepts** Easy now, from the registry rather than from a list,
 *    and still refuses Hard by name.
 * 2. An Easy bot plays a whole real match against a scripted human, through the
 *    ordinary `submit_action` path, and finishes it.
 * 3. The match **records which difficulty it flew and which version of it**,
 *    beside the style and the style's version, so a playtest note can say what
 *    it was playing against.
 * 4. Difficulty and style stay independent on the wire and in the seat: every
 *    combination is configurable and none of them collapses into another.
 */

const shipping = loadFormatCardData(resolveFormatId());
if (!shipping.ok) throw new Error('The shipping format did not resolve to a card pool.');
const { database, format } = shipping.value;
const deckFormat = deckFormatOf(format);
const config = DEFAULT_RULES_CONFIG;

const BOT_PRECON_ID = 'precon_containment_control';
const HUMAN_PRECON_ID = 'precon_bastion_guardians';
const BOT_FIRST_SEED = 's1';

function botSetup(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: BOT_CONFIG_SCHEMA_VERSION,
    difficultyRegistryVersion: DIFFICULTY_REGISTRY_VERSION,
    difficulty: 'easy' as BotDifficulty,
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
  send(connection: FakeConnection, message: ClientMessageInput): void;
  state(): MatchState | null;
  report(): BotRunReport | undefined;
}

function createHarness(seed = BOT_FIRST_SEED): Harness {
  let counter = 0;
  const server = new MatchServer({
    database,
    deckFormat,
    random: () => {
      counter += 1;
      return ((counter * 2654435761) % 4294967296) / 4294967296;
    },
    schedule: () => () => {},
    seedFor: () => seed,
    now: () => 1_000_000,
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
    send,
    state: () => server.lobbyByCode(inviteCode)?.state ?? null,
    report: () => server.botReport(inviteCode),
  };
}

/** The scripted opponent the other server suites use, acting through the wire. */
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

  act(state: MatchState): boolean {
    const legal = legalActions(state, this.playerId, { database, config });
    if (!hasBotDecision(legal)) return false;

    const view = playerView(state, this.playerId, database, config);
    const decision = this.#pilot.decide(
      {
        view,
        legal,
        history: view.log,
        database,
        rulesConfig: config,
        decisionIndex: this.#decisions,
      },
      this.#rng,
    );
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

async function playToCompletion(harness: Harness) {
  const human = new ScriptedHuman(harness);
  for (let step = 0; step < 20_000; step += 1) {
    await harness.server.whenBotsIdle();
    const state = harness.state();
    if (!state || state.status === 'complete') return { state, blocked: false };
    if (!human.act(state)) return { state, blocked: true };
  }
  throw new Error('The match did not finish inside 20 000 steps.');
}

function startMatch(harness: Harness, setup = botSetup()): void {
  harness.send(harness.host, { type: 'add_bot', setup });
  harness.send(harness.host, { type: 'submit_precon', preconId: HUMAN_PRECON_ID });
  harness.send(harness.host, { type: 'set_ready', ready: true });
}

/* ------------------------------------------------------------ what is offered */

describe('the lobby offers exactly what the registry says it can fly', () => {
  it('seats an Easy bot, which it refused before M09.13', async () => {
    const harness = createHarness();
    harness.send(harness.host, { type: 'add_bot', setup: botSetup() });

    const view = harness.host.last('lobby_updated')?.lobby;
    const seat = view?.seats.find((entry) => entry.seatId === 'seat_2');
    expect(seat?.controller).toBe('bot');
    if (seat?.controller !== 'bot') throw new Error('Seat 2 does not hold a bot.');
    // Public, like every other axis of a bot seat: an opponent may know what it
    // is playing against (ADR 0024 §3).
    expect(seat.bot.difficulty).toBe('easy');
    expect(harness.host.last('error')).toBeUndefined();
  });

  it.each(PLANNED_DIFFICULTIES)('still refuses %s by name', (difficulty) => {
    const harness = createHarness();
    harness.send(harness.host, { type: 'add_bot', setup: botSetup({ difficulty }) });

    const error = harness.host.last('error');
    expect(error?.error.code).toBe('protocol/bot_config_invalid');
    // The refusal names the tranche that owns it, from the registry, so it stays
    // true when M09.15 lands without anybody editing a message.
    expect(error?.error.details?.join(' ')).toContain(
      difficultyDefinition(difficulty).plannedIn as string,
    );
    expect(harness.server.lobbyByCode(harness.inviteCode)?.seats.get('seat_2')).toBeUndefined();
  });

  it('accepts every difficulty the registry calls available', () => {
    for (const difficulty of AVAILABLE_DIFFICULTIES) {
      const harness = createHarness();
      harness.send(harness.host, { type: 'add_bot', setup: botSetup({ difficulty }) });
      expect(harness.host.last('error')).toBeUndefined();
    }
    // And the two lists together are still the whole vocabulary, so a third
    // status cannot appear without this failing.
    expect([...AVAILABLE_DIFFICULTIES, ...PLANNED_DIFFICULTIES].sort()).toEqual(
      [...BOT_DIFFICULTIES].sort(),
    );
  });
});

/* -------------------------------------------------------------- playing */

describe('an Easy bot plays a whole live match', () => {
  it('finishes a 1v1 against a scripted human through the ordinary path', async () => {
    const harness = createHarness();
    startMatch(harness);

    const { state, blocked } = await playToCompletion(harness);
    expect(blocked).toBe(false);
    expect(state?.status).toBe('complete');
    expect(state?.result).not.toBeNull();

    const report = harness.report();
    const bot = report?.seats[0];
    expect(bot?.decisions).toBeGreaterThan(10);
    expect(bot?.halted).toBeNull();
    // The properties a difficulty must never cost: no fallback, no refused
    // action, no stall, and above all no concession.
    expect(report?.incidents).toEqual([]);
    expect(report?.stalled).toBeNull();
    expect(report?.crashed).toBeNull();
    expect(Object.keys(bot?.actions ?? {})).not.toContain('concede');
  });

  it('answers a pending choice and a Reaction window, the same as Normal does', async () => {
    const harness = createHarness();
    startMatch(harness);
    await playToCompletion(harness);

    const actions = harness.report()?.seats[0]?.actions ?? {};
    // A real game rather than a hand-built board. A bounded degradation that
    // quietly stopped answering a decision surface would show up here as a
    // missing key, not as a failure.
    expect(Object.keys(actions)).toEqual(
      expect.arrayContaining(['mulligan', 'play_card', 'pass_phase']),
    );
  });
});

/* ---------------------------------------------------------- what is recorded */

describe('the match records which difficulty it flew', () => {
  it('names the difficulty and its behaviour version beside the style and its own', async () => {
    const harness = createHarness();
    startMatch(harness);
    await playToCompletion(harness);

    const bot = harness.report()?.seats[0];
    // Two pairs, because two independent things decided every move: the style's
    // scorer and the difficulty's selection over what it scored.
    expect(bot?.pilotId).toBe('value');
    expect(bot?.pilotVersion).toBe(createPilot({ id: 'value' }).version);
    expect(bot?.difficulty).toBe('easy');
    expect(bot?.difficultyBehaviorVersion).toBe(DIFFICULTY_REGISTRY.easy.behaviorVersion);
    expect(bot?.difficultyBehaviorVersion).not.toBeNull();
  });

  it('records Normal as Normal, so the two are told apart in a record', async () => {
    const harness = createHarness();
    startMatch(harness, botSetup({ difficulty: 'normal' }));
    await playToCompletion(harness);

    const bot = harness.report()?.seats[0];
    expect(bot?.difficulty).toBe('normal');
    expect(bot?.difficultyBehaviorVersion).toBe(DIFFICULTY_REGISTRY.normal.behaviorVersion);
  });

  it('plays a different match at Easy than at Normal, from the identical seed', async () => {
    const easy = createHarness();
    startMatch(easy, botSetup({ difficulty: 'easy' }));
    const easyOutcome = await playToCompletion(easy);

    const normal = createHarness();
    startMatch(normal, botSetup({ difficulty: 'normal' }));
    const normalOutcome = await playToCompletion(normal);

    expect(easyOutcome.state?.status).toBe('complete');
    expect(normalOutcome.state?.status).toBe('complete');
    // Same seed, same seating, same deck, same style, same pacing — one axis
    // moved, and the match is a different match. Which of them won is not the
    // claim and is not asserted: Easy is a bound, not a guarantee of losing.
    expect(easyOutcome.state?.sequence).not.toBe(normalOutcome.state?.sequence);
  });

  it('replays the same Easy match exactly from the same seed', async () => {
    const first = createHarness();
    startMatch(first);
    const one = await playToCompletion(first);

    const second = createHarness();
    startMatch(second);
    const two = await playToCompletion(second);

    expect(two.state?.sequence).toBe(one.state?.sequence);
    expect(two.state?.result).toEqual(one.state?.result);
    expect(second.report()?.seats[0]?.actions).toEqual(first.report()?.seats[0]?.actions);
  });
});

/* -------------------------------------------------------- four axes, not one */

describe('difficulty and style remain independent at a live seat', () => {
  it('configures every combination of the two', () => {
    for (const difficulty of AVAILABLE_DIFFICULTIES) {
      for (const style of ['aggressive', 'defensive', 'value'] as const) {
        const harness = createHarness();
        harness.send(harness.host, { type: 'add_bot', setup: botSetup({ difficulty, style }) });
        const seat = harness.host.last('lobby_updated')?.lobby.seats[1];
        expect(harness.host.last('error')).toBeUndefined();
        if (seat?.controller !== 'bot') throw new Error('Seat 2 does not hold a bot.');
        expect(seat.bot.difficulty).toBe(difficulty);
        expect(seat.bot.style).toBe(style);
      }
    }
  });

  it('gives the same style the same weights at both difficulties', () => {
    const easy = createBotPilot({
      schemaVersion: BOT_CONFIG_SCHEMA_VERSION,
      difficultyRegistryVersion: DIFFICULTY_REGISTRY_VERSION,
      controller: { botId: 'bot_1', displayName: 'AI 2' },
      difficulty: 'easy',
      styleSetting: 'defensive',
      style: 'defensive',
      deck: { mode: 'exact_precon', preconId: BOT_PRECON_ID },
      pacing: IMMEDIATE_BOT_PACING,
    });
    const normal = createBotPilot({
      schemaVersion: BOT_CONFIG_SCHEMA_VERSION,
      difficultyRegistryVersion: DIFFICULTY_REGISTRY_VERSION,
      controller: { botId: 'bot_1', displayName: 'AI 2' },
      difficulty: 'normal',
      styleSetting: 'defensive',
      style: 'defensive',
      deck: { mode: 'exact_precon', preconId: BOT_PRECON_ID },
      pacing: IMMEDIATE_BOT_PACING,
    });

    expect(easy.config.weights).toEqual(normal.config.weights);
    expect(easy.config.selection).toEqual(EASY_SELECTION);
    expect(normal.config.selection).toEqual({ kind: 'best' });
  });
});
