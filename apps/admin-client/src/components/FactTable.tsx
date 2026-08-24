import type { ReactNode } from 'react';

/**
 * A two-column table of exact values.
 *
 * A real `<table>` with a row header per fact rather than a definition list or a
 * grid of divs, because the milestone's result rules are explicit that **charts
 * supplement exact tables and never replace them**, and *a tooltip is never the
 * only way to obtain a value*. This tranche has no chart at all, so the rule
 * shows up here as the plainer version of itself: every number the service
 * reports is on the page, selectable, and readable by a screen reader as a
 * labelled cell.
 *
 * `note` is a sentence under a value rather than a title attribute, for the same
 * reason.
 */

export interface Fact {
  readonly label: string;
  readonly value: ReactNode;
  /** Why the value is what it is, when the number alone would mislead. */
  readonly note?: string;
}

interface FactTableProps {
  readonly caption: string;
  readonly facts: readonly Fact[];
}

export function FactTable({ caption, facts }: FactTableProps) {
  return (
    <table className="facts">
      <caption className="visually-hidden">{caption}</caption>
      <tbody>
        {facts.map((fact) => (
          <tr key={fact.label}>
            <th scope="row">{fact.label}</th>
            <td>
              <span className="facts__value">{fact.value}</span>
              {fact.note !== undefined && <span className="facts__note">{fact.note}</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
