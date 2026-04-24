import type { TenantAuthToken } from '@dorm/shared/zod';

/**
 * Tenant session token storage — sessionStorage-backed so it survives
 * LIFF page reloads but drops when the tab/window closes (tighter
 * lifetime than localStorage for a LINE-embedded browser context).
 *
 * XSS exposure: sessionStorage is JS-readable, so a script-injection
 * inside LIFF would exfil the token. Mitigations:
 *   - LIFF runs inside LINE's in-app browser with LINE-managed origin
 *     policies (no 3rd-party iframes in our code).
 *   - We never render user-controlled HTML (all content is Zod-validated
 *     wire data rendered via React).
 *   - Token TTL is 1h (matches LINE idToken lifetime) — narrow blast
 *     radius vs. a long-lived refresh token.
 *
 * Safety margin: `isValid()` rejects tokens inside the last 30s of
 * their TTL so callers don't proceed with a token that expires mid-
 * request. Re-exchange is cheap (one LINE verify call).
 *
 * No cross-tab sync — sessionStorage is per-tab by design. A tenant
 * opening two LIFF tabs will run two exchange flows, which is fine:
 * LINE's verify endpoint is idempotent and the API mints distinct JWTs
 * per exchange.
 */

const STORAGE_KEY = 'dorm.tenant.token.v1';
const EXPIRY_SAFETY_MARGIN_SECONDS = 30;

/** Read the current token if it's still valid. Returns null otherwise. */
export function readTenantToken(): TenantAuthToken | null {
  if (typeof sessionStorage === 'undefined') return null; // SSR safety
  const raw = sessionStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as TenantAuthToken;
    if (!isValid(parsed)) {
      sessionStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return parsed;
  } catch {
    // Corrupt storage — drop it. Next exchange will seed a fresh token.
    sessionStorage.removeItem(STORAGE_KEY);
    return null;
  }
}

/** Persist a fresh token. Overwrites any previous token in the same tab. */
export function writeTenantToken(token: TenantAuthToken): void {
  if (typeof sessionStorage === 'undefined') return;
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(token));
}

/** Drop the token. Call on explicit logout or after a 401 from /me/*. */
export function clearTenantToken(): void {
  if (typeof sessionStorage === 'undefined') return;
  sessionStorage.removeItem(STORAGE_KEY);
}

/**
 * A token is valid when NOW + safety margin < its exp. `accessTokenExpiresAt`
 * is UNIX epoch SECONDS (matches the shape minted by JwtService).
 */
function isValid(token: TenantAuthToken): boolean {
  if (typeof token.accessTokenExpiresAt !== 'number') return false;
  const nowSeconds = Math.floor(Date.now() / 1000);
  return token.accessTokenExpiresAt - EXPIRY_SAFETY_MARGIN_SECONDS > nowSeconds;
}
