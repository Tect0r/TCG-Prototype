import { CARD_SCHEMA_VERSION } from './schema/primitives.js';

/**
 * Card-set migrations.
 *
 * Card IDs are permanent, so an old data file must keep loading rather than
 * being rewritten by hand (CLAUDE.md §6). Each step upgrades one version and is
 * deliberately tolerant: it reshapes what it recognises and leaves everything
 * else for the schema to reject with a real message.
 *
 * v1 → v2 (Phase 3) does four things:
 *
 *  - wraps a bare `TargetSelector` in `{ kind: 'entity', selector }`, and turns
 *    `targetsSource: true` into the `{ kind: 'source' }` variant (Q23/Q29);
 *  - folds `on_deploy` triggered abilities into top-level `effects`, so deploy
 *    behaviour has exactly one authoring form (Q1);
 *  - rewrites an activated ability's `energyCost` / `exhaustsSource` into the
 *    structured `costs` array (Q3/Q27);
 *  - renames the `all` player selector to `all_players` and drops the
 *    never-implemented `target_player`.
 *
 * v2 → v3 (Precon Wave 1) renames the `swift` keyword to `rush` everywhere it
 * can appear.
 *
 * v3 → v4 (rule adjustments) stamps an explicit `activeZone` on every triggered
 * and activated ability, and gives an untimed Reaction every window.
 */

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function migratePlayerSelector(value: unknown): unknown {
  if (value === 'all') return 'all_players';
  // `target_player` was documented as unsupported and no card ever used it;
  // the nearest honest reading is "one chosen opponent".
  if (value === 'target_player') return 'opponent';
  return value;
}

/** A v1 target is a bare selector; v2 wraps it in a discriminated variant. */
function migrateTarget(value: unknown): unknown {
  if (!isObject(value)) return value;
  if (typeof value['kind'] === 'string') return value;

  const { targetsSource, chooser, ...rest } = value;
  if (targetsSource === true) return { kind: 'source' };

  const selector: Json = { ...rest };
  if (chooser !== undefined) selector['chooser'] = migratePlayerSelector(chooser);
  return { kind: 'entity', selector };
}

function migrateEffect(value: unknown): unknown {
  if (!isObject(value)) return value;
  const effect: Json = { ...value };
  if ('target' in effect) effect['target'] = migrateTarget(effect['target']);
  if ('player' in effect) effect['player'] = migratePlayerSelector(effect['player']);
  if ('controller' in effect && typeof effect['controller'] === 'string') {
    effect['controller'] = migratePlayerSelector(effect['controller']);
  }
  return effect;
}

function migrateEffects(value: unknown): unknown[] {
  return Array.isArray(value) ? value.map(migrateEffect) : [];
}

function migrateActivatedAbility(value: unknown): unknown {
  if (!isObject(value)) return value;
  const { energyCost, exhaustsSource, ...rest } = value;
  const ability: Json = { ...rest, effects: migrateEffects(rest['effects']) };

  if (!Array.isArray(ability['costs'])) {
    const costs: Json[] = [];
    if (typeof energyCost === 'number' && energyCost > 0) {
      costs.push({ type: 'energy', amount: energyCost });
    }
    if (exhaustsSource === true) costs.push({ type: 'exhaust_source' });
    ability['costs'] = costs;
  }
  return ability;
}

function migrateCard(value: unknown): unknown {
  if (!isObject(value)) return value;
  const card: Json = { ...value, schemaVersion: 2 };

  const rawAbilities = Array.isArray(card['abilities']) ? card['abilities'] : [];
  const deployEffects: unknown[] = [];
  const abilities: unknown[] = [];

  for (const raw of rawAbilities) {
    if (!isObject(raw)) continue;
    const effects = migrateEffects(raw['effects']);
    // `on_deploy` no longer exists as a trigger: its effects become part of the
    // card's own deploy resolution, appended after any authored `effects` so
    // the observable order is unchanged.
    if (raw['trigger'] === 'on_deploy') deployEffects.push(...effects);
    else abilities.push({ ...raw, effects });
  }

  card['effects'] = [...migrateEffects(card['effects']), ...deployEffects];
  card['abilities'] = abilities;

  if (Array.isArray(card['activatedAbilities'])) {
    card['activatedAbilities'] = card['activatedAbilities'].map(migrateActivatedAbility);
  }
  return card;
}

function migrateSetV1toV2(set: Json): Json {
  return {
    ...set,
    schemaVersion: 2,
    cards: Array.isArray(set['cards']) ? set['cards'].map(migrateCard) : set['cards'],
  };
}

/**
 * v2 → v3 renames the `swift` keyword to `rush`.
 *
 * Ruleset update §9 refuses to leave both names exposed for one behaviour, so
 * this is a rename rather than an alias: the ID moves everywhere it can appear
 * — printed keywords, `grant_keyword` / `remove_keyword` effects, card filters,
 * and static abilities — and no card can still say `swift` afterwards.
 */
const RENAMED_KEYWORDS: Readonly<Record<string, string>> = { swift: 'rush' };

function renameKeyword(value: unknown): unknown {
  return typeof value === 'string' ? (RENAMED_KEYWORDS[value] ?? value) : value;
}

function renameKeywordsDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(renameKeywordsDeep);
  if (!isObject(value)) return value;

  const next: Json = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'keyword') {
      next[key] = renameKeyword(entry);
    } else if (key === 'keywords' && Array.isArray(entry)) {
      next[key] = entry.map(renameKeyword);
    } else {
      next[key] = renameKeywordsDeep(entry);
    }
  }
  return next;
}

function migrateSetV2toV3(set: Json): Json {
  return {
    ...(renameKeywordsDeep(set) as Json),
    schemaVersion: 3,
    cards: Array.isArray(set['cards'])
      ? set['cards'].map((card) =>
          isObject(card) ? { ...(renameKeywordsDeep(card) as Json), schemaVersion: 3 } : card,
        )
      : set['cards'],
  };
}

/**
 * v3 → v4 writes down the ability zone every card was already assuming.
 *
 * Rule adjustment §3 makes the active zone explicit data and forbids inferring
 * it from prose, so a card that says nothing has to be given the default the
 * update prescribes: **battlefield-only**, including on a Commander.
 *
 * There is exactly one exception, and it is not a hedge. A Commander with
 * `cost: null` is the older zone-only Commander — it can never be deployed, so
 * an activated ability printed on it could only ever have meant "from the
 * Command Zone". Defaulting those to `battlefield` would not enforce a new rule;
 * it would silently delete an ability from a card that has no other way to use
 * it. Deployable Commanders (`cost` set) take the prescribed default and must
 * say so in their data if they mean otherwise.
 */
function migrateAbilityZones(card: Json): Json {
  const zoneOnlyCommander = card['type'] === 'commander' && card['cost'] === null;
  const fallback = zoneOnlyCommander ? 'commander_zone' : 'battlefield';

  const withZone = (value: unknown): unknown => {
    if (!isObject(value) || value['activeZone'] !== undefined) return value;
    return { ...value, activeZone: fallback };
  };

  const next: Json = { ...card, schemaVersion: 4 };
  if (Array.isArray(next['abilities'])) next['abilities'] = next['abilities'].map(withZone);
  if (Array.isArray(next['activatedAbilities'])) {
    next['activatedAbilities'] = next['activatedAbilities'].map(withZone);
  }
  return next;
}

/**
 * A Reaction authored before timing existed can only mean "whenever a window is
 * open": there was no field in which to say anything narrower, so narrowing it
 * here would be inventing a restriction its author never wrote.
 */
const ALL_REACTION_WINDOWS = [
  'after_attackers_declared',
  'before_blockers_declared',
  'after_blockers_declared',
  'after_combat_damage',
  'after_combat',
  'when_opponent_plays_spell',
] as const;

function migrateSetV3toV4(set: Json): Json {
  const cards = Array.isArray(set['cards'])
    ? set['cards'].map((card) => {
        if (!isObject(card)) return card;
        const next = migrateAbilityZones(card);
        if (next['type'] === 'reaction' && next['reaction'] === undefined) {
          next['reaction'] = { windows: [...ALL_REACTION_WINDOWS] };
        }
        return next;
      })
    : set['cards'];
  return { ...set, schemaVersion: 4, cards };
}

const STEPS: Record<number, (set: Json) => Json> = {
  1: migrateSetV1toV2,
  2: migrateSetV2toV3,
  3: migrateSetV3toV4,
};

/**
 * Upgrades a raw card set to the current schema version, one step at a time.
 * Returns the payload unchanged when it is already current.
 */
export function migrateCardSet(raw: Json, fromVersion: number): Json {
  let current = raw;
  for (let version = fromVersion; version < CARD_SCHEMA_VERSION; version += 1) {
    const step = STEPS[version];
    if (!step) break;
    current = step(current);
  }
  return current;
}

/** Exposed for tests: whether a migration path exists at all. */
export function canMigrateCardSet(fromVersion: number): boolean {
  if (fromVersion === CARD_SCHEMA_VERSION) return true;
  for (let version = fromVersion; version < CARD_SCHEMA_VERSION; version += 1) {
    if (!STEPS[version]) return false;
  }
  return fromVersion >= 1;
}
