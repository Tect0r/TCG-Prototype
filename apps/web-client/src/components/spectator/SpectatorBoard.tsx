import { useMemo } from 'react';
import type { CardDatabase } from '@tcg/card-data';
import {
  commanderDeployCost,
  currentAttack,
  currentHealth,
  DEFAULT_RULES_CONFIG,
  type CardInstance,
  type MatchState,
  type PlayerId,
} from '@tcg/rules-engine';
import type { InformationMode, SpectatorSeat } from '@tcg/spectator';

/**
 * All two to four boards, rendered from the authoritative state of one playback
 * frame.
 *
 * This reads `MatchState` directly rather than a redacted `PlayerView`, which is
 * only acceptable because there is no human at any seat: an AI spectator session
 * has nobody to disadvantage. The hidden-information boundary is still enforced
 * — by `SpectatorPlayback.handFor`, which returns nothing outside Analysis Mode
 * — and nothing in this file is reachable from a human or online match, which
 * goes through `MatchBoard` and its `PlayerView` and always will.
 *
 * Identical Tokens are stacked visually. The stack is presentation only: each
 * Token keeps its own instance ID, its own damage and its own exhausted state,
 * and the count on the badge is the number of individual game objects behind it
 * (ruleset update §7).
 */

export interface SpectatorBoardProps {
  readonly state: MatchState;
  readonly seats: readonly SpectatorSeat[];
  readonly database: CardDatabase;
  readonly mode: InformationMode;
  /** Hands the viewer is permitted to see, keyed by seat. */
  readonly visibleHands: Readonly<Record<PlayerId, readonly string[]>>;
  /** Instances the current playback step is about. */
  readonly highlight: ReadonlySet<string>;
}

interface TokenStack {
  readonly definitionId: string;
  readonly members: readonly CardInstance[];
}

/** Groups a battlefield into single units and visual Token stacks, in order. */
function layOut(
  state: MatchState,
  instanceIds: readonly string[],
): { singles: CardInstance[]; stacks: TokenStack[] } {
  const singles: CardInstance[] = [];
  const stacks = new Map<string, CardInstance[]>();

  for (const instanceId of instanceIds) {
    const instance = state.instances[instanceId];
    if (!instance) continue;
    if (!instance.isToken) {
      singles.push(instance);
      continue;
    }
    const group = stacks.get(instance.definitionId) ?? [];
    group.push(instance);
    stacks.set(instance.definitionId, group);
  }

  return {
    singles,
    stacks: [...stacks].map(([definitionId, members]) => ({ definitionId, members })),
  };
}

function UnitChip({
  instance,
  database,
  highlighted,
  count,
}: {
  readonly instance: CardInstance;
  readonly database: CardDatabase;
  readonly highlighted: boolean;
  /** Set for a visual Token stack; the stack still holds `count` game objects. */
  readonly count?: number;
}) {
  const definition = database.get(instance.definitionId);
  const attack = definition ? currentAttack(instance, definition) : 0;
  const health = definition ? currentHealth(instance, definition) : 0;

  const classes = [
    'spectator-unit',
    instance.exhausted ? 'spectator-unit--exhausted' : '',
    highlighted ? 'spectator-unit--highlight' : '',
    instance.newlyDeployed ? 'spectator-unit--new' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={classes} title={definition?.displayText ?? instance.definitionId}>
      <span className="spectator-unit__name">
        {definition?.name ?? instance.definitionId}
        {count !== undefined && count > 1 && (
          <span className="spectator-unit__count" aria-label={`${count} copies`}>
            ×{count}
          </span>
        )}
      </span>
      <span className="spectator-unit__stats">
        {attack}/{Math.max(0, health - instance.markedDamage)}
        {instance.markedDamage > 0 ? ` (${instance.markedDamage})` : ''}
      </span>
    </div>
  );
}

export function SpectatorBoard({
  state,
  seats,
  database,
  mode,
  visibleHands,
  highlight,
}: SpectatorBoardProps) {
  const bySeat = useMemo(
    () => seats.map((seat) => ({ seat, player: state.players[seat.playerId] })),
    [seats, state],
  );

  const priorityHolder =
    state.reactionWindow && !state.reactionWindow.closed
      ? (state.reactionWindow.priorityOrder[state.reactionWindow.priorityIndex] ?? null)
      : null;

  return (
    <div className={`spectator-board spectator-board--${seats.length}`}>
      {bySeat.map(({ seat, player }) => {
        if (!player) return null;
        const commander = state.instances[player.commanderInstanceId];
        const definition = database.get(seat.commanderId);
        // The shared configuration, not a local copy: a spectator replay is
        // always played back under the rules version it was recorded with, and
        // the compatibility check refuses one whose version has moved.
        const deployCost = definition
          ? commanderDeployCost(player, definition, DEFAULT_RULES_CONFIG)
          : null;
        const { singles, stacks } = layOut(state, player.units);
        const hand = visibleHands[seat.playerId] ?? [];

        const classes = [
          'spectator-seat',
          state.activePlayerId === seat.playerId ? 'spectator-seat--active' : '',
          player.lost ? 'spectator-seat--out' : '',
          priorityHolder === seat.playerId ? 'spectator-seat--priority' : '',
        ]
          .filter(Boolean)
          .join(' ');

        return (
          <section key={seat.playerId} className={classes} aria-label={seat.name}>
            <header className="spectator-seat__header">
              <h3>{seat.name}</h3>
              <span className="spectator-seat__pilot">
                {seat.pilotId.replace(/_/g, ' ')}
                {seat.preconId ? ` · ${seat.preconId}` : ''}
              </span>
            </header>

            <dl className="spectator-seat__stats">
              <div>
                <dt>Health</dt>
                <dd>{player.health}</dd>
              </div>
              <div>
                <dt>Energy</dt>
                <dd>
                  {player.energy}/{player.maxEnergy}
                </dd>
              </div>
              <div>
                <dt>Deck</dt>
                <dd>{player.deck.length}</dd>
              </div>
              <div>
                <dt>Hand</dt>
                <dd>{player.hand.length}</dd>
              </div>
              <div>
                <dt>Discard</dt>
                <dd>{player.discard.length}</dd>
              </div>
            </dl>

            {/* The Commander's current deployment cost and defeat count are
                required on screen: the escalation is the mechanic, and a viewer
                cannot infer it from a board. */}
            <p className="spectator-seat__commander">
              <strong>{definition?.name ?? seat.commanderId}</strong>{' '}
              {commander?.zone === 'battlefield' ? 'on the battlefield' : 'in the Command Zone'}
              {deployCost !== null && commander?.zone !== 'battlefield' && (
                <> · next deployment {deployCost}</>
              )}
              {player.commanderDefeats > 0 && <> · defeated {player.commanderDefeats}×</>}
            </p>

            <div className="spectator-seat__row" aria-label={`${seat.name} units`}>
              {singles.length === 0 && stacks.length === 0 && (
                <span className="spectator-seat__empty">no units</span>
              )}
              {singles.map((instance) => (
                <UnitChip
                  key={instance.instanceId}
                  instance={instance}
                  database={database}
                  highlighted={highlight.has(instance.instanceId)}
                />
              ))}
              {stacks.map((stack) => {
                const first = stack.members[0];
                if (!first) return null;
                return (
                  <UnitChip
                    key={`${stack.definitionId}:${first.instanceId}`}
                    instance={first}
                    database={database}
                    count={stack.members.length}
                    highlighted={stack.members.some((member) => highlight.has(member.instanceId))}
                  />
                );
              })}
            </div>

            {player.relics.length > 0 && (
              <div className="spectator-seat__row" aria-label={`${seat.name} relics`}>
                {player.relics.map((instanceId) => {
                  const instance = state.instances[instanceId];
                  if (!instance) return null;
                  return (
                    <span key={instanceId} className="spectator-relic">
                      {database.get(instance.definitionId)?.name ?? instance.definitionId}
                    </span>
                  );
                })}
              </div>
            )}

            {mode === 'analysis' && (
              <div className="spectator-seat__hand" aria-label={`${seat.name} hand`}>
                <span className="spectator-seat__hand-label">Hand</span>
                {hand.length === 0 ? (
                  <span className="spectator-seat__empty">empty</span>
                ) : (
                  hand.map((instanceId) => {
                    const instance = state.instances[instanceId];
                    return (
                      <span key={instanceId} className="spectator-hand-card">
                        {instance
                          ? (database.get(instance.definitionId)?.name ?? instance.definitionId)
                          : instanceId}
                      </span>
                    );
                  })
                )}
              </div>
            )}

            {player.lost && <p className="spectator-seat__eliminated">Eliminated</p>}
          </section>
        );
      })}
    </div>
  );
}
