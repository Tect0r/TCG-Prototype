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
  /** Player-facing timing detail shown in the inspector and glossary. */
  readonly description: string;
}

export const TRIGGER_REGISTRY: Readonly<Record<TriggerId, TriggerInfo>> = Object.freeze({
  on_attack: {
    clause: 'When this unit attacks',
    description:
      'Fires once when this unit is declared as an attacker, before blockers are assigned.',
  },
  on_block: {
    clause: 'When this unit blocks',
    description: 'Fires once when this unit is assigned as a blocker, before combat damage.',
  },
  on_survive_combat: {
    clause: 'If this unit survives combat',
    description:
      'Fires after combat damage has been dealt, if this unit is still on the battlefield.',
  },
  on_defeated: {
    clause: 'When this unit is defeated',
    description:
      'Fires when this unit leaves the battlefield as a defeat, whether from damage, a destroy effect or a sacrifice. The ability still resolves even though its source has gone.',
  },
  on_turn_start: {
    clause: "At the start of its controller's turn",
    description: "Fires during the Turn Start phase of the controller's own turn.",
  },
  on_turn_end: {
    clause: "At the end of its controller's turn",
    description:
      "Fires during the Turn End phase of the controller's own turn, before the hand-size discard.",
  },
  on_sacrifice: {
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
export const DEPLOY_TRIGGER: Readonly<Record<'unit' | 'relic' | 'spell' | 'token', TriggerInfo>> =
  Object.freeze({
    unit: {
      clause: 'When this unit is deployed',
      description: 'Resolves once, as the unit enters the battlefield.',
    },
    token: {
      clause: 'When this token is created',
      description: 'Resolves once, as the token enters the battlefield.',
    },
    relic: {
      clause: 'When this relic is deployed',
      description: 'Resolves once, as the relic enters play.',
    },
    spell: {
      clause: 'When you cast this spell',
      description: 'Resolves in order, then the spell goes to your discard pile.',
    },
  });

export const TRIGGER_LIST: readonly (TriggerInfo & { readonly id: TriggerId })[] = TRIGGER_IDS.map(
  (id) => ({ id, ...TRIGGER_REGISTRY[id] }),
);
