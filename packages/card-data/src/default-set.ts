import { unwrap } from '@tcg/shared';
import prototypeCore from './data/prototype_core.json' with { type: 'json' };
import { loadCardSets, type LoadedCardData } from './loader.js';

/** Raw, unvalidated payloads shipped with the prototype. */
export const BUNDLED_CARD_SETS: readonly unknown[] = [prototypeCore];

/**
 * Loads and validates the bundled development set. Invalid bundled data is a
 * programming error, so this throws with the structured issues attached.
 */
export function loadBundledCardData(): LoadedCardData {
  return unwrap(loadCardSets(BUNDLED_CARD_SETS), 'Bundled card data failed validation');
}
