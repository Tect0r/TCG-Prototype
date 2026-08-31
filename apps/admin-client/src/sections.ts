/**
 * Every place this build can navigate to.
 *
 * Two entries, and the second arrived exactly the way M08.7 said one would. The
 * milestone's information architecture names nine destinations — Overview, New
 * Test Batch, Queue, Results, Player Meta, Deck Explorer, Card Explorer, Match
 * Explorer, Versions/Data Health — and says how they arrive: *a navigation entry
 * is added only by the tranche that makes its page honest and usable. No
 * decorative empty pages.* A greyed-out "Queue" that leads to "coming soon" is
 * exactly the surface an administrator learns to distrust, because it makes the
 * shell's other claims look like the same kind of claim.
 *
 * M08.8 owns **New Test Batch** and adds it here, because there is now a form
 * behind it that configures, prices and enqueues a real precon benchmark.
 *
 * M08.9 owns **Queue**, and it is a destination for a stronger reason than the
 * other two: until this tranche a batch was released by the same call that
 * filled it, so an administrator who pressed *enqueue* had already started the
 * work and had nowhere to see it. Now a batch is a draft until somebody starts
 * it, and this is the page where that happens — where the order is set, where a
 * job is duplicated or withdrawn, and where the four lifecycle verbs have a
 * button. The builder without it would be a form that creates work nothing can
 * run.
 *
 * The remaining six are still absent. The list is still a list rather than a
 * switch in the layout, so the tranche after this one adds a line and its screen
 * appears in the navigation, in the order an administrator meets it.
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
  {
    id: 'new-test-batch',
    label: 'New Test Batch',
    title: 'New Test Batch',
    summary:
      'Configure a precon benchmark against the content this lab is running right now, see the ' +
      'exact number of matches it schedules, and add it to a draft batch. Nothing here is ' +
      'authored as JSON, and nothing here starts a run.',
  },
  {
    id: 'queue',
    label: 'Queue',
    title: 'Queue',
    summary:
      'Order a draft before it runs, start it, and watch what it does. Every state, count and ' +
      'instant on this page is the orchestration process reporting on its own work.',
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
