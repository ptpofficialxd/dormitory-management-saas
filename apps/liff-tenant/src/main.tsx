import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App.js';
import './index.css';

/**
 * Single QueryClient for the whole app. Defaults tuned for LIFF:
 * - retry: 1 (LIFF in-app browser is on mobile data; one retry is enough,
 *   beyond that we'd rather surface the error than spin forever).
 * - refetchOnWindowFocus: false (LIFF doesn't have meaningful "focus"
 *   events; user stays in the LINE in-app browser).
 * - staleTime: 0 (we want fresh peek data on every load — invite state
 *   can change between admin revoking it and tenant opening the link).
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 0,
    },
    mutations: {
      retry: 0,
    },
  },
});

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('Missing #root mount node');
}

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
