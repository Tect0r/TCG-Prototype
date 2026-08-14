import { z } from 'zod';

/**
 * Bot style (M09.1) — what a bot *prefers*, and nothing about how well it plays.
 *
 * The second of the four independent axes
 * ([ADR 0024](../../../docs/architecture/0024-live-bot-seats.md) §5). Each style
 * names one of the shipped heuristic weight vectors in `@tcg/bot-interface`, and
 * the correspondence is enforced by a test over there rather than trusted here —
 * this package deliberately does not depend on the pilots, so that a wire
 * contract never drags a decision procedure onto a client with it.
 *
 * `random_legal` is **not** a style. It is a legality probe with no preferences,
 * belongs to the `random_legal` agent class, and would read as "an even easier
 * Easy" if it were offered beside the three below — which is exactly the pooled
 * skill axis this milestone refuses to build.
 *
 * `automatic` — deriving a style from recorded deck construction data — is
 * M09.16's, and is deliberately absent until it has a deterministic documented
 * mapping and a named fallback.
 */

/** Ordered as the lobby lists them. Each maps to one published weight vector. */
export const BOT_STYLES = ['aggressive', 'defensive', 'value'] as const;
export const botStyleSchema = z.enum(BOT_STYLES);
export type BotStyle = z.infer<typeof botStyleSchema>;

export interface BotStyleDefinition {
  readonly id: BotStyle;
  readonly label: string;
  /** One sentence a lobby can print beside the control. */
  readonly summary: string;
  /**
   * The `PilotId` in `@tcg/bot-interface` whose weight vector this style is.
   * A string rather than the imported union, because the dependency runs the
   * other way; `bot-config.test.ts` in that package proves every value here is a
   * real heuristic pilot.
   */
  readonly pilotId: string;
}

export const BOT_STYLE_REGISTRY: Readonly<Record<BotStyle, BotStyleDefinition>> = Object.freeze({
  aggressive: {
    id: 'aggressive',
    label: 'Aggressive',
    summary: 'Prices damage and pressure above board safety.',
    pilotId: 'aggressive',
  },
  defensive: {
    id: 'defensive',
    label: 'Defensive',
    summary: 'Prices its own survival and blockers above racing.',
    pilotId: 'defensive',
  },
  value: {
    id: 'value',
    label: 'Value',
    summary: 'Prices card advantage and board value above either.',
    pilotId: 'value',
  },
});

export function botStyleDefinition(style: BotStyle): BotStyleDefinition {
  return BOT_STYLE_REGISTRY[style];
}

/** Same shape as `difficultyRegistryGaps()`, for the same reason. */
export function botStyleRegistryGaps(): string[] {
  const problems: string[] = [];
  const known = new Set<string>(BOT_STYLES);

  for (const key of Object.keys(BOT_STYLE_REGISTRY)) {
    if (!known.has(key)) problems.push(`style "${key}" is defined but not in the list.`);
  }
  for (const style of BOT_STYLES) {
    const definition = BOT_STYLE_REGISTRY[style];
    if (definition.id !== style) problems.push(`style "${style}" is filed under the wrong key.`);
    if (definition.pilotId.length === 0) problems.push(`style "${style}" names no pilot.`);
  }
  return problems;
}
