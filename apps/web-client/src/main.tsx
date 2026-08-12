import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { loadFormatCardData, resolveFormatId } from '@tcg/card-data';
import { deckFormatOf } from '@tcg/deck';
import { App } from './App.js';
import { AppProvider } from './state/AppContext.js';
import { MatchProvider } from './state/MatchContext.js';
import { CardDataError } from './components/CardDataError.js';
import './styles.css';

const container = document.querySelector('#root');
if (!container) throw new Error('Missing #root element');

// The builder runs one format's pool, never the bundled universe: a card the
// server would refuse must not be offerable here (M01.1). `VITE_TCG_FORMAT`
// selects another format — `development` for the fixture set — and is the only
// way to leave the shipping format.
const formatId = resolveFormatId(import.meta.env.VITE_TCG_FORMAT as string | undefined);

// The card database is validated before the app renders. Invalid data, or an
// unknown format, is a hard stop with actionable errors rather than a
// half-working builder.
const loaded = loadFormatCardData(formatId);

if (import.meta.env.DEV && loaded.ok && loaded.value.warnings.length > 0) {
  for (const problem of loaded.value.warnings) {
    console.warn(`[card-data] ${problem.code}: ${problem.message}`);
  }
}

createRoot(container).render(
  <StrictMode>
    {loaded.ok ? (
      <AppProvider database={loaded.value.database} deckFormat={deckFormatOf(loaded.value.format)}>
        <MatchProvider>
          <App />
        </MatchProvider>
      </AppProvider>
    ) : (
      <CardDataError issues={loaded.error} />
    )}
  </StrictMode>,
);
