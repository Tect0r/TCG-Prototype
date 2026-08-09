import { useEffect, useMemo, useRef, useState } from 'react';
import {
  loadRulebook,
  searchRulebook,
  type ResolvedBlock,
  type ResolvedSection,
} from '@tcg/help-content';
import { useDialog } from './useDialog.js';

/**
 * The rulebook, rendered from content.
 *
 * This component knows about block *types*, not about rules. It contains no
 * game numbers, no keyword names and no rule sentences — adding a section or
 * correcting a rule is an edit to `rulebook.json`, and changing a provisional
 * value is an edit to the shared rules configuration. Neither touches this file.
 */

function Block({ block }: { readonly block: ResolvedBlock }) {
  switch (block.type) {
    case 'heading':
      return <h4 className="rulebook__subheading">{block.text}</h4>;
    case 'paragraph':
      return <p className="rulebook__paragraph">{block.text}</p>;
    case 'bulletList':
      return (
        <ul className="rulebook__list">
          {block.items.map((item, index) => (
            <li key={index}>{item}</li>
          ))}
        </ul>
      );
    case 'numberedList':
      return (
        <ol className="rulebook__list">
          {block.items.map((item, index) => (
            <li key={index}>{item}</li>
          ))}
        </ol>
      );
    case 'callout':
      return (
        <aside className={`rulebook__callout rulebook__callout--${block.tone}`}>
          {block.title && <strong>{block.title}</strong>}
          <p>{block.text}</p>
        </aside>
      );
    case 'example':
      return (
        <div className="rulebook__example">
          <strong>{block.title}</strong>
          <ol className="rulebook__list">
            {block.steps.map((step, index) => (
              <li key={index}>{step}</li>
            ))}
          </ol>
        </div>
      );
    case 'configValue':
      return (
        <p className="rulebook__value">
          <span className="rulebook__value-label">{block.label}</span>
          <span className="rulebook__value-number">{block.value}</span>
        </p>
      );
    case 'phaseList':
      return (
        <ol className="rulebook__phases">
          {block.phases.map((phase) => (
            <li key={phase.id}>
              <strong>{phase.name}</strong>
              <span>{phase.description}</span>
            </li>
          ))}
        </ol>
      );
    case 'keywordIndex':
      return (
        <dl className="rulebook__definitions">
          {block.keywords.map((keyword) => (
            <div key={keyword.id} className="rulebook__definition">
              <dt>
                {keyword.name}
                {!keyword.implemented && <span className="tag tag--warn">no effect yet</span>}
              </dt>
              <dd>
                <p>{keyword.fullDefinition}</p>
                {keyword.examples.map((example, index) => (
                  <p key={index} className="rulebook__example-line">
                    {example}
                  </p>
                ))}
              </dd>
            </div>
          ))}
        </dl>
      );
    case 'glossaryIndex':
      return (
        <dl className="rulebook__definitions">
          {block.entries.map((entry) => (
            <div key={entry.id} className="rulebook__definition">
              <dt>{entry.term}</dt>
              <dd>{entry.definition}</dd>
            </div>
          ))}
        </dl>
      );
  }
}

function Section({
  section,
  registerRef,
}: {
  readonly section: ResolvedSection;
  readonly registerRef: (id: string, element: HTMLElement | null) => void;
}) {
  return (
    <section
      className="rulebook__section"
      id={`rulebook-${section.id}`}
      ref={(element) => registerRef(section.id, element)}
      aria-labelledby={`rulebook-heading-${section.id}`}
    >
      <h3 id={`rulebook-heading-${section.id}`}>{section.title}</h3>
      {section.blocks.map((block, index) => (
        <Block key={index} block={block} />
      ))}
    </section>
  );
}

export interface RulebookPanelProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** Section to scroll to on open, so reopening returns to where you were. */
  readonly initialSectionId?: string | null;
  readonly onSectionChange?: (sectionId: string) => void;
}

export function RulebookPanel({
  open,
  onClose,
  initialSectionId = null,
  onSectionChange,
}: RulebookPanelProps) {
  const rulebook = useMemo(() => loadRulebook(), []);
  const [query, setQuery] = useState('');
  const panelRef = useDialog(open, onClose);
  const sectionRefs = useRef(new Map<string, HTMLElement>());

  const results = useMemo(
    () => (query.trim().length >= 2 ? searchRulebook(rulebook, query) : []),
    [rulebook, query],
  );

  const registerRef = (id: string, element: HTMLElement | null): void => {
    if (element) sectionRefs.current.set(id, element);
    else sectionRefs.current.delete(id);
  };

  const goTo = (sectionId: string): void => {
    sectionRefs.current.get(sectionId)?.scrollIntoView({ block: 'start' });
    onSectionChange?.(sectionId);
  };

  // Reopening returns to the section the player was last reading.
  useEffect(() => {
    if (!open || !initialSectionId) return;
    sectionRefs.current.get(initialSectionId)?.scrollIntoView({ block: 'start' });
  }, [open, initialSectionId]);

  if (!open) return null;

  const visible =
    results.length > 0
      ? rulebook.sections.filter((section) =>
          results.some((result) => result.sectionId === section.id),
        )
      : rulebook.sections;

  return (
    <div className="rulebook__backdrop" role="presentation">
      <div
        className="rulebook"
        role="dialog"
        aria-modal="true"
        aria-label={rulebook.title}
        tabIndex={-1}
        ref={panelRef}
      >
        <header className="rulebook__header">
          <h2>{rulebook.title}</h2>
          <label className="field rulebook__search">
            <span>Search the rules</span>
            <input
              type="search"
              value={query}
              placeholder="venom, blocking, energy…"
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <button type="button" onClick={onClose} aria-label="Close the rulebook">
            Close
          </button>
        </header>

        <p className="rulebook__intro">{rulebook.intro}</p>

        <div className="rulebook__body">
          <nav className="rulebook__toc" aria-label="Rulebook contents">
            {query.trim().length >= 2 && (
              <p className="rulebook__result-count">
                {results.length === 0
                  ? 'Nothing matches that.'
                  : `${results.length} section${results.length === 1 ? '' : 's'} match`}
              </p>
            )}
            <ol>
              {(results.length > 0
                ? results.map((result) => ({ id: result.sectionId, title: result.title }))
                : rulebook.sections.map((section) => ({ id: section.id, title: section.title }))
              ).map((entry) => (
                <li key={entry.id}>
                  <button type="button" className="button--quiet" onClick={() => goTo(entry.id)}>
                    {entry.title}
                  </button>
                </li>
              ))}
            </ol>
          </nav>

          <div className="rulebook__content">
            {visible.map((section) => (
              <Section key={section.id} section={section} registerRef={registerRef} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
