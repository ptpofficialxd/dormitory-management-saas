import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App.js';
import './index.css';
import { initLiff } from './lib/liff.js';

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

// Build the React root NOW (synchronously, while `rootEl` is type-narrowed
// to `HTMLElement`). TS doesn't carry control-flow narrowing into nested
// function closures — referencing `rootEl` inside `mount()` would widen back
// to `HTMLElement | null`. Capturing the `Root` here keeps the closure clean.
const root = createRoot(rootEl);

function mount(): void {
  root.render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </QueryClientProvider>
    </StrictMode>,
  );
}

/**
 * Wait for `liff.init()` BEFORE mounting React.
 *
 * Why: LIFF SDK encodes the original sub-URL into `?liff.state=...` when LINE
 * redirects from `liff.line.me/<id>/c/.../bind?code=XXX` to our endpoint.
 * `liff.init()` then restores the URL to `/c/.../bind?code=XXX` via
 * `history.replaceState`. React Router does NOT listen for replaceState — so
 * if React mounts BEFORE init resolves, BrowserRouter sees pathname `/`,
 * matches `*`, and shows the NotFound screen forever.
 *
 * Init failures are non-fatal here — `useLiff` will surface the error UI
 * downstream (e.g. "Open in LINE app to continue").
 *
 * Safety net: if init hangs (network, blocked SDK CDN), mount after 4 s
 * anyway so the user sees SOMETHING instead of a permanent blank page.
 */
const INIT_TIMEOUT_MS = 4000;
const initOrTimeout = Promise.race([
  initLiff().catch(() => undefined),
  new Promise((resolve) => setTimeout(resolve, INIT_TIMEOUT_MS)),
]);
initOrTimeout.then(mount);
