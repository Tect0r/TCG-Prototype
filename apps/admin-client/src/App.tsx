import { useState } from 'react';

import { AdminShell } from './components/AdminShell.js';
import { ConnectGate } from './components/ConnectGate.js';
import { ConnectionBadge } from './components/ConnectionBadge.js';
import { OverviewScreen } from './components/OverviewScreen.js';
import { DEFAULT_SECTION, type AdminSectionId } from './sections.js';
import { useAdminState } from './state/AdminContext.js';

/**
 * Two states, and the application is honest about which one it is in.
 *
 * Until the orchestration process has answered `capabilities`, there is no
 * navigation, no layout and no page — only the reason there isn't one. The shell
 * appears when there is something behind every destination it offers, which for
 * this build is one destination.
 *
 * Nothing else here decides anything: `AdminSession` owns the connection,
 * `sections.ts` owns what exists, and each screen owns its own reading.
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
      <OverviewScreen />
    </AdminShell>
  );
}
