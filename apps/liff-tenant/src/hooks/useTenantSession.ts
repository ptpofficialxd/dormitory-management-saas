import {
  type LoginLiffResponse,
  loginLiffResponseSchema as sharedLoginLiffResponseSchema,
} from '@dorm/shared/zod';
import { useCallback, useEffect, useState } from 'react';
import type { z } from 'zod';
import { ApiError, apiPost } from '../lib/api.js';
import { clearTenantToken, readTenantToken, writeTenantToken } from '../lib/tenant-token.js';
import { useLiff } from './useLiff.js';

/**
 * Wire variant of LoginLiffResponse — no Date fields, so we can re-use
 * the shared schema as-is. Aliased here so future drift (if shared ever
 * adds Date) is caught at the type-check boundary.
 */
const loginLiffResponseWireSchema = sharedLoginLiffResponseSchema as z.ZodType<LoginLiffResponse>;

/**
 * State machine for the tenant LIFF session.
 *
 *   loading         → waiting for LIFF init OR an exchange round-trip
 *   not_in_client   → LIFF opened outside LINE in-app browser
 *   needs_bind      → LIFF ready but the LINE user is not yet bound to
 *                     a tenant in this company → caller routes to /bind
 *   authenticated   → token in hand, ready to call /me/* endpoints
 *   error           → unrecoverable (network down, schema drift)
 */
export type TenantSessionState =
  | { status: 'loading' }
  | { status: 'not_in_client'; reason: 'opened-outside-line' }
  | { status: 'needs_bind'; companySlug: string }
  | {
      status: 'authenticated';
      token: string;
      tenant: LoginLiffResponse['tenant'];
      /**
       * Drop the token + force a re-exchange on next render. Used by /me/*
       * mutation hooks when they catch a 401 they couldn't auto-recover from.
       */
      reset: () => void;
    }
  | { status: 'error'; error: string };

/**
 * useTenantSession — hydrate or mint a tenant JWT for the current LIFF user.
 *
 * Flow on mount:
 *   1. Wait for LIFF SDK init (delegates to useLiff).
 *   2. If LIFF reports `not_in_client`, surface that — caller renders the
 *      "open this in LINE app" copy.
 *   3. Read sessionStorage for an unexpired token (1h TTL, 30s safety
 *      margin). If present → authenticated.
 *   4. If absent / expired, take the LIFF idToken and exchange it via
 *      `POST /me/auth/exchange`. On success, persist + transition to
 *      authenticated. On 401 → needs_bind (LINE user not yet bound).
 *   5. On any other failure → error (caller renders a retry).
 *
 * Re-trigger model: the effect short-circuits when `state.status !== 'loading'`,
 * so it only does work on the initial mount + after `reset()` flips state back
 * to `'loading'`. This is cleaner than a sentinel counter dep and lets Biome's
 * `useExhaustiveDependencies` rule pass without a suppression.
 *
 * Side effect: on 401 the api client (api.ts) already clears the token. The
 * caller's `reset()` callback drops the in-memory state too so the exchange
 * runs again on next render.
 */
export function useTenantSession(args: { companySlug: string }): TenantSessionState {
  const { companySlug } = args;
  const liff = useLiff();
  const [state, setState] = useState<TenantSessionState>({ status: 'loading' });

  const reset = useCallback(() => {
    clearTenantToken();
    setState({ status: 'loading' });
  }, []);

  useEffect(() => {
    // Only run when we're in the `loading` phase. Once a terminal state has
    // been set (authenticated / needs_bind / error / not_in_client) we don't
    // want this effect to fire again on stable re-renders. `reset()` flips
    // state back to `'loading'` to opt back in.
    if (state.status !== 'loading') return;

    let cancelled = false;

    if (liff.status === 'loading') return;
    if (liff.status === 'not_in_client') {
      setState({ status: 'not_in_client', reason: 'opened-outside-line' });
      return;
    }
    if (liff.status === 'error') {
      setState({ status: 'error', error: liff.error.message });
      return;
    }

    // liff.status === 'ready'
    const cached = readTenantToken();
    if (cached) {
      setState({
        status: 'authenticated',
        token: cached.accessToken,
        // We don't have tenant identity in the cached token blob — only the
        // accessToken + expiry. Decoding the JWT client-side just to read sub
        // is wasteful; consumers that need tenantId can call `reset()` to
        // re-exchange (which DOES return tenant), or read it from a /me/*
        // response. For now expose a minimal placeholder so the type stays
        // honest about what we have.
        tenant: { id: '', companyId: '', companySlug },
        reset,
      });
      return;
    }

    const idToken = liff.getIdToken();
    if (!idToken) {
      // LIFF ready but no idToken means the user isn't logged in to LINE —
      // extremely rare in the in-client flow. Surface as needs_bind so the
      // bind page handles re-login.
      setState({ status: 'needs_bind', companySlug });
      return;
    }

    apiPost('/me/auth/exchange', { companySlug, idToken }, loginLiffResponseWireSchema)
      .then((resp) => {
        if (cancelled) return;
        writeTenantToken(resp.token);
        setState({
          status: 'authenticated',
          token: resp.token.accessToken,
          tenant: resp.tenant,
          reset,
        });
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.statusCode === 401) {
          setState({ status: 'needs_bind', companySlug });
          return;
        }
        const message = err instanceof Error ? err.message : 'เกิดข้อผิดพลาด';
        setState({ status: 'error', error: message });
      });

    return () => {
      cancelled = true;
    };
  }, [liff, companySlug, state.status, reset]);

  return state;
}
