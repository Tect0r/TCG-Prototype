import { z } from 'zod';
import { cardIdSchema, formatIdSchema, preconIdSchema } from '@tcg/card-data';

/**
 * Where a bot's cards come from (M09.1) — the third independent axis, and the
 * one that carries the milestone's privacy rule
 * ([ADR 0024](../../../docs/architecture/0024-live-bot-seats.md) §3).
 *
 * **Public at the Commander, private at the list.** The Commander a bot brings
 * is the one fact an opponent needs in order to know what they are sitting down
 * against, and every mode reveals it. The card list is not: a generated list and
 * a saved deck the host picked stay private for the whole match and are revealed
 * or exported only after it. The host necessarily knows the contents of a deck
 * they chose themselves, so the claim is made about *opponents*, which is the
 * claim that is actually true.
 *
 * That rule is a type here rather than a habit. `botDeckSourceSchema` is the
 * private configuration the host and the server hold; `botDeckSourcePublicSchema`
 * is the projection every other seat sees, and `publicDeckSourceOf` is the only
 * way to get from one to the other. Nothing has to remember to strip a field,
 * because the public union has no field to strip: no card list, no generator
 * seed, no deck hash, no saved-deck name and no saved-deck ID appears in it at
 * all.
 *
 * `exact_precon` is the one mode whose public projection keeps its identifier.
 * A precon is shipped public content — every client has the list already — so
 * hiding the ID would protect nothing and would stop the lobby saying which
 * shipped deck the seat is playing.
 */

/** Four modes, and no fifth: AI Lab finalists as a deck source need M08. */
export const BOT_DECK_MODES = [
  'exact_precon',
  'exact_saved_deck',
  'commander_generated',
  'autonomous_generated',
] as const;
export const botDeckModeSchema = z.enum(BOT_DECK_MODES);
export type BotDeckMode = z.infer<typeof botDeckModeSchema>;

/** A generator seed, in the string form `SEED_DERIVATION_VERSION` already uses. */
export const botSeedSchema = z.string().min(1).max(128);

/** A deck fingerprint. Opaque here: how it is taken belongs to `HASH_VERSION`. */
export const deckHashSchema = z.string().min(8).max(128);

/**
 * A saved deck frozen at the moment the host chose it (M09.6).
 *
 * A snapshot rather than a reference, so a later edit in the deck builder cannot
 * reach into a live match. `sourceDeckId` records where it came from; it is not
 * a live pointer, and it never leaves the private configuration.
 */
export const botDeckSnapshotSchema = z.strictObject({
  sourceDeckId: z.string().min(1).max(64),
  name: z.string().min(1).max(80),
  commanderId: cardIdSchema,
  /** The frozen list. `validateDeck` remains the authority on its legality. */
  cardIds: z.array(cardIdSchema).min(1),
  deckHash: deckHashSchema,
});
export type BotDeckSnapshot = z.infer<typeof botDeckSnapshotSchema>;

/**
 * What a generated deck can say about itself (M09.8–M09.10).
 *
 * `generatorVersion` is a string this package does not own: the shared generator
 * carries its own constant, and copying the number here would give it two
 * owners. `legalPoolSize` and `forcedInclusionFloor` are recorded because Wave 1
 * Commander-legal pools are 41–42 cards for a 40-card singleton deck, so
 * generated decks are minimally different from one another — the UI says so, and
 * this is where it reads that from rather than from a comment.
 */
export const generatedDeckProvenanceSchema = z.strictObject({
  generatorVersion: z.string().min(1).max(32),
  /** Which construction mode produced it. Exact modes never generate. */
  mode: z.enum(['commander_generated', 'autonomous_generated']),
  formatId: formatIdSchema,
  /** The seed this deck was built from, after any rerolls. */
  seed: botSeedSchema,
  /** How many explicit rerolls preceded it. 0 is the first generation. */
  rerollCount: z.number().int().min(0).max(999),
  commanderId: cardIdSchema,
  deckHash: deckHashSchema,
  /** Cards the format left legal for this Commander, before construction. */
  legalPoolSize: z.number().int().min(0),
  /** How many of those the deck had to take because the pool is that small. */
  forcedInclusionFloor: z.number().int().min(0),
});
export type GeneratedDeckProvenance = z.infer<typeof generatedDeckProvenanceSchema>;

/**
 * The private configuration. Held by the host and the authoritative server.
 *
 * `generated` is `null` until the deck is built and frozen, which is why the two
 * generated modes carry both a seed and a nullable provenance: the seed is the
 * instruction, the provenance is the result.
 */
export const botDeckSourceSchema = z.discriminatedUnion('mode', [
  z.strictObject({
    mode: z.literal('exact_precon'),
    preconId: preconIdSchema,
  }),
  z.strictObject({
    mode: z.literal('exact_saved_deck'),
    deck: botDeckSnapshotSchema,
  }),
  z.strictObject({
    mode: z.literal('commander_generated'),
    /** Chosen by the host. Public from the moment it is chosen. */
    commanderId: cardIdSchema,
    seed: botSeedSchema,
    generated: generatedDeckProvenanceSchema.nullable(),
  }),
  z.strictObject({
    mode: z.literal('autonomous_generated'),
    /** The bot picks the Commander too, from its own seed and no one's secrets. */
    seed: botSeedSchema,
    generated: generatedDeckProvenanceSchema.nullable(),
  }),
]);
export type BotDeckSource = z.infer<typeof botDeckSourceSchema>;

/**
 * The projection every other seat sees. Commander only, never a list.
 *
 * `commanderId` is nullable only for `autonomous_generated`, and only until the
 * bot has chosen — a seat whose Commander is genuinely not decided yet cannot
 * publish one, and saying `null` is more honest than publishing a placeholder.
 */
export const botDeckSourcePublicSchema = z.discriminatedUnion('mode', [
  z.strictObject({
    mode: z.literal('exact_precon'),
    /** Shipped public content: every client can already read the list. */
    preconId: preconIdSchema,
  }),
  z.strictObject({
    mode: z.literal('exact_saved_deck'),
    commanderId: cardIdSchema,
  }),
  z.strictObject({
    mode: z.literal('commander_generated'),
    commanderId: cardIdSchema,
  }),
  z.strictObject({
    mode: z.literal('autonomous_generated'),
    commanderId: cardIdSchema.nullable(),
  }),
]);
export type BotDeckSourcePublic = z.infer<typeof botDeckSourcePublicSchema>;

/**
 * The only way from private configuration to what opponents may see.
 *
 * Total over the union, so a fifth mode cannot be added without deciding what it
 * publishes — which is the decision the privacy rule is made of.
 */
export function publicDeckSourceOf(source: BotDeckSource): BotDeckSourcePublic {
  switch (source.mode) {
    case 'exact_precon':
      return { mode: 'exact_precon', preconId: source.preconId };
    case 'exact_saved_deck':
      return { mode: 'exact_saved_deck', commanderId: source.deck.commanderId };
    case 'commander_generated':
      return { mode: 'commander_generated', commanderId: source.commanderId };
    case 'autonomous_generated':
      return {
        mode: 'autonomous_generated',
        commanderId: source.generated?.commanderId ?? null,
      };
    default: {
      const never: never = source;
      throw new Error(`Unknown bot deck mode "${JSON.stringify(never)}".`);
    }
  }
}

/**
 * The Commander this seat is bringing, as far as the private configuration knows.
 *
 * `null` for `exact_precon` — the precon owns that fact, and duplicating it here
 * would create a second place for it to be wrong. A caller with the card
 * database resolves it from `preconId`, which is public content.
 */
export function configuredCommanderIdOf(source: BotDeckSource): string | null {
  switch (source.mode) {
    case 'exact_precon':
      return null;
    case 'exact_saved_deck':
      return source.deck.commanderId;
    case 'commander_generated':
      return source.commanderId;
    case 'autonomous_generated':
      return source.generated?.commanderId ?? null;
    default: {
      const never: never = source;
      throw new Error(`Unknown bot deck mode "${JSON.stringify(never)}".`);
    }
  }
}

/** Whether the mode builds a deck rather than being handed one. */
export function deckModeGenerates(mode: BotDeckMode): boolean {
  return mode === 'commander_generated' || mode === 'autonomous_generated';
}

/**
 * Which modes a build can actually honour, and which tranche owns the rest.
 *
 * M09.3 refuses an unsupported mode **by name** rather than accepting it and
 * failing later, and it reads this table to do so. Flipping an entry is how a
 * later tranche turns its mode on.
 */
export const DECK_MODE_SUPPORT: Readonly<
  Record<BotDeckMode, { readonly supported: boolean; readonly plannedIn: string | null }>
> = Object.freeze({
  exact_precon: { supported: true, plannedIn: null },
  exact_saved_deck: { supported: false, plannedIn: 'M09.6' },
  commander_generated: { supported: false, plannedIn: 'M09.9' },
  autonomous_generated: { supported: false, plannedIn: 'M09.10' },
});

export function deckModeIsSupported(mode: BotDeckMode): boolean {
  return DECK_MODE_SUPPORT[mode].supported;
}
