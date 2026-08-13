import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { CardDatabase } from '@tcg/card-data';
import type { SeatId } from '@tcg/protocol';
import type {
  AttackDeclaration,
  CardInstanceView,
  PendingChoice,
  PlayerView,
  PlayerViewSummary,
} from '@tcg/rules-engine';
import { useCardDatabase } from '../../state/AppContext.js';
import { useMatchClient, useMatchState } from '../../state/MatchContext.js';
import type { SeatConnection } from '../../net/match-client.js';
import { buildLog } from '../../lib/event-text.js';
import {
  groupEntities,
  tokenGroupLabel,
  tokenGroupSummary,
  tokenMemberLabel,
  type SelectionMarker,
  type TileEntry,
} from '../../lib/token-grouping.js';
import { CardInspector, type InspectableCard } from '../help/CardInspector.js';

/**
 * The match board, for two to four players.
 *
 * Every element is rendered from the authoritative `PlayerView`: what is legal
 * comes from `view.legalActions`, never from a client-side rule (CLAUDE.md §11).
 * While an action is in flight, input is locked. Nothing here delays or owns a
 * rule — the server has already decided by the time anything re-renders.
 *
 * ## Help mode
 *
 * With Help mode on, every click inspects instead of acting. That is done by
 * replacing the click handler outright rather than by adding a guard inside it,
 * so there is no path where a player reading a card accidentally plays it,
 * attacks with it or picks it as a target. Turning Help mode on or off sends
 * nothing to the server and changes no match state.
 */

/**
 * What each pending choice is actually asking, in words.
 *
 * The engine sends a stable reason code and never display text, so the sentence
 * is the client's job (see `CHOICE_REASONS`). A reason with no entry falls back
 * to its humanised code, which is what every reason used to get — so adding a
 * reason engine-side degrades to the old wording rather than to a blank prompt.
 */
const CHOICE_PROMPTS: Readonly<Record<string, string>> = {
  effect_target: 'Choose a target',
  discard_effect: 'Discard',
  sacrifice_cost: 'Choose what to sacrifice to pay for this',
  discard_cost: 'Choose what to discard to pay for this',
  search_zone: 'Choose a card',
  reorder_zone: 'Put these in the order you want',
  hand_size_discard: 'Discard down to your maximum hand size',
  select_opponent: 'Choose an opponent',
  pay_additional_cost: 'Pay the additional cost to stop this being countered?',
  optional_effect: 'You may do this. Do you want to?',
  // Every seat is answering this same question, and none of the answers has
  // happened yet. Saying so is the point: a prompt that read like an ordinary
  // targeting choice would invite the player to plan around a board that is
  // about to change under them.
  each_player_choice: 'Every player is choosing. Pick yours — nothing happens until all are in',
  divide_damage: 'Split the damage — click a target once for each point',
};

/**
 * The sentence for one pending choice.
 *
 * Most reasons say everything on their own. `keep_exhausted` does not: the same
 * reason is raised at your own Ready Step and at somebody else's, so it used to
 * be worded "one enemy unit" and was wrong half the time. The engine now says
 * whose units are on offer, read from the seat being asked (M05.3), so the
 * prompt asks the question the player is actually being asked.
 */
function choicePrompt(choice: PendingChoice): string {
  if (choice.reason === 'keep_exhausted') {
    return choice.provenance.targetRelation === 'self'
      ? 'Pay to keep one of your own units Exhausted, or choose nothing'
      : 'Pay to keep one enemy unit Exhausted, or choose nothing';
  }
  return CHOICE_PROMPTS[choice.reason] ?? choice.reason.replace(/_/g, ' ');
}

/** One activated ability, with every source of the viewer's offering it. */
interface AbilityOffer {
  readonly abilityId: string;
  readonly energyCost: number;
  readonly sourceInstanceIds: readonly string[];
}

/**
 * The engine's flat list of activations, gathered by ability (M06.2).
 *
 * The cost is part of the identity, not just the label: the same ability on two
 * sources can legitimately cost different amounts, and merging those into one
 * row would print one of the two prices over both of them.
 */
function abilityOffers(
  abilities: readonly {
    readonly sourceInstanceId: string;
    readonly abilityId: string;
    readonly energyCost: number;
  }[],
): AbilityOffer[] {
  const offers: { abilityId: string; energyCost: number; sourceInstanceIds: string[] }[] = [];
  const index = new Map<string, number>();
  for (const ability of abilities) {
    const key = `${ability.abilityId}|${ability.energyCost}`;
    const at = index.get(key);
    if (at === undefined) {
      index.set(key, offers.length);
      offers.push({
        abilityId: ability.abilityId,
        energyCost: ability.energyCost,
        sourceInstanceIds: [ability.sourceInstanceId],
      });
      continue;
    }
    offers[at]?.sourceInstanceIds.push(ability.sourceInstanceId);
  }
  return offers;
}

/** A `confirm` choice's options are the literals `yes` and `no`, not entities. */
const CONFIRM_LABELS: Readonly<Record<string, string>> = { yes: 'Yes', no: 'No' };

/** Seats map one-to-one onto engine player IDs, so connection state can be keyed by either. */
function seatIdFor(playerId: string): SeatId | undefined {
  const map: Record<string, SeatId> = {
    player_1: 'seat_1',
    player_2: 'seat_2',
    player_3: 'seat_3',
    player_4: 'seat_4',
  };
  return map[playerId];
}

function UnitCard({
  instance,
  database,
  selected,
  highlighted,
  onClick,
  label,
  ariaLabel,
}: {
  readonly instance: CardInstanceView | undefined;
  readonly database: CardDatabase;
  readonly selected?: boolean | undefined;
  readonly highlighted?: boolean | undefined;
  /** Absent when the unit is not a legal click target right now. */
  readonly onClick?: (() => void) | undefined;
  readonly label?: string | undefined;
  /**
   * Set only for a member of an expanded Token stack (M06.2), where the visible
   * text of eleven identical cards is the same eleven times and a screen-reader
   * user needs to hear which one they are on.
   */
  readonly ariaLabel?: string | undefined;
}) {
  if (!instance) {
    return <div className="unit unit--empty">empty</div>;
  }
  const definition = database.get(instance.definitionId);
  const classes = [
    'unit',
    instance.exhausted ? 'unit--exhausted' : '',
    selected ? 'unit--selected' : '',
    highlighted ? 'unit--legal' : '',
    onClick ? 'unit--clickable' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      type="button"
      className={classes}
      onClick={onClick}
      disabled={!onClick}
      aria-label={ariaLabel}
    >
      <span className="unit__name">{definition?.name ?? instance.definitionId}</span>
      <span className="unit__stats">
        {instance.attack} / {Math.max(0, instance.health - instance.markedDamage)}
        {instance.markedDamage > 0 ? ` (${instance.markedDamage} dmg)` : ''}
      </span>
      {instance.keywords.length > 0 && (
        <span className="unit__keywords">{instance.keywords.join(' · ')}</span>
      )}
      {/* The view field is still `summoningSick`; the label a player reads is the
          ruleset's own term (ADR 0016 Q-B). */}
      {instance.summoningSick && <span className="unit__flag">newly deployed</span>}
      {/* A pending readiness prevention is public board state, and a player who
          could not see it would be unable to plan around a unit about to stay
          down for a whole turn cycle (M02.4). */}
      {instance.willNotReady && <span className="unit__flag">will not ready</span>}
      {label && <span className="unit__flag">{label}</span>}
    </button>
  );
}

/**
 * One tile standing for several identical Tokens, and its members (M06.1/M06.2).
 *
 * Presentation only: the tile has no instance ID of its own, and clicking it
 * expands the group rather than acting on it. Every action still goes through
 * the individual entities underneath — rendered by the caller's own
 * `renderMember`, which is the same function that draws a lone entity — so a
 * Token stays an independently addressable engine instance whatever list it is
 * being shown in, and there is one interaction path rather than two.
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
function TokenGroup({
  entry,
  view,
  database,
  groupId,
  heading,
  expanded,
  onToggle,
  nameOf,
  renderMember,
}: {
  readonly entry: Extract<TileEntry, { kind: 'group' }>;
  readonly view: PlayerView;
  readonly database: CardDatabase;
  /** Unique across every list on screen, so two tiles never share a DOM id. */
  readonly groupId: string;
  /** Replaces the card name on the tile, for a list that is not the board. */
  readonly heading?: string | undefined;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly nameOf: (playerId: string) => string;
  readonly renderMember: (instanceId: string, ariaLabel: string) => ReactNode;
}) {
  const tile = useRef<HTMLButtonElement>(null);
  const instance = view.instances[entry.representativeInstanceId];
  if (!instance) return null;
  const name = database.get(entry.definitionId)?.name ?? entry.definitionId;
  const count = entry.instanceIds.length;
  const summary = tokenGroupSummary(instance, entry.role, nameOf, entry.selection);
  const title = heading ?? name;
  const domId = `token-group-${groupId}`;
  const classes = [
    'unit',
    'unit-group',
    instance.exhausted ? 'unit--exhausted' : '',
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
        <span className="unit__name">
          {title}
          <span className="unit-group__count">×{count}</span>
        </span>
        <span className="unit__stats">{summary.join(' · ')}</span>
        <span className="unit-group__affordance">
          {expanded ? `Hide these ${count}` : `Show all ${count}`}
        </span>
      </button>
      {expanded && (
        <div
          className="unit-group__members"
          id={domId}
          role="group"
          aria-label={`${title}, ${count} selectable`}
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
 * One component for every list a Token can appear in — a seat's battlefield, a
 * pending choice's options, the sources offering an activated ability — so the
 * grouping rule, the expansion affordance and the accessible names cannot drift
 * apart between them. `renderEntity` draws one entity and is given the member
 * label when it is being drawn inside a tile, so the caller writes its click
 * handling once and gets both cases.
 */
function TileList({
  entries,
  view,
  database,
  idPrefix,
  headingFor,
  expandedGroups,
  onToggleGroup,
  nameOf,
  renderEntity,
}: {
  readonly entries: readonly TileEntry[];
  readonly view: PlayerView;
  readonly database: CardDatabase;
  readonly idPrefix: string;
  readonly headingFor?: ((entry: Extract<TileEntry, { kind: 'group' }>) => string) | undefined;
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
            view={view}
            database={database}
            groupId={groupId}
            heading={headingFor?.(entry)}
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

/**
 * Describes a card the local player is allowed to read.
 *
 * Returns `null` when the instance is not in the view at all — which is what
 * happens for every card the seat may not identify, so an inspect affordance
 * can never be built for hidden information.
 */
function inspectable(
  view: PlayerView,
  instanceId: string | null | undefined,
  label: string,
): InspectableCard | null {
  if (!instanceId) return null;
  const instance = view.instances[instanceId];
  if (!instance) return null;
  return { instanceId, definitionId: instance.definitionId, label };
}

/**
 * What a card in your hand costs right now, as the player should read it.
 *
 * The view's own `energyCost` first: it is the authoritative current cost, and
 * it is populated for every card in the viewer's hand whether or not the card is
 * affordable. A card discounted by the board is therefore shown discounted
 * before it becomes playable, which is the only way the discount is visible at
 * all (M02.3). The legal-action entry and the printed cost are fallbacks for a
 * card the view did not describe.
 */
function handCostLabel(
  instance: CardInstanceView | undefined,
  option: { readonly energyCost: number } | undefined,
  definition: { readonly cost: number | null } | undefined,
): string {
  const cost = instance?.energyCost ?? option?.energyCost ?? definition?.cost ?? null;
  return cost === null ? '–' : `${cost}⚡`;
}

function PlayerHeader({
  player,
  database,
  view,
  isViewer,
  connection,
  awaitingBlockers,
  onInspect,
}: {
  readonly player: PlayerViewSummary;
  readonly database: CardDatabase;
  readonly view: PlayerView;
  readonly isViewer: boolean;
  readonly connection: SeatConnection | undefined;
  readonly awaitingBlockers: boolean;
  /** Set only in Help mode: makes the Commander and discard readable. */
  readonly onInspect: ((card: InspectableCard) => void) | null;
}) {
  const commander = view.instances[player.commanderInstanceId];
  const isActive = view.activePlayerId === player.playerId;
  const connected = connection?.connected ?? true;
  const classes = [
    'player-bar',
    isActive && !player.lost ? 'player-bar--active' : '',
    player.lost ? 'player-bar--out' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={classes}>
      <span className="player-bar__name">
        seat {player.seatIndex + 1}: {player.name}
        {isViewer ? ' (you)' : ''}
      </span>
      {player.lost ? (
        <span className="tag tag--error">
          eliminated{player.lossReason ? ` · ${player.lossReason.replace(/_/g, ' ')}` : ''}
        </span>
      ) : (
        <>
          <span className="player-bar__stat">♥ {player.health}</span>
          <span className="player-bar__stat">
            ⚡ {player.energy}/{player.maxEnergy}
          </span>
          <span className="player-bar__stat">hand {player.handCount}</span>
          <span className="player-bar__stat">deck {player.deckCount}</span>
          <span className="player-bar__stat">discard {player.discard.length}</span>
          {/* Only shown once something has actually left the game: a permanent
              "removed 0" would imply a pile that matters in every match. */}
          {player.removedCount > 0 ? (
            <span className="player-bar__stat">removed {player.removedCount}</span>
          ) : null}
          {onInspect && commander ? (
            <button
              type="button"
              className="player-bar__inspect"
              aria-label={`Inspect ${player.name}'s Commander`}
              onClick={() => {
                const card = inspectable(view, commander.instanceId, `${player.name}'s Commander`);
                if (card) onInspect(card);
              }}
            >
              cmd {database.get(commander.definitionId)?.name ?? '?'}
            </button>
          ) : (
            <span className="player-bar__stat">
              cmd {commander ? (database.get(commander.definitionId)?.name ?? '?') : '?'}
            </span>
          )}
        </>
      )}
      {isActive && !player.lost && <span className="tag tag--ok">active</span>}
      {/* Who has not answered yet is public; *what* they chose is not. */}
      {awaitingBlockers && <span className="tag tag--warn">choosing blockers</span>}
      {!connected && (
        <span className="tag tag--warn">
          disconnected
          {connection?.graceSeconds !== null && connection?.graceSeconds !== undefined
            ? ` · ${connection.graceSeconds}s`
            : ''}
        </span>
      )}
    </div>
  );
}

/**
 * Every public card belonging to one player, as inspectable entries.
 *
 * Built from `view.instances`, so an entry only exists for a card the seat may
 * legitimately identify. The viewer's own hand is added separately.
 */
function publicCardsOf(view: PlayerView, player: PlayerViewSummary): InspectableCard[] {
  const cards: (InspectableCard | null)[] = [
    ...player.units.map((instanceId) => inspectable(view, instanceId, `${player.name}'s board`)),
    ...player.relics.map((instanceId) => inspectable(view, instanceId, `${player.name}'s relics`)),
    inspectable(view, player.commanderInstanceId, `${player.name}'s Commander`),
    ...player.discard.map((instanceId) =>
      inspectable(view, instanceId, `${player.name}'s discard`),
    ),
  ];
  return cards.filter((card): card is InspectableCard => card !== null);
}

/** The discard pile, listed card by card. Discard piles are public. */
function DiscardStrip({
  player,
  view,
  database,
  onInspect,
}: {
  readonly player: PlayerViewSummary;
  readonly view: PlayerView;
  readonly database: CardDatabase;
  readonly onInspect: (card: InspectableCard) => void;
}) {
  if (player.discard.length === 0) return null;
  return (
    <div className="board__discard" aria-label={`${player.name} discard pile`}>
      {player.discard.map((instanceId) => {
        const card = inspectable(view, instanceId, `${player.name}'s discard`);
        if (!card) return null;
        return (
          <button
            key={instanceId}
            type="button"
            className="button--quiet"
            onClick={() => onInspect(card)}
          >
            {database.get(card.definitionId)?.name ?? card.definitionId}
          </button>
        );
      })}
    </div>
  );
}

/** One opponent's battlefield, with blocker assignment when they are attacking us. */
function OpponentBoard({
  player,
  view,
  database,
  locked,
  pendingBlocker,
  onAssignBlock,
  attackTarget,
  onChooseDefender,
  onInspect,
  grouping,
  expandedGroups,
  onToggleGroup,
  selectionOf,
}: {
  readonly player: PlayerViewSummary;
  readonly view: PlayerView;
  readonly database: CardDatabase;
  readonly locked: boolean;
  readonly pendingBlocker: string | null;
  readonly onAssignBlock: (attackerInstanceId: string) => void;
  /** Set while declaring attackers: clicking the header aims at this player. */
  readonly attackTarget: boolean;
  readonly onChooseDefender: () => void;
  /** Set only in Help mode, and then it replaces every other click handler. */
  readonly onInspect: ((card: InspectableCard) => void) | null;
  readonly grouping: boolean;
  readonly expandedGroups: ReadonlySet<string>;
  readonly onToggleGroup: (groupId: string) => void;
  /** How many of the viewer's own blockers are already aimed at this attacker. */
  readonly selectionOf: (instanceId: string) => SelectionMarker;
}) {
  const legal = view.legalActions;
  const attacksOnMe = new Map(
    view.combat.attacks.map((attack) => [attack.attackerInstanceId, attack.defenderPlayerId]),
  );
  const nameOf = (playerId: string): string =>
    view.players.find((seat) => seat.playerId === playerId)?.name ?? playerId;

  const renderUnit = (instanceId: string, ariaLabel?: string) => {
    const instance = view.instances[instanceId];
    const defenderId = attacksOnMe.get(instanceId);
    const blockable = legal.blocking?.attackerInstanceIds.includes(instanceId) ?? false;
    // An attacker is only clickable once one of our blockers is picked.
    // In Help mode the inspect handler replaces it entirely, so a click
    // can never assign a blocker while the player is reading.
    const inspect = inspectable(view, instanceId, `${player.name}'s board`);
    const assignBlock = onInspect
      ? inspect
        ? () => onInspect(inspect)
        : undefined
      : blockable && pendingBlocker !== null && !locked
        ? () => onAssignBlock(instanceId)
        : undefined;

    const attackedName =
      defenderId === undefined
        ? undefined
        : defenderId === view.viewerId
          ? 'attacking you'
          : `attacking ${nameOf(defenderId)}`;

    // The same words the tile shows, so a lone attacker and a stacked one carry
    // identical information about what the viewer has already aimed at it.
    const label = [attackedName, selectionOf(instanceId)].filter(Boolean).join(' · ');

    return (
      <UnitCard
        key={instanceId}
        instance={instance}
        database={database}
        highlighted={blockable && pendingBlocker !== null}
        label={label === '' ? undefined : label}
        ariaLabel={ariaLabel}
        onClick={assignBlock}
      />
    );
  };

  return (
    <div className="board__side" aria-label={`${player.name} battlefield`}>
      {attackTarget && !onInspect && (
        <button
          type="button"
          className="board__target"
          disabled={locked}
          onClick={onChooseDefender}
        >
          Attack {player.name}
        </button>
      )}
      <div className="board__units">
        <TileList
          entries={groupEntities(view, player.units, { enabled: grouping, selectionOf })}
          view={view}
          database={database}
          idPrefix={player.playerId}
          expandedGroups={expandedGroups}
          onToggleGroup={onToggleGroup}
          nameOf={nameOf}
          renderEntity={renderUnit}
        />
      </div>
      <div className="board__relics">
        {player.relics.map((instanceId) => {
          const name = database.get(view.instances[instanceId]?.definitionId ?? '')?.name ?? '?';
          const card = inspectable(view, instanceId, `${player.name}'s relics`);
          return onInspect && card ? (
            <button
              key={instanceId}
              type="button"
              className="relic relic--clickable"
              onClick={() => onInspect(card)}
            >
              {name}
            </button>
          ) : (
            <span key={instanceId} className="relic">
              {name}
            </span>
          );
        })}
      </div>
    </div>
  );
}

export function MatchBoard() {
  const client = useMatchClient();
  const database = useCardDatabase();
  const { view, pendingActionId, lastError, seatConnections } = useMatchState();

  /** Attacker → chosen defender, built up before the declaration is confirmed. */
  const [attacks, setAttacks] = useState<Record<string, string>>({});
  const [selectedAttacker, setSelectedAttacker] = useState<string | null>(null);
  const [blocks, setBlocks] = useState<{ attackerInstanceId: string; blockerInstanceId: string }[]>(
    [],
  );
  const [pendingBlocker, setPendingBlocker] = useState<string | null>(null);
  const [choiceSelection, setChoiceSelection] = useState<string[]>([]);
  const [helpMode, setHelpMode] = useState(false);
  const [inspecting, setInspecting] = useState<InspectableCard | null>(null);
  /**
   * Token grouping, on by default (M06.1). A real toggle rather than a debug
   * flag: "grouping on and off are the same match" is an acceptance criterion,
   * and a player has to be able to check it by playing.
   */
  const [grouping, setGrouping] = useState(true);
  /**
   * Which groups are open, keyed by the list they are in plus their grouping
   * key, never by instance. A key is a function of the shared state, so a group
   * survives a member being defeated, an opened group stays open while a
   * diverging member leaves it — the member's new group is a different key and
   * so opens closed — and a group closes on its own when the state it stood for
   * stops existing.
   */
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(new Set());
  const toggleGroup = (groupId: string): void =>
    setExpandedGroups((current) => {
      const next = new Set(current);
      if (!next.delete(groupId)) next.add(groupId);
      return next;
    });

  const phase = view?.phase;
  const choiceId = view?.pendingChoice?.id ?? null;

  // Any change of phase or choice invalidates a half-built declaration.
  useEffect(() => {
    setAttacks({});
    setSelectedAttacker(null);
    setBlocks([]);
    setPendingBlocker(null);
  }, [phase]);
  useEffect(() => setChoiceSelection([]), [choiceId]);

  const log = useMemo(() => (view ? buildLog(view, database) : []), [view, database]);

  if (!view) return null;

  const legal = view.legalActions;
  const eliminated = legal.eliminated;
  const locked = pendingActionId !== null || view.status === 'complete' || eliminated;
  const me = view.players.find((player) => player.playerId === view.viewerId);
  // Seat order, starting after us: the table as the local player sees it.
  const others = (() => {
    const index = view.seatOrder.indexOf(view.viewerId);
    const rotated = view.seatOrder
      .map((_, offset) => view.seatOrder[(index + offset + 1) % view.seatOrder.length])
      .filter(
        (playerId): playerId is string => playerId !== undefined && playerId !== view.viewerId,
      );
    return rotated
      .map((playerId) => view.players.find((player) => player.playerId === playerId))
      .filter((player): player is PlayerViewSummary => player !== undefined);
  })();
  const choice = view.pendingChoice;

  const playable = new Map(legal.playableCards.map((card) => [card.instanceId, card]));
  const nameOf = (playerId: string): string =>
    view.players.find((player) => player.playerId === playerId)?.name ?? playerId;

  // Non-null only in Help mode. Every click handler below branches on this one
  // value, so "Help mode never acts" is a single, checkable property.
  const inspect: ((card: InspectableCard) => void) | null = helpMode ? setInspecting : null;

  // Everything the local seat may read, for stepping between cards in the
  // inspector. Hidden cards are absent from `view.instances` and so from here.
  const inspectableCards: InspectableCard[] = [
    ...view.hand
      .map((instanceId) => inspectable(view, instanceId, 'Your hand'))
      .filter((card): card is InspectableCard => card !== null),
    ...view.players.flatMap((player) => publicCardsOf(view, player)),
  ];

  const declaredAttacks: AttackDeclaration[] = Object.entries(attacks).map(
    ([attackerInstanceId, defenderPlayerId]) => ({ attackerInstanceId, defenderPlayerId }),
  );

  const assignBlock = (attackerInstanceId: string): void => {
    if (pendingBlocker === null) return;
    setBlocks((current) => [
      ...current.filter((block) => block.blockerInstanceId !== pendingBlocker),
      { attackerInstanceId, blockerInstanceId: pendingBlocker },
    ]);
    setPendingBlocker(null);
  };

  const chooseDefender = (defenderPlayerId: string): void => {
    if (selectedAttacker === null) return;
    setAttacks((current) => ({ ...current, [selectedAttacker]: defenderPlayerId }));
    setSelectedAttacker(null);
  };

  /**
   * What the viewer has already decided about one of their own units, in words
   * (M06.2).
   *
   * Local, uncommitted and already on this player's screen, so showing it
   * crosses no boundary — and folding it into the grouping key is what makes a
   * half-built declaration legible on a board of a hundred Tokens: three
   * Tokens aimed at one seat become their own tile before the declaration is
   * confirmed, which is exactly where the engine's own `attacking` will put
   * them a moment later.
   */
  const ownSelection = (instanceId: string): SelectionMarker => {
    const target = attacks[instanceId];
    if (target !== undefined) return `→ ${nameOf(target)}`;
    const assigned = blocks.find((block) => block.blockerInstanceId === instanceId);
    if (assigned)
      return `blocking ${database.get(view.instances[assigned.attackerInstanceId]?.definitionId ?? '')?.name ?? ''}`;
    // The one being aimed right now: it is about to become one of the above, and
    // until it does it is not interchangeable with the Tokens it came from.
    if (selectedAttacker === instanceId || pendingBlocker === instanceId) return 'selected';
    return null;
  };

  /** How many of the viewer's own blockers are already aimed at an attacker. */
  const opponentSelection = (instanceId: string): SelectionMarker => {
    const count = blocks.filter((block) => block.attackerInstanceId === instanceId).length;
    return count === 0 ? null : `blocked by ${count}`;
  };

  /**
   * What the viewer has already ticked in the pending choice (M06.2).
   *
   * An ordering names *which* place, so each ordered pick becomes a tile of its
   * own and the sequence stays readable; an allocation names how many points
   * are on that target, so equally-loaded targets stack together.
   */
  const choiceSelectionOf = (entityId: string): SelectionMarker => {
    if (!choice) return null;
    if (choice.type === 'divide_damage') {
      const allocated = choiceSelection.filter((id) => id === entityId).length;
      return allocated === 0 ? null : `×${allocated}`;
    }
    const position = choiceSelection.indexOf(entityId);
    if (position < 0) return null;
    return choice.ordered ? `#${position + 1}` : 'chosen';
  };

  /**
   * One of the viewer's own units, exactly as before grouping existed.
   *
   * Extracted rather than inlined because it is now reached two ways — as a
   * tile of its own, and as a member of an expanded Token group — and both have
   * to produce the identical clickable card. A group that rendered its members
   * differently would be a second interaction path with its own bugs.
   */
  const renderOwnUnit = (instanceId: string, ariaLabel?: string) => {
    const instance = view.instances[instanceId];
    const canAttack = legal.attacking?.legalAttackers.includes(instanceId) ?? false;
    const canBlock = legal.blocking?.blockerInstanceIds.includes(instanceId) ?? false;
    const target = attacks[instanceId];

    const inspectCard = inspectable(view, instanceId, 'Your board');
    let onClick: (() => void) | undefined;
    // Help mode short-circuits the whole attacker/blocker branch below.
    if (inspect && inspectCard) {
      onClick = () => inspect(inspectCard);
    } else if (!inspect && !locked) {
      if (canAttack) {
        // Click to pick an attacker, then click an opponent to aim it.
        // Clicking an already-aimed attacker clears its target, so a
        // declaration stays editable until it is confirmed.
        onClick = () => {
          if (target !== undefined) {
            setAttacks((current) => {
              const next = { ...current };
              delete next[instanceId];
              return next;
            });
            setSelectedAttacker(null);
            return;
          }
          setSelectedAttacker((current) => (current === instanceId ? null : instanceId));
        };
      } else if (canBlock) {
        onClick = () =>
          setPendingBlocker((current) => (current === instanceId ? null : instanceId));
      }
    }

    return (
      <UnitCard
        key={instanceId}
        instance={instance}
        database={database}
        highlighted={canAttack || canBlock}
        selected={selectedAttacker === instanceId || pendingBlocker === instanceId}
        // The same words a tile of these units would print, from the same
        // function, so grouping cannot change what the player is told.
        label={ownSelection(instanceId) ?? undefined}
        ariaLabel={ariaLabel}
        onClick={onClick}
      />
    );
  };

  return (
    <section className="board" aria-label="Match board">
      <div className="board__status">
        <span>
          Turn {view.turn} · <strong>{view.phase.replace(/_/g, ' ')}</strong>
        </span>
        <span>
          {eliminated
            ? 'Spectating'
            : view.activePlayerId === view.viewerId
              ? 'Your turn'
              : `${nameOf(view.activePlayerId)}'s turn`}
          {view.awaitingChoiceFrom && view.awaitingChoiceFrom !== view.viewerId
            ? ` · waiting for ${nameOf(view.awaitingChoiceFrom)}`
            : ''}
        </span>
        {legal.awaitingDefenders.length > 0 && (
          <span className="tag tag--warn">
            waiting for blockers: {legal.awaitingDefenders.map(nameOf).join(', ')}
          </span>
        )}
        {pendingActionId && <span className="tag tag--warn">sending…</span>}
        <button
          type="button"
          className={`board__help-toggle${helpMode ? ' is-active' : ''}`}
          aria-pressed={helpMode}
          onClick={() => {
            setHelpMode((current) => !current);
            setInspecting(null);
          }}
        >
          ? Help
        </button>
        {/* Grouping is presentation, so the toggle sends nothing and changes no
            match state — turning it off shows every Token as its own card and
            leaves the legal actions, the log and the result identical. */}
        <button
          type="button"
          className={`board__group-toggle${grouping ? ' is-active' : ''}`}
          aria-pressed={grouping}
          onClick={() => setGrouping((current) => !current)}
        >
          Stack tokens
        </button>
        <button type="button" className="button--quiet" onClick={() => client.leave()}>
          {eliminated ? 'Leave' : 'Concede and leave'}
        </button>
      </div>

      {helpMode && (
        <p className="board__help-hint" role="status">
          Help mode is on. Click any card you can see to read what it does — nothing you click will
          be played, targeted or attacked with.
        </p>
      )}

      <CardInspector
        card={inspecting}
        view={view}
        database={database}
        neighbours={inspectableCards}
        onSelect={setInspecting}
        onClose={() => setInspecting(null)}
      />

      {eliminated && view.status !== 'complete' && (
        <p className="board__result" role="status">
          You are out of the match. You can watch the rest, but not act.
        </p>
      )}

      {lastError && (
        <p className="board__error" role="alert">
          {lastError.message}
        </p>
      )}

      {view.result && (
        <p className="board__result" role="status">
          {view.result.outcome === 'draw'
            ? `Draw — ${view.result.reason.replace(/_/g, ' ')}`
            : view.result.winnerId === view.viewerId
              ? `You win — ${view.result.reason.replace(/_/g, ' ')}`
              : `${nameOf(view.result.winnerId ?? '')} wins — ${view.result.reason.replace(/_/g, ' ')}`}
        </p>
      )}

      {others.map((player) => {
        const seatId = seatIdFor(player.playerId);
        return (
          <div key={player.playerId}>
            <PlayerHeader
              player={player}
              database={database}
              view={view}
              isViewer={false}
              connection={seatId ? seatConnections[seatId] : undefined}
              awaitingBlockers={legal.awaitingDefenders.includes(player.playerId)}
              onInspect={inspect}
            />
            {!player.lost && (
              <OpponentBoard
                player={player}
                view={view}
                database={database}
                locked={locked}
                pendingBlocker={pendingBlocker}
                onAssignBlock={assignBlock}
                attackTarget={
                  selectedAttacker !== null &&
                  (legal.attacking?.legalDefenders.includes(player.playerId) ?? false)
                }
                onChooseDefender={() => chooseDefender(player.playerId)}
                onInspect={inspect}
                grouping={grouping}
                expandedGroups={expandedGroups}
                onToggleGroup={toggleGroup}
                selectionOf={opponentSelection}
              />
            )}
            {inspect && (
              <DiscardStrip player={player} view={view} database={database} onInspect={inspect} />
            )}
          </div>
        );
      })}

      <div className="board__side" aria-label="Your battlefield">
        <div className="board__relics">
          {me?.relics.map((instanceId) => {
            const name = database.get(view.instances[instanceId]?.definitionId ?? '')?.name ?? '?';
            const card = inspectable(view, instanceId, 'Your relics');
            return inspect && card ? (
              <button
                key={instanceId}
                type="button"
                className="relic relic--clickable"
                onClick={() => inspect(card)}
              >
                {name}
              </button>
            ) : (
              <span key={instanceId} className="relic">
                {name}
              </span>
            );
          })}
        </div>
        <div className="board__units">
          <TileList
            entries={groupEntities(view, me?.units ?? [], {
              enabled: grouping,
              selectionOf: ownSelection,
            })}
            view={view}
            database={database}
            idPrefix="own"
            expandedGroups={expandedGroups}
            onToggleGroup={toggleGroup}
            nameOf={nameOf}
            renderEntity={renderOwnUnit}
          />
        </div>
      </div>

      {me && (
        <>
          <PlayerHeader
            player={me}
            database={database}
            view={view}
            isViewer
            connection={undefined}
            awaitingBlockers={legal.awaitingDefenders.includes(me.playerId)}
            onInspect={inspect}
          />
          {inspect && (
            <DiscardStrip player={me} view={view} database={database} onInspect={inspect} />
          )}
        </>
      )}
      <div className="board__controls">
        {legal.mulligan && (
          <div className="control-group">
            <p>Keep this hand, or select cards below to redraw.</p>
            <button
              type="button"
              disabled={locked}
              onClick={() =>
                client.sendAction({
                  type: 'mulligan',
                  playerId: view.viewerId,
                  returnInstanceIds: choiceSelection,
                })
              }
            >
              {choiceSelection.length === 0
                ? 'Keep hand'
                : `Redraw ${choiceSelection.length} card(s)`}
            </button>
          </div>
        )}

        {legal.canPassPhase && (
          <button
            type="button"
            disabled={locked}
            onClick={() => client.sendAction({ type: 'pass_phase', playerId: view.viewerId })}
          >
            Pass phase
          </button>
        )}

        {legal.attacking && (
          <>
            {selectedAttacker !== null && (
              <span className="tag tag--warn">Now choose which opponent to attack</span>
            )}
            <button
              type="button"
              disabled={locked}
              onClick={() =>
                client.sendAction({
                  type: 'declare_attackers',
                  playerId: view.viewerId,
                  attacks: declaredAttacks,
                })
              }
            >
              {declaredAttacks.length === 0
                ? 'Attack with nobody'
                : `Confirm ${declaredAttacks.length} attacker(s)`}
            </button>
          </>
        )}

        {legal.blocking && (
          <button
            type="button"
            disabled={locked}
            onClick={() =>
              client.sendAction({ type: 'assign_blockers', playerId: view.viewerId, blocks })
            }
          >
            {blocks.length === 0 ? 'No blocks' : `Confirm ${blocks.length} block(s)`}
          </button>
        )}

        {/*
          One entry per ability, then its sources laid out by the same grouping
          rule as the board (M06.2). Two things were wrong before: the button
          never said *which* card was about to activate, so two sources offering
          the same ability were two identical buttons; and a hundred Tokens
          offering one ability would have been a hundred of them.
        */}
        {abilityOffers(legal.activatableAbilities).map((offer) => {
          const name = `${offer.abilityId.replace(/_/g, ' ')} (${offer.energyCost}⚡)`;
          const renderAbility = (sourceInstanceId: string, ariaLabel?: string) => {
            const source =
              database.get(view.instances[sourceInstanceId]?.definitionId ?? '')?.name ??
              sourceInstanceId;
            return (
              <button
                key={`${sourceInstanceId}:${offer.abilityId}`}
                type="button"
                disabled={locked}
                // Only inside a tile, where every member prints the same words:
                // the ordinal is what tells a screen reader which one this is.
                aria-label={ariaLabel === undefined ? undefined : `Ability: ${name} — ${ariaLabel}`}
                onClick={() =>
                  client.sendAction({
                    type: 'activate_ability',
                    playerId: view.viewerId,
                    sourceInstanceId,
                    abilityId: offer.abilityId,
                  })
                }
              >
                Ability: {name} — {source}
              </button>
            );
          };
          return (
            <TileList
              key={`${offer.abilityId}:${offer.energyCost}`}
              entries={groupEntities(view, offer.sourceInstanceIds, { enabled: grouping })}
              view={view}
              database={database}
              idPrefix={`ability:${offer.abilityId}:${offer.energyCost}`}
              headingFor={() => `Ability: ${name}`}
              expandedGroups={expandedGroups}
              onToggleGroup={toggleGroup}
              nameOf={nameOf}
              renderEntity={renderAbility}
            />
          );
        })}
      </div>

      {choice && (
        <div className="choice" role="group" aria-label="Pending choice">
          <p className="choice__prompt">
            {choicePrompt(choice)}
            {/* A yes/no needs no count: "choose 1" of two buttons reads as a
                puzzle rather than a question. */}
            {choice.type === 'confirm'
              ? ''
              : choice.type === 'divide_damage'
                ? // An allocation is not "choose N of these": the count is
                  // points still to place, not options still to pick.
                  ` — ${choice.minimum - choiceSelection.length} of ${choice.minimum} left to place`
                : ` — choose ${choice.minimum}${
                    choice.maximum !== choice.minimum ? `–${choice.maximum}` : ''
                  }`}
            {choice.ordered ? ' (click in the order you want them)' : ''}
          </p>
          {/*
            The options are laid out by the same grouping rule as the board
            (M06.2): sacrificing one of sixty identical Tokens is a question
            nobody can read as sixty identical buttons. The tile itself selects
            nothing — expanding it is the only way to answer, because a tile is
            not a targeting unit and the engine wants one exact instance.
          */}
          <div className="choice__options">
            <TileList
              entries={groupEntities(view, choice.validEntityIds, {
                enabled: grouping,
                selectionOf: choiceSelectionOf,
              })}
              view={view}
              database={database}
              idPrefix="choice"
              expandedGroups={expandedGroups}
              onToggleGroup={toggleGroup}
              nameOf={nameOf}
              renderEntity={(entityId, ariaLabel) => {
                const instance = view.instances[entityId];
                const position = choiceSelection.indexOf(entityId);
                // On an allocation the same option may be picked several times,
                // and how many times is the answer.
                const allocated = choiceSelection.filter((id) => id === entityId).length;
                // A `select_players` choice lists player IDs, not instances.
                const optionLabel =
                  choice.type === 'confirm'
                    ? // The engine's option IDs are literally `yes`/`no`; they
                      // point at nothing on the board, so there is no card name
                      // to look up.
                      (CONFIRM_LABELS[entityId] ?? entityId)
                    : choice.type === 'select_players'
                      ? nameOf(entityId)
                      : (database.get(instance?.definitionId ?? '')?.name ?? entityId);
                const marker = choiceSelectionOf(entityId);
                return (
                  <button
                    key={entityId}
                    type="button"
                    className={`choice__option ${
                      (choice.type === 'divide_damage' ? allocated > 0 : position >= 0)
                        ? 'choice__option--selected'
                        : ''
                    }`}
                    // Only inside a tile: outside one the visible name already
                    // identifies the option on its own.
                    aria-label={
                      ariaLabel === undefined
                        ? undefined
                        : `${ariaLabel}${marker === null ? '' : `, ${marker}`}`
                    }
                    disabled={
                      locked ||
                      (choice.type === 'divide_damage' && choiceSelection.length >= choice.maximum)
                    }
                    onClick={() =>
                      setChoiceSelection((current) =>
                        // Allocating adds a point rather than toggling: a target
                        // named twice takes two damage. "Start over" below is the
                        // way back, because a toggle here would make it impossible
                        // to take one point off a target holding three.
                        choice.type === 'divide_damage'
                          ? [...current, entityId]
                          : current.includes(entityId)
                            ? current.filter((id) => id !== entityId)
                            : [...current, entityId],
                      )
                    }
                  >
                    {optionLabel}
                    {choice.ordered && position >= 0 ? ` #${position + 1}` : ''}
                    {choice.type === 'divide_damage' && allocated > 0 ? ` ×${allocated}` : ''}
                  </button>
                );
              }}
            />
          </div>
          {choice.type === 'divide_damage' && (
            <button
              type="button"
              disabled={locked || choiceSelection.length === 0}
              onClick={() => setChoiceSelection([])}
            >
              Start over
            </button>
          )}
          <button
            type="button"
            disabled={
              locked ||
              (choice.ordered
                ? choiceSelection.length !== choice.validEntityIds.length
                : choiceSelection.length < choice.minimum ||
                  choiceSelection.length > choice.maximum)
            }
            onClick={() =>
              client.sendAction({
                type: 'submit_choice',
                playerId: view.viewerId,
                choiceId: choice.id,
                selectedIds: choiceSelection,
              })
            }
          >
            Confirm
          </button>
        </div>
      )}

      <div className="hand" aria-label="Your hand">
        {view.hand.map((instanceId) => {
          const instance = view.instances[instanceId];
          const definition = instance ? database.get(instance.definitionId) : undefined;
          const option = playable.get(instanceId);
          const mulliganSelected = legal.mulligan && choiceSelection.includes(instanceId);
          const inspectCard = inspectable(view, instanceId, 'Your hand');
          return (
            <button
              key={instanceId}
              type="button"
              className={`hand__card ${option ? 'hand__card--playable' : ''} ${mulliganSelected ? 'hand__card--selected' : ''}`}
              // In Help mode every card in hand is readable, including ones
              // that are not playable — that is usually the card you want
              // explained.
              disabled={inspect ? false : locked || (!option && !legal.mulligan)}
              onClick={() => {
                if (inspect) {
                  if (inspectCard) inspect(inspectCard);
                  return;
                }
                if (legal.mulligan) {
                  setChoiceSelection((current) =>
                    current.includes(instanceId)
                      ? current.filter((id) => id !== instanceId)
                      : [...current, instanceId],
                  );
                  return;
                }
                if (!option) return;
                client.sendAction({ type: 'play_card', playerId: view.viewerId, instanceId });
              }}
            >
              <span className="hand__name">{definition?.name ?? instanceId}</span>
              {/*
                The engine's current cost, not the printed one. A card whose
                cost scales with the board is discounted while it is still
                unaffordable, and showing the printed number until it became
                playable would hide the whole mechanic (M02.3). `instance` is
                authoritative for the viewer's own hand; the printed cost is only
                a fallback for a card the view has not described.
              */}
              <span className="hand__cost">{handCostLabel(instance, option, definition)}</span>
              {definition?.displayText && (
                <span className="hand__text">{definition.displayText}</span>
              )}
            </button>
          );
        })}
      </div>

      <ol className="match-log" aria-label="Game log">
        {log.slice(-40).map((line) => (
          <li key={line.sequence}>{line.text}</li>
        ))}
      </ol>
    </section>
  );
}
