import { useEffect, useState } from 'react';
import { initLiff, liff } from '../lib/liff.js';

/**
 * State machine of LIFF readiness.
 *
 *   loading → ready                    (happy path)
 *   loading → not_in_client            (browser is not LINE in-app browser)
 *   loading → error                    (init network / config failure)
 */
export type LiffState =
  | { status: 'loading' }
  | {
      status: 'ready';
      isInClient: boolean;
      isLoggedIn: boolean;
      /** Returns the JWT idToken for backend verification. Null if not logged in. */
      getIdToken: () => string | null;
      /** Closes the LIFF window and returns user to the LINE chat. */
      closeWindow: () => void;
    }
  | { status: 'not_in_client'; reason: 'opened-outside-line' }
  | { status: 'error'; error: Error };

/**
 * useLiff — tracks LIFF SDK initialisation and exposes safe accessors.
 *
 * Why not call liff.* directly inside components?
 *   1. liff methods throw if invoked before init resolves.
 *   2. We need a single source of truth for "is the SDK ready?" so the bind
 *      page can render `<Loading/>` until idToken is obtainable.
 */
export function useLiff(): LiffState {
  const [state, setState] = useState<LiffState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;

    initLiff()
      .then(() => {
        if (cancelled) return;

        // Outside the LINE in-app browser the user CAN still complete the
        // login redirect flow, but for our bind use-case we require the
        // LINE in-app browser so liff.getIDToken() returns immediately
        // without a full OAuth redirect (which leaves LIFF context).
        if (!liff.isInClient()) {
          setState({ status: 'not_in_client', reason: 'opened-outside-line' });
          return;
        }

        setState({
          status: 'ready',
          isInClient: true,
          isLoggedIn: liff.isLoggedIn(),
          getIdToken: () => liff.getIDToken(),
          closeWindow: () => liff.closeWindow(),
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          status: 'error',
          error: err instanceof Error ? err : new Error(String(err)),
        });
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
