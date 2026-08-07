import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BUNDLED_CARD_SETS, loadCardSets } from '@tcg/card-data';
import { App } from './App.js';
import { AppProvider } from './state/AppContext.js';
import { MatchProvider } from './state/MatchContext.js';
import { CardDataError } from './components/CardDataError.js';
import './styles.css';

const container = document.querySelector('#root');
if (!container) throw new Error('Missing #root element');

// The card database is validated before the app renders. Invalid data is a
// hard stop with actionable errors rather than a half-working builder.
const loaded = loadCardSets(BUNDLED_CARD_SETS);

if (import.meta.env.DEV && loaded.ok && loaded.value.warnings.length > 0) {
  for (const problem of loaded.value.warnings) {
    console.warn(`[card-data] ${problem.code}: ${problem.message}`);
  }
}

createRoot(container).render(
  <StrictMode>
    {loaded.ok ? (
      <AppProvider database={loaded.value.database}>
        <MatchProvider>
          <App />
        </MatchProvider>
      </AppProvider>
    ) : (
      <CardDataError issues={loaded.error} />
    )}
  </StrictMode>,
);
