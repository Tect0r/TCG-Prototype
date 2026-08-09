import { useMemo } from 'react';
import { KEYWORD_REGISTRY, type CardDatabase, type CardDefinition } from '@tcg/card-data';
import {
  contextMessages,
  explainCard,
  publicCardContext,
  resolveTemplate,
  type CardExplanation,
} from '@tcg/help-content';
import type { PlayerView } from '@tcg/rules-engine';
import { CardArt } from '../CardArt.js';
import { useDialog } from './useDialog.js';

/**
 * Reads one card, in as much detail as the player is entitled to.
 *
 * The inspector is strictly read-only. It renders from the seat's own
 * `PlayerView` and dispatches nothing: opening it cannot select, play, target
 * or attack with the card it is describing, and it sends no message to the
 * server at all. That is enforced by construction — this component is never
 * handed the match client.
 *
 * It can only describe cards present in `view.instances`, which the engine
 * populates with exactly the cards this seat may legitimately identify. Hidden
 * hands and deck order are not redacted here; they were never sent.
 */

export interface InspectableCard {
  readonly instanceId: string;
  readonly definitionId: string;
  /** How the player got here, for the panel heading. */
  readonly label: string;
}

export interface CardInspectorProps {
  readonly card: InspectableCard | null;
  readonly view: PlayerView;
  readonly database: CardDatabase;
  readonly onClose: () => void;
  /** Other cards the player can step to without closing the panel. */
  readonly neighbours: readonly InspectableCard[];
  readonly onSelect: (card: InspectableCard) => void;
}

function Steps({ explanation }: { readonly explanation: CardExplanation }) {
  return (
    <>
      {explanation.sections.map((section) => (
        <section key={section.id} className="inspector__section">
          <h4>{section.title}</h4>
          <p className="inspector__timing">{section.timing}</p>
          {section.costs.length > 0 && (
            <p className="inspector__costs">Cost: {section.costs.join(', ')}</p>
          )}
          {section.limit && <p className="inspector__costs">{section.limit}</p>}
          <ol className="inspector__steps">
            {section.steps.map((step, index) => (
              <li key={index}>
                <span className="inspector__step-text">{step.text}</span>
                {step.curated && <span className="inspector__step-note">{step.curated}</span>}
                {step.notes.map((note, noteIndex) => (
                  <span key={noteIndex} className="inspector__step-caveat">
                    {note}
                  </span>
                ))}
              </li>
            ))}
          </ol>
        </section>
      ))}
    </>
  );
}

function Identity({
  definition,
  instance,
}: {
  readonly definition: CardDefinition;
  readonly instance: PlayerView['instances'][string] | undefined;
}) {
  const printedStats =
    definition.attack !== undefined && definition.health !== undefined
      ? `${definition.attack}/${definition.health}`
      : null;
  // On the battlefield the live numbers matter more than the printed ones, so
  // both are shown when they disagree.
  const liveStats =
    instance && instance.zone === 'battlefield' ? `${instance.attack}/${instance.health}` : null;

  return (
    <dl className="inspector__identity">
      <div>
        <dt>Type</dt>
        <dd>
          {definition.type}
          {definition.tags.length > 0 ? ` — ${definition.tags.join(', ')}` : ''}
        </dd>
      </div>
      <div>
        <dt>Cost</dt>
        <dd>{definition.cost === null ? 'never paid for' : `${definition.cost} energy`}</dd>
      </div>
      <div>
        <dt>Colours</dt>
        <dd>
          {definition.colorIdentity.length === 0 ? 'neutral' : definition.colorIdentity.join(', ')}
        </dd>
      </div>
      {printedStats && (
        <div>
          <dt>Attack / health</dt>
          <dd>
            {liveStats && liveStats !== printedStats
              ? `${liveStats} (printed ${printedStats})`
              : printedStats}
          </dd>
        </div>
      )}
    </dl>
  );
}

export function CardInspector({
  card,
  view,
  database,
  onClose,
  neighbours,
  onSelect,
}: CardInspectorProps) {
  const panelRef = useDialog(card !== null, onClose);
  const definition = card ? database.get(card.definitionId) : undefined;

  const explanation = useMemo(
    () => (definition ? explainCard(definition, { database }) : null),
    [definition, database],
  );

  // Context is derived fresh from the current view on every render, so a card
  // being inspected while the match moves on shows the new state rather than a
  // stale snapshot.
  const context = card ? publicCardContext(view, card.instanceId) : null;
  const status = context && definition ? contextMessages(context, definition) : [];

  if (!card || !definition || !explanation) return null;

  const instance = view.instances[card.instanceId];

  return (
    <div className="inspector__backdrop" role="presentation">
      <aside
        className="inspector"
        role="dialog"
        aria-modal="true"
        aria-label={`Card details: ${definition.name}`}
        tabIndex={-1}
        ref={panelRef}
      >
        <header className="inspector__header">
          <div>
            <h3>{definition.name}</h3>
            <p className="inspector__where">{card.label}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close card details">
            Close
          </button>
        </header>

        <div className="inspector__art">
          <CardArt cardId={definition.id} alt="" />
        </div>

        <Identity definition={definition} instance={instance} />

        {definition.displayText && (
          <blockquote className="inspector__printed">
            <p>{definition.displayText}</p>
            <footer>Card text, exactly as printed</footer>
          </blockquote>
        )}

        <p className="inspector__summary">
          {explanation.summary}
          {!explanation.summaryIsCurated && (
            <span className="inspector__generated"> · explanation, generated from card data</span>
          )}
        </p>

        {status.length > 0 && (
          <ul className="inspector__status" aria-label="Right now">
            {status.map((message, index) => (
              <li key={index}>{message}</li>
            ))}
          </ul>
        )}

        <Steps explanation={explanation} />

        {explanation.keywords.length > 0 && (
          <section className="inspector__section">
            <h4>Keywords</h4>
            <dl className="inspector__keywords">
              {explanation.keywords.map((keyword) => (
                <div key={keyword.id}>
                  <dt>
                    {KEYWORD_REGISTRY[keyword.id].name}
                    {!keyword.implemented && <span className="tag tag--warn">no effect yet</span>}
                  </dt>
                  <dd>{resolveTemplate(keyword.fullDefinition)}</dd>
                </div>
              ))}
            </dl>
          </section>
        )}

        {explanation.notes.length > 0 && (
          <section className="inspector__section">
            <h4>Worth knowing</h4>
            <ul className="inspector__notes">
              {explanation.notes.map((note, index) => (
                <li key={index}>{note}</li>
              ))}
            </ul>
          </section>
        )}

        {definition.text?.flavor && <p className="inspector__flavor">{definition.text.flavor}</p>}

        {neighbours.length > 1 && (
          <nav className="inspector__neighbours" aria-label="Other visible cards">
            {neighbours.map((other) => (
              <button
                key={other.instanceId}
                type="button"
                className={`button--quiet${other.instanceId === card.instanceId ? ' is-active' : ''}`}
                onClick={() => onSelect(other)}
              >
                {database.get(other.definitionId)?.name ?? other.definitionId}
              </button>
            ))}
          </nav>
        )}
      </aside>
    </div>
  );
}
