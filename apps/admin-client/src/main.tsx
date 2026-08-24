import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.js';
import { AdminProvider } from './state/AdminContext.js';
import './styles.css';

/**
 * The administrator bundle's entry point — a separate application from the
 * player's, with its own `index.html` and its own root element (ADR 0023 §1).
 *
 * There is no card database to load here and no format to resolve: this
 * application reads a lab, not a game. Everything it can show comes from the
 * orchestration process, so the first thing it does is ask.
 */
const container = document.querySelector('#admin-root');
if (!container) throw new Error('Missing #admin-root element');

createRoot(container).render(
  <StrictMode>
    <AdminProvider>
      <App />
    </AdminProvider>
  </StrictMode>,
);
