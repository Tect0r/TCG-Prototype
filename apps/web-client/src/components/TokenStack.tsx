import { useRef, type ReactNode } from 'react';
import type { CardDatabase } from '@tcg/card-data';
import {
  tokenGroupLabel,
  tokenGroupSummary,
  tokenMemberLabel,
  type GroupingSource,
  type TileEntry,
} from '../lib/token-grouping.js';

/**
 * The Token stack, as every surface draws it (M06.1–M06.3).
 *
 * Shared rather than copied, because M06.3's requirement is that the spectator
 * and the match board present a stack the *same* way: one grouping rule, one
 * summary, one expansion affordance, one set of accessible names. The two
 * surfaces differ in what a card looks like and in what clicking one does, so
 * those are the two things they pass in — a class-name variant and a
 * `renderEntity` function. Nothing else is allowed to diverge.
 *
 * A tile is presentation only. It has no instance ID of its own, clicking it
 * expands rather than acts, and every action or inspection leaves through a
 * member drawn by the caller's own `renderEntity` — the same function that
 * draws a lone entity — so a Token stays an independently addressable engine
 * instance and there is one interaction path rather than two.
 */

/** Which surface is drawing: it decides class names and nothing else. */
export type TileVariant = 'match' | 'spectator';

const CLASSES: Readonly<
  Record<TileVariant, { unit: string; exhausted: string; name: string; stats: string }>
> = {
  match: {
    unit: 'unit',
    exhausted: 'unit--exhausted',
    name: 'unit__name',
    stats: 'unit__stats',
  },
  spectator: {
    unit: 'spectator-unit',
    exhausted: 'spectator-unit--exhausted',
    name: 'spectator-unit__name',
    stats: 'spectator-unit__stats',
  },
};

/**
 * One tile standing for several identical Tokens, and its members.
 *
 * It draws the representative's card, the count, and the state the whole group
 * shares — and the state summary is built from the same fields that decided the
 * group, so a tile can never claim something that is only true of one member.
 *
 * ## Keyboard and screen reader (M06.2)
 *
 * The tile is an ordinary button, so it opens with Enter or Space. Its
 * accessible name carries the count and the shared state in words rather than
 * as "×11". The members are a labelled `group` immediately after it in DOM
 * order, so Tab walks into them, and each member's name carries its ordinal so
 * eleven identical cards are eleven distinguishable buttons. Escape anywhere
 * inside closes the tile and puts focus back on it, because tabbing back out of
 * a hundred Tokens is not an affordance.
 */
export function TokenGroup({
  entry,
  source,
  database,
  groupId,
  heading,
  variant = 'match',
  membersRole = 'group',
  expanded,
  onToggle,
  nameOf,
  renderMember,
}: {
  readonly entry: Extract<TileEntry, { kind: 'group' }>;
  readonly source: GroupingSource;
  readonly database: CardDatabase;
  /** Unique across every list on screen, so two tiles never share a DOM id. */
  readonly groupId: string;
  /** Replaces the card name on the tile, for a list that is not a battlefield. */
  readonly heading?: string | undefined;
  readonly variant?: TileVariant | undefined;
  /**
   * `group` where the members are things to act on, `list` where they are only
   * there to be read — a spectator's members are `listitem`s, because a chip
   * nobody can click is a list entry and calling it anything else would promise
   * an affordance that is not there.
   */
  readonly membersRole?: 'group' | 'list' | undefined;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly nameOf: (playerId: string) => string;
  readonly renderMember: (instanceId: string, ariaLabel: string) => ReactNode;
}) {
  const tile = useRef<HTMLButtonElement>(null);
  const instance = source.instances[entry.representativeInstanceId];
  if (!instance) return null;
  const skin = CLASSES[variant];
  const name = database.get(entry.definitionId)?.name ?? entry.definitionId;
  const count = entry.instanceIds.length;
  const summary = tokenGroupSummary(instance, entry.role, nameOf, entry.selection);
  const title = heading ?? name;
  const domId = `token-group-${groupId}`;
  const classes = [
    skin.unit,
    'unit-group',
    instance.exhausted ? skin.exhausted : '',
    expanded ? 'unit-group--expanded' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className="unit-group__wrap"
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !expanded) return;
        // Stopped here rather than allowed to bubble: Escape inside an open
        // stack means "close this stack", not "close whatever is outermost".
        event.stopPropagation();
        onToggle();
        tile.current?.focus();
      }}
    >
      <button
        type="button"
        ref={tile}
        className={classes}
        aria-expanded={expanded}
        aria-controls={domId}
        aria-label={tokenGroupLabel(title, count, summary)}
        onClick={onToggle}
      >
        <span className={skin.name}>
          {title}
          <span className="unit-group__count">×{count}</span>
        </span>
        <span className={skin.stats}>{summary.join(' · ')}</span>
        <span className="unit-group__affordance">
          {expanded ? `Hide these ${count}` : `Show all ${count}`}
        </span>
      </button>
      {expanded && (
        <div
          className="unit-group__members"
          id={domId}
          role={membersRole}
          aria-label={`${title}, ${count} ${membersRole === 'list' ? 'shown' : 'selectable'}`}
        >
          {entry.instanceIds.map((instanceId, index) =>
            renderMember(instanceId, tokenMemberLabel(name, index, count)),
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A laid-out list of entities: lone ones as themselves, identical Tokens as
 * tiles (M06.2).
 *
 * One component for every list a Token can appear in — a seat's battlefield in
 * a match or in the spectator, a pending choice's options, the sources offering
 * an activated ability — so the grouping rule, the expansion affordance and the
 * accessible names cannot drift apart between them. `renderEntity` draws one
 * entity and is given the member label when it is being drawn inside a tile, so
 * the caller writes its handling once and gets both cases.
 */
export function TileList({
  entries,
  source,
  database,
  idPrefix,
  headingFor,
  variant,
  membersRole,
  expandedGroups,
  onToggleGroup,
  nameOf,
  renderEntity,
}: {
  readonly entries: readonly TileEntry[];
  readonly source: GroupingSource;
  readonly database: CardDatabase;
  readonly idPrefix: string;
  readonly headingFor?: ((entry: Extract<TileEntry, { kind: 'group' }>) => string) | undefined;
  readonly variant?: TileVariant | undefined;
  readonly membersRole?: 'group' | 'list' | undefined;
  readonly expandedGroups: ReadonlySet<string>;
  readonly onToggleGroup: (groupId: string) => void;
  readonly nameOf: (playerId: string) => string;
  readonly renderEntity: (instanceId: string, ariaLabel?: string) => ReactNode;
}) {
  return (
    <>
      {entries.map((entry) => {
        if (entry.kind === 'single') return renderEntity(entry.instanceId);
        const groupId = `${idPrefix}:${entry.key}`;
        return (
          <TokenGroup
            key={groupId}
            entry={entry}
            source={source}
            database={database}
            groupId={groupId}
            heading={headingFor?.(entry)}
            variant={variant}
            membersRole={membersRole}
            expanded={expandedGroups.has(groupId)}
            onToggle={() => onToggleGroup(groupId)}
            nameOf={nameOf}
            renderMember={renderEntity}
          />
        );
      })}
    </>
  );
}
