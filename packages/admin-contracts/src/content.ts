import { z } from 'zod';

/**
 * What a builder may offer: the precons the active format publishes and the
 * pilots that can fly them.
 *
 * A form that lists precons has to get the list from somewhere, and there are
 * exactly two candidates. It could hold one — which is the second copy of
 * content this repository keeps refusing, stale the day a precon is renamed and
 * silently wrong the day one becomes unplayable. Or it can be told, per
 * connection, by the process that resolves them. This is the shape of being
 * told.
 *
 * ## Why a refusal travels with the precon rather than filtering it out
 *
 * `refusals` is a field on the row and it is usually empty. When it is not, the
 * environment has said it cannot play that precon, and a chooser that had
 * quietly dropped it would leave an administrator unable to tell *this format
 * publishes three precons* from *this format publishes four and one of them is
 * broken*. The second is a content finding, and hiding it inside a filter is how
 * it stays hidden. The screen shows the row, disables it, and prints why.
 *
 * ## Why the pilot rows carry an evidence field
 *
 * `playQualityEvidence` is the milestone's own rule made selectable rather than
 * remembered. A selection made only of pilots for which it is `false` produces a
 * run that is genuine evidence about legality, termination and crashes and is
 * evidence about balance in no sense at all — so the builder can say so at the
 * moment the selection is made, instead of a result screen saying it afterwards
 * to somebody who has already drawn a conclusion.
 *
 * ## Nothing here is a card, a decklist or a pool
 *
 * The rows are identifiers, names, counts and verdicts. There is no card list on
 * a precon and no weight vector on a pilot: a builder needs to *choose* between
 * them, and the contents of either are the run's business. That also keeps this
 * answer small enough to be re-fetched whenever a form is opened, which is what
 * makes "validated against current content" mean the content as it is now.
 */

/**
 * An identifier the server resolves — a precon, a pilot, a Commander.
 *
 * Deliberately shallow, exactly as `presets.ts` says of its own: the real shape
 * of a precon ID belongs to `@tcg/card-data` and a pilot ID's to
 * `@tcg/bot-interface`, and restating either here would be the second copy this
 * package exists to refuse.
 *
 * Exported because M08.10 filters a catalog listing by precon and by Commander,
 * and the values a filter names have to be the values this answer offers. A
 * second, differently bounded spelling in `filters.ts` would be a filter that
 * could name an identifier no content catalog can produce.
 */
export const contentIdSchema = z.string().min(1).max(64);
const resolvedIdSchema = contentIdSchema;

/** One precon the active format publishes, with this build's verdict on it. */
export const contentPreconSchema = z.strictObject({
  preconId: resolvedIdSchema,
  name: z.string().min(1).max(120),
  /** The authored one-line strategy, as content states it. */
  strategy: z.string().max(400),
  commanderId: resolvedIdSchema,
  /** Cards in the deck, excluding the Commander. */
  cardCount: z.number().int().min(0).max(1000),
  /** Why this build's environment refuses it. Empty when it does not. */
  refusals: z.array(z.string().min(1).max(400)).max(16).default([]),
});
export type ContentPrecon = z.infer<typeof contentPreconSchema>;

/** One pilot this build ships, and what a run it flies may be cited for. */
export const contentPilotSchema = z.strictObject({
  pilotId: resolvedIdSchema,
  /** The honest agent class (M05.4). Never averaged with a pilot ID. */
  agentClass: z.string().min(1).max(64),
  /** Whether that class can carry a claim about how well the game was played. */
  playQualityEvidence: z.boolean(),
});
export type ContentPilot = z.infer<typeof contentPilotSchema>;

/**
 * The content one connection may build a precon benchmark from.
 *
 * `formatId` is on the answer rather than assumed from `capabilities`, because a
 * form validates what it offers against *this* reading: a client that read the
 * precons from one answer and the format from another could show a selection
 * belonging to neither.
 */
export const contentCatalogSchema = z.strictObject({
  formatId: z.string().min(1).max(64),
  precons: z.array(contentPreconSchema).max(64),
  pilots: z.array(contentPilotSchema).min(1).max(32),
});
export type ContentCatalog = z.infer<typeof contentCatalogSchema>;

/** Precons the environment reported no refusal for — the ones a run may name. */
export function playablePrecons(catalog: ContentCatalog): readonly ContentPrecon[] {
  return catalog.precons.filter((precon) => precon.refusals.length === 0);
}

/**
 * The sentence a builder puts beside a selection that can produce no balance
 * evidence.
 *
 * A constant rather than prose each screen writes, for the same reason
 * `FORCED_INCLUSION_CAVEAT` is one: it is a rule about what a number may be read
 * to mean, and a rule restated in three places is a rule that will be worded
 * three ways.
 */
export const NO_PLAY_QUALITY_CAVEAT =
  'Every pilot in this selection is one that makes no attempt to play well. The run is genuine ' +
  'evidence about legality, termination, loops and crashes, and it is not evidence about ' +
  'balance in any sense — a win rate from it means nothing at all.';
