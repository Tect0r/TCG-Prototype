import { useMemo, useState } from 'react';
import type { CardDatabase } from '@tcg/card-data';
import {
  commanderDeployCost,
  DEFAULT_RULES_CONFIG,
  instanceView,
  type CardInstanceView,
  type MatchState,
  type PlayerId,
} from '@tcg/rules-engine';
import type { InformationMode, SpectatorSeat } from '@tcg/spectator';
import { groupEntities, type GroupingSource } from '../../lib/token-grouping.js';
import { TileList } from '../TokenStack.js';

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
 * ## Tokens are stacked by the same rule as a match (M06.3)
 *
 * Until M06.3 this file stacked Tokens by **definition alone** — the reading
 * Q42 measured and rejected — so the worst board Wave 1 produces, 117 Goblins
 * on one seat, was one chip saying ×117 and a viewer could not see that 64 of
 * them could not attack. It now uses `groupEntities`, the layer the match board
 * uses, over battlefield units projected through the engine's own
 * `instanceView`. Both surfaces therefore group by the same eleven fields read
 * out of the same function, which is what makes "Analysis Mode must not change
 * grouping semantics" true by construction rather than by inspection: the mode
 * decides whether a *hand* is projected, and a hand is not part of a tile.
 *
 * A stack is presentation only. Each Token keeps its own instance ID, its own
 * damage and its own Ready state, and expanding a tile shows every one of them
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
  /** Off draws every Token as its own chip — the pre-M06 board exactly. */
  readonly grouping?: boolean;
}

/**
 * Every battlefield unit on the table, as a client would be shown it.
 *
 * The projection is the engine's, not a second reading of `CardInstance`:
 * `instanceView` is what builds a `PlayerView`'s instances, so a Token here and
 * the same Token in a match carry identical attack, health, marked damage,
 * keywords, Newly Deployed and Barrier state — and a field added to the
 * grouping key is added to both at once. Only battlefield units are projected,
 * so no hand can reach this map however the information mode is set.
 */
function battlefieldSource(
  state: MatchState,
  seats: readonly SpectatorSeat[],
  database: CardDatabase,
): GroupingSource {
  const instances: Record<string, CardInstanceView> = {};
  for (const seat of seats) {
    const player = state.players[seat.playerId];
    if (!player) continue;
    for (const instanceId of player.units) {
      // The viewer argument only decides whether a card in that seat's *hand*
      // carries its current cost; a unit on a battlefield reports null to
      // everyone, so it cannot smuggle anything in here.
      const view = instanceView(state, database, instanceId, DEFAULT_RULES_CONFIG, seat.playerId);
      if (view) instances[instanceId] = view;
    }
  }
  return { instances, combat: state.combat };
}

function UnitChip({
  instance,
  database,
  highlighted,
  ariaLabel,
  role,
}: {
  readonly instance: CardInstanceView | undefined;
  readonly database: CardDatabase;
  readonly highlighted: boolean;
  /** Set only for a member of an expanded stack, where the chips are identical. */
  readonly ariaLabel?: string | undefined;
  readonly role?: string | undefined;
}) {
  if (!instance) return null;
  const definition = database.get(instance.definitionId);

  const classes = [
    'spectator-unit',
    instance.exhausted ? 'spectator-unit--exhausted' : '',
    highlighted ? 'spectator-unit--highlight' : '',
    instance.summoningSick ? 'spectator-unit--new' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={classes}
      title={definition?.displayText ?? instance.definitionId}
      role={role}
      aria-label={ariaLabel}
    >
      <span className="spectator-unit__name">{definition?.name ?? instance.definitionId}</span>
      <span className="spectator-unit__stats">
        {instance.attack}/{Math.max(0, instance.health - instance.markedDamage)}
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
  grouping = true,
}: SpectatorBoardProps) {
  const bySeat = useMemo(
    () => seats.map((seat) => ({ seat, player: state.players[seat.playerId] })),
    [seats, state],
  );
  const source = useMemo(() => battlefieldSource(state, seats, database), [state, seats, database]);
  /**
   * Which stacks are open, keyed by seat and grouping key. A key is a function
   * of the shared state, so a stack stays open while playback steps through
   * frames that leave that state alone, and the ones that change close on their
   * own instead of following an index that has moved underneath them.
   */
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(new Set());
  const toggleGroup = (groupId: string): void =>
    setExpandedGroups((current) => {
      const next = new Set(current);
      if (!next.delete(groupId)) next.add(groupId);
      return next;
    });
  const nameOf = (playerId: string): string =>
    seats.find((seat) => seat.playerId === playerId)?.name ?? playerId;
  /**
   * The Tokens this playback step is about, marked so they leave their stack.
   *
   * The same field a match uses for the viewer's own half-made decision
   * (M06.2), and for the same reason: a mark that did not split the tile would
   * be a highlight on a chip standing for a hundred Tokens, which says the step
   * was about all of them. This says exactly which.
   */
  const stepMark = (instanceId: string): string | null =>
    highlight.has(instanceId) ? 'this step' : null;

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
        const entries = groupEntities(source, player.units, {
          enabled: grouping,
          selectionOf: stepMark,
        });
        const hand = visibleHands[seat.playerId] ?? [];
        const renderUnit = (instanceId: string, ariaLabel?: string) => (
          <UnitChip
            key={instanceId}
            instance={source.instances[instanceId]}
            database={database}
            highlighted={highlight.has(instanceId)}
            ariaLabel={ariaLabel}
            role={ariaLabel === undefined ? undefined : 'listitem'}
          />
        );

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
              {entries.length === 0 && <span className="spectator-seat__empty">no units</span>}
              <TileList
                entries={entries}
                source={source}
                database={database}
                idPrefix={seat.playerId}
                variant="spectator"
                // Nobody can click a spectator chip, so its members are a list
                // to read rather than a set of things to choose between.
                membersRole="list"
                expandedGroups={expandedGroups}
                onToggleGroup={toggleGroup}
                nameOf={nameOf}
                renderEntity={renderUnit}
              />
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
