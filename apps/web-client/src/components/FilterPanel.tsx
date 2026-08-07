import type { CSSProperties } from 'react';
import {
  CARD_TYPES,
  COLOR_LIST,
  KEYWORD_LIST,
  POWER_CLASS_LIST,
  POWER_CLASS_NAMES,
  ROLE_LIST,
  ROLE_NAMES,
  DECKABLE_CARD_TYPES,
  type CardType,
} from '@tcg/card-data';
import { emptyFilters, isFilterActive, toggle, type FilterState } from '../state/filters.js';

interface FilterPanelProps {
  readonly filters: FilterState;
  readonly onChange: (next: FilterState) => void;
  readonly availableTags: readonly string[];
  readonly maxCost: number;
  readonly hasCommander: boolean;
  readonly resultCount: number;
}

const DECKABLE = new Set<CardType>(DECKABLE_CARD_TYPES);
const typeLabel = (type: CardType) => type.charAt(0).toUpperCase() + type.slice(1);

export function FilterPanel({
  filters,
  onChange,
  availableTags,
  maxCost,
  hasCommander,
  resultCount,
}: FilterPanelProps) {
  const patch = (changes: Partial<FilterState>) => onChange({ ...filters, ...changes });

  return (
    <aside className="filters" aria-label="Card filters">
      <div className="filters__search">
        <label htmlFor="filter-text">Search</label>
        <input
          id="filter-text"
          type="search"
          placeholder="Name or rules text"
          value={filters.text}
          onChange={(event) => patch({ text: event.target.value })}
        />
      </div>

      <p className="filters__count" role="status">
        {resultCount} card{resultCount === 1 ? '' : 's'}
      </p>

      <fieldset className="filters__group">
        <legend>Colour</legend>
        <div className="chip-row">
          {COLOR_LIST.map((color) => (
            <button
              key={color.id}
              type="button"
              className={`chip chip--color${filters.colors.includes(color.id) ? ' is-active' : ''}`}
              style={{ '--chip-color': color.swatch, '--chip-on-color': color.onSwatch } as CSSProperties}
              aria-pressed={filters.colors.includes(color.id)}
              onClick={() => patch({ colors: toggle(filters.colors, color.id) })}
            >
              {color.name}
            </button>
          ))}
        </div>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={filters.includeNeutral}
            onChange={(event) => patch({ includeNeutral: event.target.checked })}
          />
          Include neutral cards
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={filters.commanderLegalOnly}
            disabled={!hasCommander}
            onChange={(event) => patch({ commanderLegalOnly: event.target.checked })}
          />
          Only cards legal for my Commander
        </label>
      </fieldset>

      <fieldset className="filters__group">
        <legend>Card type</legend>
        <div className="chip-row">
          {CARD_TYPES.filter((type) => DECKABLE.has(type)).map((type) => (
            <button
              key={type}
              type="button"
              className={`chip${filters.types.includes(type) ? ' is-active' : ''}`}
              aria-pressed={filters.types.includes(type)}
              onClick={() => patch({ types: toggle(filters.types, type) })}
            >
              {typeLabel(type)}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className="filters__group">
        <legend>Energy cost</legend>
        <div className="chip-row">
          {Array.from({ length: maxCost + 1 }, (_, cost) => {
            const selected = filters.minCost === cost && filters.maxCost === cost;
            return (
              <button
                key={cost}
                type="button"
                className={`chip chip--cost${selected ? ' is-active' : ''}`}
                aria-pressed={selected}
                onClick={() =>
                  patch(
                    selected
                      ? { minCost: emptyFilters.minCost, maxCost: emptyFilters.maxCost }
                      : { minCost: cost, maxCost: cost },
                  )
                }
              >
                {cost}
              </button>
            );
          })}
        </div>
      </fieldset>

      <fieldset className="filters__group">
        <legend>Keyword</legend>
        <div className="chip-row">
          {KEYWORD_LIST.map((keyword) => (
            <button
              key={keyword.id}
              type="button"
              className={`chip${filters.keywords.includes(keyword.id) ? ' is-active' : ''}`}
              aria-pressed={filters.keywords.includes(keyword.id)}
              title={keyword.reminder}
              onClick={() => patch({ keywords: toggle(filters.keywords, keyword.id) })}
            >
              {keyword.name}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className="filters__group">
        <legend>Tag</legend>
        <div className="chip-row chip-row--scroll">
          {availableTags.map((tag) => (
            <button
              key={tag}
              type="button"
              className={`chip${filters.tags.includes(tag) ? ' is-active' : ''}`}
              aria-pressed={filters.tags.includes(tag)}
              onClick={() => patch({ tags: toggle(filters.tags, tag) })}
            >
              {tag}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className="filters__group">
        <legend>Role</legend>
        <div className="chip-row">
          {ROLE_LIST.filter((role) => role !== 'token').map((role) => (
            <button
              key={role}
              type="button"
              className={`chip${filters.roles.includes(role) ? ' is-active' : ''}`}
              aria-pressed={filters.roles.includes(role)}
              onClick={() => patch({ roles: toggle(filters.roles, role) })}
            >
              {ROLE_NAMES[role]}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className="filters__group">
        <legend>Power class</legend>
        <div className="chip-row">
          {POWER_CLASS_LIST.map((powerClass) => (
            <button
              key={powerClass}
              type="button"
              className={`chip${filters.powerClasses.includes(powerClass) ? ' is-active' : ''}`}
              aria-pressed={filters.powerClasses.includes(powerClass)}
              onClick={() => patch({ powerClasses: toggle(filters.powerClasses, powerClass) })}
            >
              {POWER_CLASS_NAMES[powerClass]}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className="filters__group">
        <legend>Uniqueness</legend>
        <div className="chip-row">
          {(
            [
              [undefined, 'Any'],
              [true, 'Unique only'],
              [false, 'Regular only'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={label}
              type="button"
              className={`chip${filters.unique === value ? ' is-active' : ''}`}
              aria-pressed={filters.unique === value}
              onClick={() => patch({ unique: value })}
            >
              {label}
            </button>
          ))}
        </div>
      </fieldset>

      <button
        type="button"
        className="filters__reset"
        disabled={!isFilterActive(filters)}
        onClick={() => onChange({ ...emptyFilters, commanderLegalOnly: filters.commanderLegalOnly })}
      >
        Clear filters
      </button>
    </aside>
  );
}
