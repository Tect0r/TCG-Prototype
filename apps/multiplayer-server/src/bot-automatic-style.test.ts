import { describe, expect, it } from 'vitest';
import {
  AUTOMATIC_STYLE,
  AUTOMATIC_STYLE_FALLBACK,
  BOT_CONFIG_SCHEMA_VERSION,
  DEFAULT_BOT_DIFFICULTY,
  DIFFICULTY_REGISTRY_VERSION,
  IMMEDIATE_BOT_PACING,
  publicBotSeatOf,
  resolveAutomaticStyle,
  type BotDeckSource,
} from '@tcg/bot-config';
import {
  bundledPrecon,
  deckPlansForFormat,
  loadFormatCardData,
  resolveFormatId,
} from '@tcg/card-data';
import {
  DECK_SCHEMA_VERSION,
  deckFingerprint,
  deckFormatOf,
  expandDeckCards,
  preconToDeck,
  type SavedDeck,
} from '@tcg/deck';
import { type BotSetup } from '@tcg/protocol';
import { unwrap } from '@tcg/shared';
import { resolveBotSeat, setupOf } from './bot-seats.js';

/**
 * Automatic style, on the authoritative side (M09.16).
 *
 * The tranche's claim is that a host may set the style control to `automatic`
 * and the **server** decides what that means, from the Commander the seat
 * actually ends up leading and from that format's authored deck plans. Four
 * things follow, and each is a test below.
 *
 * - It resolves for **every deck mode**, including the one whose Commander
 *   nothing knows until the deck has been generated.
 * - The seat records **both** halves: `styleSetting` stays `automatic`, and
 *   `style` is the style the pilot will actually fly.
 * - The **setting** is what survives a reconfiguration, so an automatic seat
 *   that rerolls onto a different Commander re-resolves rather than freezing the
 *   style its previous deck implied.
 * - A style the host **named** is untouched, because automatic is one setting
 *   among four rather than a filter every configuration passes through.
 *
 * Everything is driven through `resolveBotSeat`, which is the single place a
 * setup becomes a configuration — and, since this tranche, the single place a
 * style stops being a setting.
 */

const shipping = loadFormatCardData(resolveFormatId());
if (!shipping.ok) throw new Error('The shipping format did not resolve to a card pool.');
const { database, format } = shipping.value;
const deckFormat = deckFormatOf(format);

const context = { database, deckFormat, now: () => 1_700_000_000_000 };
const identity = { botId: 'bot_1', seatId: 'seat_2' } as const;

function setupFor(deck: BotDeckSource, overrides: Partial<BotSetup> = {}): BotSetup {
  return {
    schemaVersion: BOT_CONFIG_SCHEMA_VERSION,
    difficultyRegistryVersion: DIFFICULTY_REGISTRY_VERSION,
    difficulty: DEFAULT_BOT_DIFFICULTY,
    style: AUTOMATIC_STYLE,
    deck,
    pacing: IMMEDIATE_BOT_PACING,
    displayName: null,
    ...overrides,
  };
}

function requirePrecon(preconId: string) {
  const precon = bundledPrecon(preconId);
  if (!precon) throw new Error(`${preconId} is missing from the bundle.`);
  return precon;
}

/** The host's own copy of a shipped list, which is what a saved deck is here. */
function savedDeckFrom(preconId: string): SavedDeck {
  const precon = requirePrecon(preconId);
  return {
    ...preconToDeck(precon, { id: 'deck_home_brew', now: '2026-08-20T09:00:00.000Z' }),
    schemaVersion: DECK_SCHEMA_VERSION,
    name: 'My secret brew',
  };
}

/** Every Commander this format publishes a plan for, and the style it implies. */
const PLANNED = deckPlansForFormat(deckFormat.formatId).map((plan) => ({
  preconId: plan.preconId,
  commanderId: plan.commanderId,
  archetypeId: plan.archetypeId,
  style: resolveAutomaticStyle({ commanderId: plan.commanderId, formatId: deckFormat.formatId })
    .style,
}));

describe('a bot seat set to automatic style', () => {
  it('resolves a built-in deck through its own authored plan', () => {
    expect(PLANNED.length).toBeGreaterThan(1);
    for (const plan of PLANNED) {
      if (!plan.preconId) continue;
      const seat = unwrap(
        resolveBotSeat(
          setupFor({ mode: 'exact_precon', preconId: plan.preconId }),
          identity,
          context,
        ),
      );
      expect(seat.config.styleSetting).toBe(AUTOMATIC_STYLE);
      expect(seat.config.style).toBe(plan.style);
      expect(seat.deck?.commanderId).toBe(plan.commanderId);
    }
    // And the four Wave 1 plans do not all imply the same style, so the loop
    // above is distinguishing between them rather than agreeing with a constant.
    expect(new Set(PLANNED.map((plan) => plan.style)).size).toBeGreaterThan(1);
  });

  it('resolves one of the host’s saved decks through its Commander', () => {
    const deck = savedDeckFrom('precon_bastion_guardians');
    if (deck.commanderId === null) throw new Error('A snapshot needs a Commander.');
    const seat = unwrap(
      resolveBotSeat(
        setupFor({
          mode: 'exact_saved_deck',
          deck: {
            sourceDeckId: deck.id,
            name: deck.name,
            commanderId: deck.commanderId,
            cardIds: expandDeckCards(deck.cards),
            deckHash: deckFingerprint(deck),
          },
        }),
        identity,
        context,
      ),
    );
    // The list is the host's own and nothing has classified it; the *Commander*
    // is what the plan is looked up by, which is the one handle all four modes
    // share.
    expect(seat.config.style).toBe(
      resolveAutomaticStyle({ commanderId: deck.commanderId, formatId: deckFormat.formatId }).style,
    );
    expect(seat.config.styleSetting).toBe(AUTOMATIC_STYLE);
  });

  it('resolves a deck the server generated under a Commander the host picked', () => {
    const plan = PLANNED[0];
    if (!plan) throw new Error('This format publishes no deck plans.');
    const seat = unwrap(
      resolveBotSeat(
        setupFor({
          mode: 'commander_generated',
          commanderId: plan.commanderId,
          seed: 'seed-automatic',
          generated: null,
        }),
        identity,
        context,
      ),
    );
    expect(seat.config.style).toBe(plan.style);
    expect(seat.config.styleSetting).toBe(AUTOMATIC_STYLE);
  });

  it('resolves a Commander the bot picked for itself, which nothing knew in advance', () => {
    // The case the whole design is arranged around: there is no Commander in
    // the instruction, so the style cannot be decided until the deck exists.
    const seat = unwrap(
      resolveBotSeat(
        setupFor({ mode: 'autonomous_generated', seed: 'seed-automatic', generated: null }),
        identity,
        context,
      ),
    );
    const commanderId = seat.deck?.commanderId ?? null;
    expect(commanderId).not.toBeNull();
    expect(seat.config.style).toBe(
      resolveAutomaticStyle({ commanderId, formatId: deckFormat.formatId }).style,
    );
    // The provenance and the style agree about which Commander was picked.
    if (seat.config.deck.mode !== 'autonomous_generated') throw new Error('Wrong mode.');
    expect(seat.config.deck.generated?.commanderId).toBe(commanderId);
  });

  it('publishes both halves, so a seat can say nobody picked its style', () => {
    const plan = PLANNED[0];
    if (!plan?.preconId) throw new Error('This format publishes no precon plans.');
    const automatic = unwrap(
      resolveBotSeat(
        setupFor({ mode: 'exact_precon', preconId: plan.preconId }),
        identity,
        context,
      ),
    );
    const named = unwrap(
      resolveBotSeat(
        setupFor({ mode: 'exact_precon', preconId: plan.preconId }, { style: plan.style }),
        identity,
        context,
      ),
    );

    // Same style, different provenance — which is exactly the distinction the
    // public projection has to carry, because the two are different facts about
    // the table and a lobby that flattened them would be lying about one.
    expect(publicBotSeatOf(automatic.config).style).toBe(publicBotSeatOf(named.config).style);
    expect(publicBotSeatOf(automatic.config).styleSetting).toBe(AUTOMATIC_STYLE);
    expect(publicBotSeatOf(named.config).styleSetting).toBe(plan.style);
  });

  it('sends the setting back, not the style, so a reroll re-resolves', () => {
    const plan = PLANNED[0];
    if (!plan) throw new Error('This format publishes no deck plans.');
    const seat = unwrap(
      resolveBotSeat(
        setupFor({
          mode: 'commander_generated',
          commanderId: plan.commanderId,
          seed: 'seed-automatic',
          generated: null,
        }),
        identity,
        context,
      ),
    );
    // `setupOf` is what a reroll feeds back through `resolveBotSeat`. If it
    // carried the resolved style, the first reroll would silently convert an
    // automatic seat into a hand-picked one.
    expect(setupOf(seat.config).style).toBe(AUTOMATIC_STYLE);
    expect(Object.keys(setupOf(seat.config))).not.toContain('styleSetting');
  });

  it('leaves a style the host named exactly where they put it', () => {
    const plan = PLANNED.find((entry) => entry.style !== AUTOMATIC_STYLE_FALLBACK);
    if (!plan?.preconId) throw new Error('No plan implies a style other than the fallback.');
    const seat = unwrap(
      resolveBotSeat(
        setupFor(
          { mode: 'exact_precon', preconId: plan.preconId },
          { style: AUTOMATIC_STYLE_FALLBACK },
        ),
        identity,
        context,
      ),
    );
    // The plan would have said something else, and did not get the chance to.
    expect(plan.style).not.toBe(AUTOMATIC_STYLE_FALLBACK);
    expect(seat.config.style).toBe(AUTOMATIC_STYLE_FALLBACK);
    expect(seat.config.styleSetting).toBe(AUTOMATIC_STYLE_FALLBACK);
  });
});
