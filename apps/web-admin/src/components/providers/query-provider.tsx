'use client';

import { QueryClient, QueryClientProvider, isServer } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import type { ReactNode } from 'react';

/**
 * TanStack Query provider — wraps the app so any Client Component below it
 * can call `useQuery` / `useMutation`.
 *
 * **Pattern guide for the rest of the app:**
 *
 * 1. **Initial data (read)** — prefer Server Components calling `lib/api.ts`
 *    directly. They run on the server, have cookie access via `cookies()`,
 *    and stream HTML to the browser. No QueryClient hydration overhead.
 *
 * 2. **Client-side reads (refetch, polling, search filter)** — use `useQuery`
 *    with the queryFn wrapping a Server Action:
 *
 *      const { data } = useQuery({
 *        queryKey: ['invoices', filters],
 *        queryFn: () => listInvoicesAction(filters),
 *      });
 *
 *    The Server Action runs on the server (cookie + JWT verify happen there),
 *    the client gets a typed result. No browser-side HTTP client needed —
 *    Next's RPC handles the wire format.
 *
 * 3. **Mutations (create / update / delete)** — `useMutation` wrapping a
 *    Server Action; on success invalidate the relevant queryKey:
 *
 *      const mut = useMutation({
 *        mutationFn: createInvoiceAction,
 *        onSuccess: () => qc.invalidateQueries({ queryKey: ['invoices'] }),
 *      });
 *
 * **Why singleton-on-browser, fresh-on-server:**
 * - Browser: a new QueryClient per render would discard cache between
 *   navigations → slow + flicker. One singleton survives the SPA lifetime.
 * - Server: each request must get its own client to avoid leaking one
 *   user's query cache into another user's render. `isServer` switches
 *   behaviour.
 *
 * Defaults are tuned for the admin app:
 * - `staleTime: 30_000` — admin data isn't second-by-second; 30s reduces
 *   unnecessary refetches when the user navigates back.
 * - `retry: 1` — one retry for transient failures, then surface the error.
 * - `refetchOnWindowFocus: false` — admin tab tends to live in a corner;
 *   refetching every focus thrash is more annoying than helpful.
 * - `mutations.retry: 0` — never retry a mutation automatically (avoids
 *   double-charging an invoice if a request appears to fail but actually
 *   succeeded).
 */
function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: 1,
        refetchOnWindowFocus: false,
      },
      mutations: {
        retry: 0,
      },
    },
  });
}

let browserQueryClient: QueryClient | undefined;

function getQueryClient(): QueryClient {
  if (isServer) {
    // Server: always make a fresh client so caches don't cross requests.
    return makeQueryClient();
  }
  if (!browserQueryClient) browserQueryClient = makeQueryClient();
  return browserQueryClient;
}

export function QueryProvider({ children }: { children: ReactNode }) {
  // NOTE: do NOT memoise via `useState` — the singleton check inside
  // `getQueryClient` already handles SSR-safety, and `useState` would mask
  // the singleton (each Client Component instance would get a separate one).
  const queryClient = getQueryClient();

  return (
    <QueryClientProvider client={queryClient}>
      {children}
      {/* Devtools auto-no-op in production builds (tree-shaken). */}
      {process.env.NODE_ENV === 'development' ? (
        <ReactQueryDevtools initialIsOpen={false} buttonPosition="bottom-right" />
      ) : null}
    </QueryClientProvider>
  );
}
