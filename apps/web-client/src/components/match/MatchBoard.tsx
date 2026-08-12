import { useEffect, useMemo, useState } from 'react';
import type { CardDatabase } from '@tcg/card-data';
import type { SeatId } from '@tcg/protocol';
import type {
  AttackDeclaration,
  CardInstanceView,
  PlayerView,
  PlayerViewSummary,
} from '@tcg/rules-engine';
import { useCardDatabase } from '../../state/AppContext.js';
import { useMatchClient, useMatchState } from '../../state/MatchContext.js';
import type { SeatConnection } from '../../net/match-client.js';
import { buildLog } from '../../lib/event-text.js';
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
  keep_exhausted: 'Pay to keep one enemy unit Exhausted, or choose nothing',
  // Every seat is answering this same question, and none of the answers has
  // happened yet. Saying so is the point: a prompt that read like an ordinary
  // targeting choice would invite the player to plan around a board that is
  // about to change under them.
  each_player_choice: 'Every player is choosing. Pick yours — nothing happens until all are in',
  divide_damage: 'Split the damage — click a target once for each point',
};

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
}: {
  readonly instance: CardInstanceView | undefined;
  readonly database: CardDatabase;
  readonly selected?: boolean | undefined;
  readonly highlighted?: boolean | undefined;
  /** Absent when the unit is not a legal click target right now. */
  readonly onClick?: (() => void) | undefined;
  readonly label?: string | undefined;
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
    <button type="button" className={classes} onClick={onClick} disabled={!onClick}>
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
}) {
  const legal = view.legalActions;
  const attacksOnMe = new Map(
    view.combat.attacks.map((attack) => [attack.attackerInstanceId, attack.defenderPlayerId]),
  );

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
        {player.units.map((instanceId) => {
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
                : `attacking ${view.players.find((p) => p.playerId === defenderId)?.name ?? '?'}`;

          return (
            <UnitCard
              key={instanceId}
              instance={instance}
              database={database}
              highlighted={blockable && pendingBlocker !== null}
              label={attackedName}
              onClick={assignBlock}
            />
          );
        })}
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
          {me?.units.map((instanceId) => {
            const instance = view.instances[instanceId];
            const canAttack = legal.attacking?.legalAttackers.includes(instanceId) ?? false;
            const canBlock = legal.blocking?.blockerInstanceIds.includes(instanceId) ?? false;
            const assigned = blocks.find((block) => block.blockerInstanceId === instanceId);
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
                label={
                  target !== undefined
                    ? `→ ${nameOf(target)}`
                    : assigned
                      ? `blocking ${database.get(view.instances[assigned.attackerInstanceId]?.definitionId ?? '')?.name ?? ''}`
                      : undefined
                }
                onClick={onClick}
              />
            );
          })}
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

        {legal.activatableAbilities.map((ability) => (
          <button
            key={`${ability.sourceInstanceId}:${ability.abilityId}`}
            type="button"
            disabled={locked}
            onClick={() =>
              client.sendAction({
                type: 'activate_ability',
                playerId: view.viewerId,
                sourceInstanceId: ability.sourceInstanceId,
                abilityId: ability.abilityId,
              })
            }
          >
            Ability: {ability.abilityId.replace(/_/g, ' ')} ({ability.energyCost}⚡)
          </button>
        ))}
      </div>

      {choice && (
        <div className="choice" role="group" aria-label="Pending choice">
          <p className="choice__prompt">
            {CHOICE_PROMPTS[choice.reason] ?? choice.reason.replace(/_/g, ' ')}
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
          <div className="choice__options">
            {choice.validEntityIds.map((entityId) => {
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
              return (
                <button
                  key={entityId}
                  type="button"
                  className={`choice__option ${
                    (choice.type === 'divide_damage' ? allocated > 0 : position >= 0)
                      ? 'choice__option--selected'
                      : ''
                  }`}
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
            })}
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
