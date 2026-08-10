import { TRIGGER_IDS, type TriggerId } from '@tcg/card-data';

/**
 * Shared explanations for the trigger vocabulary.
 *
 * The card inspector combines a trigger's `clause` with the explanation of the
 * ability's effects to produce a whole sentence — "When this unit is defeated:
 * Draw one card." — so a card never has to spell its own timing out in prose.
 *
 * Deploy behaviour is deliberately absent: it is authored as a card's top-level
 * `effects`, not as a trigger (CLAUDE.md §17 Q1). `DEPLOY_TRIGGER` below covers
 * it for presentation purposes only.
 */

export interface TriggerInfo {
  /** Sentence opener, e.g. "When this unit attacks". */
  readonly clause: string;
  /**
   * The bare event, with the thing it happened to substituted in: "another
   * friendly unit is defeated".
   *
   * `clause` alone cannot express a scoped or throttled ability — it hard-codes
   * "this unit", so a card that watches the whole board read as one that
   * watches only itself. The composer needs the event without an opener so it
   * can put "When", "The first time" or "… each turn" around it. Triggers about
   * a turn rather than a card ignore the subject.
   */
  readonly event: (subject: string) => string;
  /** Player-facing timing detail shown in the inspector and glossary. */
  readonly description: string;
}

export const TRIGGER_REGISTRY: Readonly<Record<TriggerId, TriggerInfo>> = Object.freeze({
  on_attack: {
    event: (subject) => `${subject} attacks`,
    clause: 'When this unit attacks',
    description:
      'Fires once when this unit is declared as an attacker, before blockers are assigned.',
  },
  on_block: {
    event: (subject) => `${subject} blocks`,
    clause: 'When this unit blocks',
    description: 'Fires once when this unit is assigned as a blocker, before combat damage.',
  },
  on_survive_combat: {
    event: (subject) => `${subject} survives combat`,
    clause: 'If this unit survives combat',
    description:
      'Fires after combat damage has been dealt, if this unit is still on the battlefield.',
  },
  on_survive_combat_as_blocker: {
    event: (subject) => `${subject} survives combat as a blocker`,
    clause: 'If this unit survives combat as a blocker',
    description:
      'Fires after combat damage, if this unit blocked and is still on the battlefield. Surviving an attack it declared itself does not count.',
  },
  on_deployed: {
    event: (subject) => `${subject} is deployed`,
    clause: 'When a unit is deployed',
    description:
      'Fires as a unit arrives on a battlefield, whether it was played, created as a token, or returned there by an effect.',
  },
  on_entered_battlefield: {
    event: (subject) => `${subject} enters the battlefield`,
    clause: 'When a unit enters the battlefield',
    description:
      'Fires for every arrival on a battlefield, however it happened — played, created, revived, or simply put there by an effect. Broader than "is deployed", which only covers a card that was actually played for its cost.',
  },
  on_tokens_created: {
    event: (subject) => `${subject} is created`,
    clause: 'When one or more tokens are created',
    description:
      'Fires once for the whole batch, not once per token: an effect that creates five tokens fires this a single time, after all five have arrived.',
  },
  on_defeated: {
    event: (subject) => `${subject} is defeated`,
    clause: 'When this unit is defeated',
    description:
      'Fires when this unit leaves the battlefield as a defeat, whether from damage, a destroy effect or a sacrifice. The ability still resolves even though its source has gone.',
  },
  on_turn_start: {
    event: () => 'your turn begins',
    clause: "At the start of its controller's turn",
    description: "Fires during the Turn Start phase of the controller's own turn.",
  },
  on_turn_end: {
    event: () => 'your turn ends',
    clause: "At the end of its controller's turn",
    description:
      "Fires during the Turn End phase of the controller's own turn, before the hand-size discard.",
  },
  on_opponent_turn_start: {
    event: () => "an opponent's turn begins",
    clause: "At the start of each opponent's turn",
    description:
      'Fires during the Turn Start phase of a turn belonging to somebody else. In a four-player game that is three times per round.',
  },
  on_opponent_turn_end: {
    event: () => "an opponent's turn ends",
    clause: "At the end of each opponent's turn",
    description:
      "Fires during the Turn End phase of a turn belonging to somebody else, before that player's hand-size discard.",
  },
  on_sacrifice: {
    event: (subject) => `${subject} is sacrificed`,
    clause: 'When this unit is sacrificed',
    description:
      'Fires when this unit is given up deliberately, as a cost or as an effect. A sacrifice also fires the defeated trigger.',
  },
});

/**
 * Presentation-only pseudo-trigger for a card's top-level effects. There is no
 * `on_deploy` in the trigger vocabulary — deploy behaviour has exactly one
 * authoring form — but players still need to be told when those effects happen.
 */
export const DEPLOY_TRIGGER: Readonly<
  Record<'unit' | 'relic' | 'spell' | 'reaction' | 'token', TriggerInfo>
> = Object.freeze({
  unit: {
    event: () => 'this unit is deployed',
    clause: 'When this unit is deployed',
    description: 'Resolves once, as the unit enters the battlefield.',
  },
  token: {
    event: () => 'this token is created',
    clause: 'When this token is created',
    description: 'Resolves once, as the token enters the battlefield.',
  },
  relic: {
    event: () => 'this relic is deployed',
    clause: 'When this relic is deployed',
    description: 'Resolves once, as the relic enters play.',
  },
  spell: {
    event: () => 'you cast this spell',
    clause: 'When you cast this spell',
    description: 'Resolves in order, then the spell goes to your discard pile.',
  },
  reaction: {
    event: () => 'you play this Reaction',
    clause: 'When you play this Reaction',
    description:
      'Resolves in order inside its printed timing window, then goes to your discard pile.',
  },
});

export const TRIGGER_LIST: readonly (TriggerInfo & { readonly id: TriggerId })[] = TRIGGER_IDS.map(
  (id) => ({ id, ...TRIGGER_REGISTRY[id] }),
);
