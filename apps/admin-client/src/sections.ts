/**
 * Every place this build can navigate to.
 *
 * One entry, and that is the tranche's decision rather than an oversight. The
 * milestone's information architecture names nine destinations — Overview, New
 * Test Batch, Queue, Results, Player Meta, Deck Explorer, Card Explorer, Match
 * Explorer, Versions/Data Health — and says how they arrive: *a navigation entry
 * is added only by the tranche that makes its page honest and usable. No
 * decorative empty pages.* A greyed-out "Queue" that leads to "coming soon" is
 * exactly the surface an administrator learns to distrust, because it makes the
 * shell's other claims look like the same kind of claim.
 *
 * So the list is short, and it is a list rather than a switch in the layout, so
 * that M08.8 adds a line here and its screen appears in the navigation, in the
 * order an administrator meets it.
 */

export interface AdminSection {
  readonly id: string;
  /** What the navigation calls it. */
  readonly label: string;
  /** The page's own heading. */
  readonly title: string;
  /** One sentence under the heading, saying what the page is for. */
  readonly summary: string;
}

export const ADMIN_SECTIONS = [
  {
    id: 'overview',
    label: 'Overview',
    title: 'Overview',
    summary:
      'What this lab build is, what it is allowed to do, and what it can run. Every value on ' +
      'this page is read from the orchestration process, not from this bundle.',
  },
] as const satisfies readonly AdminSection[];

export type AdminSectionId = (typeof ADMIN_SECTIONS)[number]['id'];

export const DEFAULT_SECTION: AdminSectionId = 'overview';

export function sectionById(id: AdminSectionId): AdminSection {
  const found = ADMIN_SECTIONS.find((section) => section.id === id);
  // Unreachable while `AdminSectionId` is derived from the list itself; kept
  // because the lookup is what a later tranche's router will use, and a lookup
  // that could return `undefined` is one every caller has to handle.
  if (!found) throw new Error(`Unknown admin section: ${id}`);
  return found;
}
