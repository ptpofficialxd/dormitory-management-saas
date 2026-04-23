import liff from '@line/liff';
import { env } from '../env.js';

/**
 * Singleton LIFF init. The SDK is global state inside the bundle, so we
 * gate the init() call behind a single Promise that all callers await.
 *
 * Behaviour:
 * - Returns the same Promise across the whole app lifecycle.
 * - On success, resolves with the live `liff` namespace.
 * - On failure, the Promise rejects ONCE — subsequent calls re-trigger init
 *   (so transient init failures, e.g. user opened in non-LINE browser then
 *   moved to LINE, can recover).
 *
 * Why not auto-init in main.tsx?
 *   We want the React tree to render even when LIFF init fails (e.g. in a
 *   regular browser during local dev) so we can show a "Open in LINE" hint
 *   instead of a blank screen.
 */
let initPromise: Promise<typeof liff> | null = null;

export function initLiff(): Promise<typeof liff> {
  if (initPromise) {
    return initPromise;
  }
  initPromise = liff
    .init({ liffId: env.VITE_LIFF_ID })
    .then(() => liff)
    .catch((err: unknown) => {
      // Reset so a retry can attempt init again. Bubble the error up so
      // the hook surface can render the appropriate fallback UI.
      initPromise = null;
      throw err;
    });
  return initPromise;
}

/**
 * Re-export the liff namespace for direct use after init has resolved.
 * Calling these BEFORE `initLiff()` resolves throws — always await the
 * hook's `ready` flag first.
 */
export { liff };
