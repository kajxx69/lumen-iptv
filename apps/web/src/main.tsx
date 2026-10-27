import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ApiError } from './api/client.js';
import { App } from './App.js';
import './styles.css';

/** Nouvelles tentatives des lectures d'API (pas des erreurs de droits ni des 404). */
const QUERY_RETRIES = 3;

const client = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failures, err) =>
        failures < QUERY_RETRIES && !(err instanceof ApiError && err.status >= 400 && err.status < 500),
      refetchOnWindowFocus: false,
    },
  },
});

// Ouverture hors ligne : seulement en production (en développement, Vite sert les modules).
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  });
}

const root = document.getElementById('root');
if (root !== null) {
  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={client}>
        <App />
      </QueryClientProvider>
    </StrictMode>,
  );
}
