import { useState } from 'react';

import { AdminShell } from './components/AdminShell.js';
import { BuilderScreen } from './components/BuilderScreen.js';
import { ConnectGate } from './components/ConnectGate.js';
import { ConnectionBadge } from './components/ConnectionBadge.js';
import { OverviewScreen } from './components/OverviewScreen.js';
import { QueueScreen } from './components/QueueScreen.js';
import { DEFAULT_SECTION, type AdminSectionId } from './sections.js';
import { useAdminState } from './state/AdminContext.js';

/**
 * Two states, and the application is honest about which one it is in.
 *
 * Until the orchestration process has answered `capabilities`, there is no
 * navigation, no layout and no page — only the reason there isn't one. The shell
 * appears when there is something behind every destination it offers, which for
 * this build is three destinations.
 *
 * Nothing else here decides anything: `AdminSession` owns the connection,
 * `sections.ts` owns what exists, and each screen owns its own reading.
 *
 * The section switch is exhaustive over `AdminSectionId` by construction — three
 * destinations, three screens — so a fourth entry in `sections.ts` without a
 * screen behind it would render the wrong page rather than an empty one, which
 * is the failure mode the milestone's *no decorative empty pages* rule exists to
 * prevent and the reason the entry is added by the tranche that builds the page.
 */
export function App() {
  const state = useAdminState();
  const [section, setSection] = useState<AdminSectionId>(DEFAULT_SECTION);

  if (state.connection.status !== 'connected') return <ConnectGate />;

  const { capabilities, checkedAt, authenticated } = state.connection;

  return (
    <AdminShell
      section={section}
      onSelectSection={setSection}
      connection={
        <ConnectionBadge
          capabilities={capabilities}
          checkedAt={checkedAt}
          authenticated={authenticated}
          busy={state.busy}
        />
      }
    >
      {section === 'overview' && <OverviewScreen />}
      {section === 'new-test-batch' && <BuilderScreen />}
      {section === 'queue' && <QueueScreen />}
    </AdminShell>
  );
}
