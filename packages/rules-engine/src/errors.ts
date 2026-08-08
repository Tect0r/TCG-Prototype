import { z } from 'zod';

/**
 * Structured, serializable engine failures. An action that produces one of
 * these leaves the input state completely untouched — no partial mutation, no
 * RNG advance (CLAUDE.md §10 acceptance criteria).
 */
export const ENGINE_ERROR_CODES = [
  'engine/match_over',
  'engine/wrong_player',
  'engine/wrong_phase',
  'engine/choice_pending',
  'engine/no_choice_pending',
  'engine/unknown_choice',
  'engine/invalid_selection',
  'engine/unknown_instance',
  'engine/wrong_zone',
  'engine/not_your_card',
  'engine/insufficient_energy',
  'engine/no_free_slot',
  'engine/slot_occupied',
  'engine/relic_limit',
  'engine/no_legal_target',
  'engine/illegal_attacker',
  'engine/illegal_blocker',
  'engine/illegal_defender',
  'engine/cost_unpayable',
  'engine/eliminated',
  'engine/duplicate_attacker',
  'engine/duplicate_blocker',
  'engine/blocker_limit',
  'engine/unknown_card_definition',
  'engine/mulligan_already_submitted',
  'engine/invalid_action',
  'engine/resolution_limit',
  'engine/repeated_state',
  'engine/unsupported_effect',
] as const;

export const engineErrorCodeSchema = z.enum(ENGINE_ERROR_CODES);
export type EngineErrorCode = z.infer<typeof engineErrorCodeSchema>;

export const engineErrorSchema = z.strictObject({
  code: engineErrorCodeSchema,
  message: z.string().min(1),
  /** Machine-readable detail: offending IDs, limits, expected phase, and so on. */
  context: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});

export type EngineError = z.infer<typeof engineErrorSchema>;

export function engineError(
  code: EngineErrorCode,
  message: string,
  context?: Record<string, string | number | boolean>,
): EngineError {
  return context === undefined ? { code, message } : { code, message, context };
}
