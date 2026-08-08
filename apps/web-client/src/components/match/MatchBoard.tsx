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

/**
 * The match board, for two to four players.
 *
 * Every element is rendered from the authoritative `PlayerView`: what is legal
 * comes from `view.legalActions`, never from a client-side rule (CLAUDE.md §11).
 * While an action is in flight, input is locked. Nothing here delays or owns a
 * rule — the server has already decided by the time anything re-renders.
 */

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
      {instance.summoningSick && <span className="unit__flag">summoning sick</span>}
      {label && <span className="unit__flag">{label}</span>}
    </button>
  );
}

function PlayerHeader({
  player,
  database,
  view,
  isViewer,
  connection,
  awaitingBlockers,
}: {
  readonly player: PlayerViewSummary;
  readonly database: CardDatabase;
  readonly view: PlayerView;
  readonly isViewer: boolean;
  readonly connection: SeatConnection | undefined;
  readonly awaitingBlockers: boolean;
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
          <span className="player-bar__stat">
            cmd {commander ? (database.get(commander.definitionId)?.name ?? '?') : '?'}
          </span>
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
}) {
  const legal = view.legalActions;
  const attacksOnMe = new Map(
    view.combat.attacks.map((attack) => [attack.attackerInstanceId, attack.defenderPlayerId]),
  );

  return (
    <div className="board__side" aria-label={`${player.name} battlefield`}>
      {attackTarget && (
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
        {player.units.map((instanceId, index) => {
          const instance = instanceId ? view.instances[instanceId] : undefined;
          const defenderId = instanceId ? attacksOnMe.get(instanceId) : undefined;
          const blockable =
            instanceId !== null &&
            (legal.blocking?.attackerInstanceIds.includes(instanceId) ?? false);
          // An attacker is only clickable once one of our blockers is picked.
          const assignBlock =
            blockable && pendingBlocker !== null && !locked && instanceId !== null
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
              key={index}
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
        {player.relics.map((instanceId) => (
          <span key={instanceId} className="relic">
            {database.get(view.instances[instanceId]?.definitionId ?? '')?.name ?? '?'}
          </span>
        ))}
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
        <button type="button" className="button--quiet" onClick={() => client.leave()}>
          {eliminated ? 'Leave' : 'Concede and leave'}
        </button>
      </div>

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
              />
            )}
          </div>
        );
      })}

      <div className="board__side" aria-label="Your battlefield">
        <div className="board__relics">
          {me?.relics.map((instanceId) => (
            <span key={instanceId} className="relic">
              {database.get(view.instances[instanceId]?.definitionId ?? '')?.name ?? '?'}
            </span>
          ))}
        </div>
        <div className="board__units">
          {me?.units.map((instanceId, index) => {
            const instance = instanceId ? view.instances[instanceId] : undefined;
            const canAttack = instanceId
              ? (legal.attacking?.legalAttackers.includes(instanceId) ?? false)
              : false;
            const canBlock = instanceId
              ? (legal.blocking?.blockerInstanceIds.includes(instanceId) ?? false)
              : false;
            const assigned = blocks.find((block) => block.blockerInstanceId === instanceId);
            const target = instanceId ? attacks[instanceId] : undefined;

            let onClick: (() => void) | undefined;
            if (!locked && instanceId !== null) {
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
                key={index}
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
        <PlayerHeader
          player={me}
          database={database}
          view={view}
          isViewer
          connection={undefined}
          awaitingBlockers={legal.awaitingDefenders.includes(me.playerId)}
        />
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
            {choice.reason.replace(/_/g, ' ')} — choose {choice.minimum}
            {choice.maximum !== choice.minimum ? `–${choice.maximum}` : ''}
            {choice.ordered ? ' (click in the order you want them)' : ''}
          </p>
          <div className="choice__options">
            {choice.validEntityIds.map((entityId) => {
              const instance = view.instances[entityId];
              const position = choiceSelection.indexOf(entityId);
              // A `select_players` choice lists player IDs, not instances.
              const optionLabel =
                choice.type === 'select_players'
                  ? nameOf(entityId)
                  : (database.get(instance?.definitionId ?? '')?.name ?? entityId);
              return (
                <button
                  key={entityId}
                  type="button"
                  className={`choice__option ${position >= 0 ? 'choice__option--selected' : ''}`}
                  disabled={locked}
                  onClick={() =>
                    setChoiceSelection((current) =>
                      current.includes(entityId)
                        ? current.filter((id) => id !== entityId)
                        : [...current, entityId],
                    )
                  }
                >
                  {optionLabel}
                  {choice.ordered && position >= 0 ? ` #${position + 1}` : ''}
                </button>
              );
            })}
          </div>
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
          return (
            <button
              key={instanceId}
              type="button"
              className={`hand__card ${option ? 'hand__card--playable' : ''} ${mulliganSelected ? 'hand__card--selected' : ''}`}
              disabled={locked || (!option && !legal.mulligan)}
              onClick={() => {
                if (legal.mulligan) {
                  setChoiceSelection((current) =>
                    current.includes(instanceId)
                      ? current.filter((id) => id !== instanceId)
                      : [...current, instanceId],
                  );
                  return;
                }
                if (!option) return;
                client.sendAction({
                  type: 'play_card',
                  playerId: view.viewerId,
                  instanceId,
                  slot: option.freeSlots[0] ?? null,
                });
              }}
            >
              <span className="hand__name">{definition?.name ?? instanceId}</span>
              <span className="hand__cost">
                {option ? `${option.energyCost}⚡` : (definition?.cost ?? '–')}
              </span>
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
