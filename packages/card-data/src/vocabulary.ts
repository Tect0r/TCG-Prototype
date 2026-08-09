import {
  COLOR_IDS,
  POWER_CLASSES,
  ROLES,
  type ColorId,
  type PowerClass,
  type Role,
} from './schema/primitives.js';

/**
 * Display metadata for the fixed vocabularies. Kept beside the card data so the
 * UI never hard-codes a label, and so renaming a display name cannot break IDs.
 *
 * Keywords are not here: they carry player-facing definitions as well as names,
 * so they live in their own registry in `keywords.ts`.
 *
 * Colour names and swatches are placeholders pending art direction; see
 * docs/rules/open-decisions.md.
 */
export interface ColorInfo {
  readonly id: ColorId;
  readonly name: string;
  /** CSS colour used for swatches and card frames. */
  readonly swatch: string;
  /** Readable foreground colour to pair with `swatch`. */
  readonly onSwatch: string;
}

export const COLOR_INFO: Readonly<Record<ColorId, ColorInfo>> = {
  white: { id: 'white', name: 'White', swatch: '#e8e2cf', onSwatch: '#2b2716' },
  blue: { id: 'blue', name: 'Blue', swatch: '#3d7dc4', onSwatch: '#f2f7fd' },
  black: { id: 'black', name: 'Black', swatch: '#4a4553', onSwatch: '#efecf3' },
  red: { id: 'red', name: 'Red', swatch: '#c0533c', onSwatch: '#fdf3f1' },
  green: { id: 'green', name: 'Green', swatch: '#4f8b56', onSwatch: '#f1f8f2' },
};

export const COLOR_LIST: readonly ColorInfo[] = COLOR_IDS.map((id) => COLOR_INFO[id]);

/** Presentation for cards with an empty colour identity. */
export const NEUTRAL_INFO = {
  name: 'Neutral',
  swatch: '#8d8578',
  onSwatch: '#f7f5f1',
} as const;

export const ROLE_NAMES: Readonly<Record<Role, string>> = {
  token: 'Token',
  attacker: 'Attacker',
  blocker: 'Blocker',
  support: 'Support',
  enabler: 'Enabler',
  payoff: 'Payoff',
  removal: 'Removal',
  finisher: 'Finisher',
  build_around: 'Build-around',
};

export const ROLE_LIST: readonly Role[] = ROLES;

export const POWER_CLASS_NAMES: Readonly<Record<PowerClass, string>> = {
  minor: 'Minor',
  standard: 'Standard',
  major: 'Major',
  centerpiece: 'Centerpiece',
};

export const POWER_CLASS_LIST: readonly PowerClass[] = POWER_CLASSES;
