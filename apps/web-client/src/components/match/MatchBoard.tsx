import { useEffect, useMemo, useState } from 'react';
import type { CardDatabase } from '@tcg/card-data';
import type { CardInstanceView, PlayerView, PlayerViewSummary } from '@tcg/rules-engine';
import { useCardDatabase } from '../../state/AppContext.js';
import { useMatchClient, useMatchState } from '../../state/MatchContext.js';
import { buildLog } from '../../lib/event-text.js';

/**
 * The match board. Every element is rendered from the authoritative
 * `PlayerView`: what is legal comes from `view.legalActions`, never from a
 * client-side rule (CLAUDE.md §11).
 *
 * While an action is in flight, input is locked. Nothing here delays or owns a
 * rule — the server has already decided by the time anything re-renders.
 */

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
  isActive,
  isViewer,
  connected,
  graceSeconds,
}: {
  readonly player: PlayerViewSummary;
  readonly database: CardDatabase;
  readonly view: PlayerView;
  readonly isActive: boolean;
  readonly isViewer: boolean;
  readonly connected: boolean;
  readonly graceSeconds: number | null;
}) {
  const commander = view.instances[player.commanderInstanceId];
  return (
    <div className={`player-bar ${isActive ? 'player-bar--active' : ''}`}>
      <span className="player-bar__name">
        {player.name}
        {isViewer ? ' (you)' : ''}
      </span>
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
      {!connected && (
        <span className="tag tag--warn">
          disconnected{graceSeconds !== null ? ` · ${graceSeconds}s` : ''}
        </span>
      )}
    </div>
  );
}

export function MatchBoard() {
  const client = useMatchClient();
  const database = useCardDatabase();
  const { view, pendingActionId, lastError, opponentConnected, opponentGraceSeconds } =
    useMatchState();

  const [selectedAttackers, setSelectedAttackers] = useState<string[]>([]);
  const [blocks, setBlocks] = useState<{ attackerInstanceId: string; blockerInstanceId: string }[]>(
    [],
  );
  const [pendingBlocker, setPendingBlocker] = useState<string | null>(null);
  const [choiceSelection, setChoiceSelection] = useState<string[]>([]);

  const phase = view?.phase;
  const choiceId = view?.pendingChoice?.id ?? null;

  // Any change of phase or choice invalidates a half-built declaration.
  useEffect(() => {
    setSelectedAttackers([]);
    setBlocks([]);
    setPendingBlocker(null);
  }, [phase]);
  useEffect(() => setChoiceSelection([]), [choiceId]);

  const log = useMemo(() => (view ? buildLog(view, database) : []), [view, database]);

  if (!view) return null;

  const legal = view.legalActions;
  const locked = pendingActionId !== null || view.status === 'complete';
  const me = view.players.find((player) => player.playerId === view.viewerId);
  const opponent = view.players.find((player) => player.playerId !== view.viewerId);
  const choice = view.pendingChoice;

  const playable = new Map(legal.playableCards.map((card) => [card.instanceId, card]));

  const toggle = (list: string[], id: string): string[] =>
    list.includes(id) ? list.filter((entry) => entry !== id) : [...list, id];

  const submitChoice = (): void => {
    if (!choice) return;
    client.sendAction({
      type: 'submit_choice',
      playerId: view.viewerId,
      choiceId: choice.id,
      selectedIds: choice.ordered ? choiceSelection : choiceSelection,
    });
  };

  return (
    <section className="board" aria-label="Match board">
      <div className="board__status">
        <span>
          Turn {view.turn} · <strong>{view.phase.replace(/_/g, ' ')}</strong>
        </span>
        <span>
          {view.activePlayerId === view.viewerId ? 'Your turn' : "Opponent's turn"}
          {view.awaitingChoiceFrom && view.awaitingChoiceFrom !== view.viewerId
            ? ' · waiting for opponent'
            : ''}
        </span>
        {pendingActionId && <span className="tag tag--warn">sending…</span>}
        <button type="button" className="button--quiet" onClick={() => client.leave()}>
          Concede and leave
        </button>
      </div>

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
              : `You lose — ${view.result.reason.replace(/_/g, ' ')}`}
        </p>
      )}

      {opponent && (
        <PlayerHeader
          player={opponent}
          database={database}
          view={view}
          isActive={view.activePlayerId === opponent.playerId}
          isViewer={false}
          connected={opponentConnected}
          graceSeconds={opponentGraceSeconds}
        />
      )}

      <div className="board__side" aria-label="Opponent battlefield">
        <div className="board__units">
          {opponent?.units.map((instanceId, index) => {
            const instance = instanceId ? view.instances[instanceId] : undefined;
            const isAttacker = instanceId
              ? view.combat.attackerInstanceIds.includes(instanceId)
              : false;
            const blockable =
              legal.blocking?.attackerInstanceIds.includes(instanceId ?? '') ?? false;
            // An attacker is only clickable once a blocker has been picked.
            const assignBlock =
              blockable && pendingBlocker !== null && !locked && instanceId !== null
                ? () => {
                    setBlocks((current) => [
                      ...current.filter((block) => block.blockerInstanceId !== pendingBlocker),
                      { attackerInstanceId: instanceId, blockerInstanceId: pendingBlocker },
                    ]);
                    setPendingBlocker(null);
                  }
                : undefined;
            return (
              <UnitCard
                key={index}
                instance={instance}
                database={database}
                highlighted={blockable && pendingBlocker !== null}
                label={isAttacker ? 'attacking' : undefined}
                onClick={assignBlock}
              />
            );
          })}
        </div>
        <div className="board__relics">
          {opponent?.relics.map((instanceId) => (
            <span key={instanceId} className="relic">
              {database.get(view.instances[instanceId]?.definitionId ?? '')?.name ?? '?'}
            </span>
          ))}
        </div>
      </div>

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
              ? (legal.legalAttackers?.includes(instanceId) ?? false)
              : false;
            const canBlock = instanceId
              ? (legal.blocking?.blockerInstanceIds.includes(instanceId) ?? false)
              : false;
            const assigned = blocks.find((block) => block.blockerInstanceId === instanceId);

            let onClick: (() => void) | undefined;
            if (!locked && instanceId !== null) {
              if (canAttack) {
                onClick = () => setSelectedAttackers((current) => toggle(current, instanceId));
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
                selected={
                  (instanceId !== null && selectedAttackers.includes(instanceId)) ||
                  pendingBlocker === instanceId
                }
                label={
                  assigned
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
          isActive={view.activePlayerId === me.playerId}
          isViewer
          connected
          graceSeconds={null}
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

        {legal.legalAttackers !== null && (
          <button
            type="button"
            disabled={locked}
            onClick={() =>
              client.sendAction({
                type: 'declare_attackers',
                playerId: view.viewerId,
                attackerInstanceIds: selectedAttackers,
              })
            }
          >
            {selectedAttackers.length === 0
              ? 'Attack with nobody'
              : `Confirm ${selectedAttackers.length} attacker(s)`}
          </button>
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
                  {database.get(instance?.definitionId ?? '')?.name ?? entityId}
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
            onClick={submitChoice}
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
