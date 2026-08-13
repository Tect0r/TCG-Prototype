import type { CardInstanceView } from '@tcg/rules-engine';

/**
 * The presentation-only Token grouping layer (M06.1, answering Q42).
 *
 * A battlefield with 117 Goblin Tokens on it is unreadable one tile at a time,
 * so identical Tokens are drawn as one tile with a count. Three rules keep that
 * safe, and all three are structural rather than promises:
 *
 *  1. **Nothing here touches match state.** Every function in this file takes a
 *     `PlayerView` and returns a new array. No instance ID is invented,
 *     rewritten or reused as a group's identity, and the engine has no idea the
 *     layer exists — there is no stack object in `MatchState` and never will be.
 *  2. **Nothing is dropped and nothing is duplicated.** Concatenating every
 *     entry's members reproduces the seat's `units` list as a multiset — same
 *     instances, each exactly once. It is not the same *sequence*: gathering a
 *     tile's members pulls later ones forward past whatever was between them,
 *     which is what a tile is. Position is presentation and nothing reads it;
 *     `units` is "dense and unbounded; position is arrival order, not a slot".
 *     The multiset equality is asserted in the tests, which is what makes
 *     "grouping on and off offer the same units" checkable rather than hoped
 *     for.
 *  3. **Only Tokens group.** A non-Token Unit is always its own entry, however
 *     many copies of it are out. Grouping real cards is explicitly out of
 *     scope (M06 exclusions).
 *
 * ## The grouping key — Q42, answered 2026-08-13
 *
 * Two Tokens share a tile only when their **controller, definition and entire
 * public interaction-relevant state** match: current attack and health, marked
 * damage, Ready/Exhausted, Newly Deployed, effective keywords, a pending
 * "will not Ready", whether Barrier has been spent, and what they are doing in
 * this combat.
 *
 * The alternative — grouping on definition alone — was measured and rejected.
 * Across three complete four-seat Wave 1 precon matches the strict key produced
 * 631 tiles where definition-only produced 441 (1.43×), and the worst board
 * anyone reached, 117 `goblin_token` on one seat, came out as **two** tiles: 64
 * Newly Deployed and 53 Ready. So the honest key costs almost nothing and the
 * dishonest one would have hidden, on that board, the fact that 64 of those
 * Tokens could not attack.
 *
 * ## What a group is *not*
 *
 * It is not a targeting unit. `groupByTokenDefinition` (`containment_pulse`)
 * expands a chosen Token into every Token of the same **definition** controlled
 * by the same player, whatever state they are in — so a card that hits "a Token
 * stack" reaches across several tiles on purpose. A tile is a way to read the
 * board, and the engine's answer to "what did that card hit" is unchanged by it.
 *
 * ## The viewer's own half-made decision (M06.2)
 *
 * A thirteenth field joins the key: `selection`, the marker the caller puts on
 * an entity the viewer has already picked but not yet committed — an attacker
 * aimed at a seat, a blocker assigned to an attacker, an option ticked in a
 * pending choice. It is local, uncommitted and on the viewer's own screen, so
 * reading it crosses no boundary; and folding it into the key is what makes
 * three Tokens aimed at one seat a tile of their own **before** the declaration
 * is confirmed, exactly as the engine's `attacking` will split them the moment
 * it is. The marker is also the words the tile shows, so a tile can never
 * summarise a group by something that did not decide it.
 *
 * ## Not only the battlefield
 *
 * The same rule lays out any list of entity IDs drawn from one view — a seat's
 * units, a pending choice's `validEntityIds`, the sources offering an activated
 * ability. Anything the view does not describe as a Token comes back as its own
 * tile, so a player ID or a `yes`/`no` option is passed through untouched.
 *
 * ## Not only the match client (M06.3)
 *
 * The source is a **projection**, not a `PlayerView`: anything carrying
 * `CardInstanceView`s and a combat state can be laid out. A `PlayerView`
 * satisfies it as it stands, and the AI spectator — which reads `MatchState`
 * directly, because no human sits at a seat — satisfies it by projecting the
 * battlefield through the engine's own `instanceView`. That is deliberate. Both
 * surfaces group by the same eleven fields read out of the same function, so
 * "the spectator must not change grouping semantics" is a property of the code
 * rather than a pair of readings somebody has to keep in step. It also means
 * the layer cannot see a hand: a projection is built by its caller, and what a
 * caller may project is decided where it already was.
 */

/** Which fields of the view a Token's tile identity is cut from. */
export const TOKEN_GROUP_KEY_FIELDS = [
  'controller',
  'definitionId',
  'attack',
  'health',
  'markedDamage',
  'exhausted',
  'summoningSick',
  'keywords',
  'willNotReady',
  'barrierSpent',
  'attacking',
  'blocking',
  /** The viewer's own uncommitted pick, if any (M06.2). */
  'selection',
] as const;

/**
 * Everything the layer reads (M06.3).
 *
 * Structural on purpose: a `PlayerView` is one, and so is a spectator's
 * projection of a playback frame. Nothing else is required, and in particular
 * no hand, no deck and no legality — a tile is cut from public board state and
 * the viewer's own local marks, and this type is what says so.
 */
export interface GroupingSource {
  readonly instances: Readonly<Record<string, CardInstanceView | undefined>>;
  readonly combat: {
    readonly attacks: readonly {
      readonly attackerInstanceId: string;
      readonly defenderPlayerId: string;
    }[];
    readonly blocks: readonly {
      readonly attackerInstanceId: string;
      readonly blockerInstanceId: string;
    }[];
    /**
     * Blocker submissions the source is willing to show. A `PlayerView` carries
     * only the viewer's own; a spectator frame carries every seat's, and that is
     * the spectator's existing licence rather than a new one.
     */
    readonly submissions: readonly {
      readonly blocks: readonly {
        readonly attackerInstanceId: string;
        readonly blockerInstanceId: string;
      }[];
    }[];
  };
}

/** What this Token is doing in the combat currently on the board. */
export interface TokenCombatRole {
  /** The seat this Token is attacking, or `null` if it is not attacking. */
  readonly attackingPlayerId: string | null;
  /** The attacker this Token is blocking, or `null` if it is not blocking. */
  readonly blockingInstanceId: string | null;
}

const NOT_IN_COMBAT: TokenCombatRole = Object.freeze({
  attackingPlayerId: null,
  blockingInstanceId: null,
});

/**
 * Combat participation as the viewer may see it.
 *
 * Public `blocks` are populated only once every defender has answered, so the
 * viewer's own outstanding submission is added on top: those are their own
 * blockers and their own decision, already on their screen. No other seat's
 * submission is read, because `PlayerView` never carries one.
 */
function combatRoles(view: GroupingSource): ReadonlyMap<string, TokenCombatRole> {
  const roles = new Map<string, TokenCombatRole>();
  const put = (instanceId: string, patch: Partial<TokenCombatRole>): void => {
    const current = roles.get(instanceId) ?? NOT_IN_COMBAT;
    roles.set(instanceId, { ...current, ...patch });
  };

  for (const attack of view.combat.attacks) {
    put(attack.attackerInstanceId, { attackingPlayerId: attack.defenderPlayerId });
  }
  const blocks = [
    ...view.combat.blocks,
    ...view.combat.submissions.flatMap((submission) => submission.blocks),
  ];
  for (const block of blocks) {
    put(block.blockerInstanceId, { blockingInstanceId: block.attackerInstanceId });
  }
  return roles;
}

/**
 * The tile identity of one Token.
 *
 * Every field named in `TOKEN_GROUP_KEY_FIELDS` appears here, and the keyword
 * list is sorted so that two Tokens granted the same keywords in a different
 * order are still the same Token. The string is opaque: nothing parses it back.
 */
export function tokenGroupKey(
  instance: CardInstanceView,
  role: TokenCombatRole,
  selection: SelectionMarker = null,
): string {
  return [
    instance.controller,
    instance.definitionId,
    instance.attack,
    instance.health,
    instance.markedDamage,
    instance.exhausted ? 'exh' : 'rdy',
    instance.summoningSick ? 'new' : 'settled',
    [...instance.keywords].sort().join('+'),
    instance.willNotReady ? 'held' : 'readies',
    instance.barrierSpent ? 'barrier_spent' : 'barrier_intact',
    role.attackingPlayerId ?? '-',
    role.blockingInstanceId ?? '-',
    selection ?? '-',
  ].join('|');
}

/**
 * What the surface has marked this entity as, in the words shown on the tile.
 *
 * `null` is "unmarked". Anything else both splits the group and is printed on
 * it, which is what keeps the two from disagreeing. It is always local to the
 * surface: the viewer's own uncommitted pick in a match (M06.2), and the Tokens
 * the playback step being watched is about in the spectator (M06.3) — which is
 * how one Token out of a hundred-strong stack can be shown to be the one that
 * just died.
 */
export type SelectionMarker = string | null;

/** One tile in a laid-out list: a lone entity, or a run of identical Tokens. */
export type TileEntry =
  | {
      readonly kind: 'single';
      /** Stable React key. For a single, the instance's own ID. */
      readonly key: string;
      readonly instanceId: string;
    }
  | {
      readonly kind: 'group';
      /**
       * Stable React key: the grouping key, which is a function of the shared
       * state and so survives a member joining or leaving. It is never an
       * instance ID — a group has no identity of its own in the engine.
       */
      readonly key: string;
      readonly definitionId: string;
      /** Every Token behind the tile, in the seat's own arrival order. */
      readonly instanceIds: readonly string[];
      /**
       * The member whose card the tile draws. The first in arrival order, so
       * the tile does not change appearance when a later member is defeated.
       */
      readonly representativeInstanceId: string;
      readonly role: TokenCombatRole;
      /** The uncommitted pick every member shares, or `null` if none has one. */
      readonly selection: SelectionMarker;
    };

export interface GroupEntitiesOptions {
  /**
   * Off returns one `single` entry per unit, in the seat's own order — the
   * pre-M06 board exactly. Kept as a real code path rather than a debug flag
   * because "grouping on and off are the same match" is an acceptance criterion
   * somebody has to be able to check by playing.
   */
  readonly enabled?: boolean;
  /** Tokens are only worth a tile once there are at least this many. */
  readonly minimumGroupSize?: number;
  /**
   * The viewer's own uncommitted pick for one entity, as words (M06.2).
   *
   * Part of the key, so a picked Token leaves the tile it was in and joins the
   * tile of everything picked the same way — which is the same movement the
   * engine's own state produces once the decision is committed.
   */
  readonly selectionOf?: (instanceId: string) => SelectionMarker;
}

/** Below this a group costs a player a click and saves them nothing. */
export const DEFAULT_MINIMUM_GROUP_SIZE = 2;

/**
 * Lays a list of entities out as tiles.
 *
 * Order is the list's own order — arrival order for a battlefield — taken from
 * the position of each group's **first** member, so a tile does not jump to the
 * end of the row when a Token is added to it, and a member that leaves a group
 * takes its own arrival position rather than the group's.
 */
export function groupEntities(
  view: GroupingSource,
  instanceIds: readonly string[],
  options: GroupEntitiesOptions = {},
): TileEntry[] {
  const enabled = options.enabled ?? true;
  const minimum = options.minimumGroupSize ?? DEFAULT_MINIMUM_GROUP_SIZE;

  if (!enabled) {
    return instanceIds.map((instanceId) => ({ kind: 'single', key: instanceId, instanceId }));
  }

  const roles = combatRoles(view);
  // Built in one pass so a group keeps the position of its first member.
  const entries: TileEntry[] = [];
  const groupIndex = new Map<string, number>();

  for (const instanceId of instanceIds) {
    const instance = view.instances[instanceId];
    // An entity the view does not describe cannot be grouped by state it has
    // not been told, so it stays its own tile rather than joining one on a
    // guess. That is also what passes a player ID or a `yes`/`no` option
    // through a choice's option list untouched.
    if (!instance || !instance.isToken) {
      entries.push({ kind: 'single', key: instanceId, instanceId });
      continue;
    }

    const role = roles.get(instanceId) ?? NOT_IN_COMBAT;
    const selection = options.selectionOf?.(instanceId) ?? null;
    const key = tokenGroupKey(instance, role, selection);
    const existing = groupIndex.get(key);
    if (existing === undefined) {
      groupIndex.set(key, entries.length);
      entries.push({
        kind: 'group',
        key,
        definitionId: instance.definitionId,
        instanceIds: [instanceId],
        representativeInstanceId: instanceId,
        role,
        selection,
      });
      continue;
    }
    const entry = entries[existing];
    if (entry?.kind !== 'group') continue;
    entries[existing] = { ...entry, instanceIds: [...entry.instanceIds, instanceId] };
  }

  // A "group" of one is a unit with a count badge saying ×1 and an expand
  // button that reveals itself. Demoting it keeps the board honest.
  return entries.map((entry) =>
    entry.kind === 'group' && entry.instanceIds.length < minimum
      ? {
          kind: 'single' as const,
          key: entry.representativeInstanceId,
          instanceId: entry.representativeInstanceId,
        }
      : entry,
  );
}

/**
 * The shared state of a group, in the words the board already uses.
 *
 * Deliberately built from the same fields as the key, so a tile can never
 * summarise a group by something that did not go into deciding it was a group.
 */
export function tokenGroupSummary(
  instance: CardInstanceView,
  role: TokenCombatRole,
  nameOf: (playerId: string) => string,
  selection: SelectionMarker = null,
): string[] {
  const parts: string[] = [];
  parts.push(`${instance.attack} / ${Math.max(0, instance.health - instance.markedDamage)}`);
  if (instance.markedDamage > 0) parts.push(`${instance.markedDamage} dmg`);
  if (instance.keywords.length > 0) parts.push(instance.keywords.join(' · '));
  parts.push(instance.exhausted ? 'exhausted' : 'ready');
  if (instance.summoningSick) parts.push('newly deployed');
  if (instance.willNotReady) parts.push('will not ready');
  // Only said once it is true: "barrier intact" printed on every Barrier unit
  // would read as a second keyword rather than as a state.
  if (instance.barrierSpent) parts.push('barrier spent');
  if (role.attackingPlayerId !== null) parts.push(`attacking ${nameOf(role.attackingPlayerId)}`);
  if (role.blockingInstanceId !== null) parts.push('blocking');
  // Last, because it is the one part of the summary the viewer decided rather
  // than the board (M06.2).
  if (selection !== null) parts.push(selection);
  return parts;
}

/**
 * The accessible name of a tile (M06.2).
 *
 * A screen reader is read the count and the shared state as words. The visible
 * tile prints "×11", which is read out as a symbol and a number by some
 * screen readers and skipped entirely by others; and the expansion state is
 * `aria-expanded`'s job, so it is deliberately not in the name.
 */
export function tokenGroupLabel(name: string, count: number, summary: readonly string[]): string {
  const head = `${name} stack of ${count}`;
  return summary.length > 0 ? `${head} — ${summary.join(', ')}` : head;
}

/**
 * The accessible name of one member of an expanded tile (M06.2).
 *
 * Identical Tokens are, by construction, identical: without an ordinal a
 * screen-reader user hears the same button eleven times and cannot tell which
 * one they are about to sacrifice. The ordinal is presentation — it is the
 * member's position in the tile, not an engine identity — and every action it
 * leads to still carries the member's own instance ID.
 */
export function tokenMemberLabel(name: string, index: number, count: number): string {
  return `${name} ${index + 1} of ${count}`;
}

/** Every instance behind a laid-out list, in order. The inverse of grouping. */
export function entryInstanceIds(entries: readonly TileEntry[]): string[] {
  return entries.flatMap((entry) =>
    entry.kind === 'single' ? [entry.instanceId] : [...entry.instanceIds],
  );
}
