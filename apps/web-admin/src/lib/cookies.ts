import 'server-only';
import type { AuthTokens } from '@dorm/shared/zod';
import { cookies } from 'next/headers';
import {
  ACCESS_COOKIE_NAME,
  REFRESH_COOKIE_MAX_AGE_SECONDS,
  REFRESH_COOKIE_NAME,
} from './auth-constants';

/**
 * Server-only helpers for the auth cookies. Middleware uses `req.cookies`
 * directly (Edge has no `next/headers`) — these helpers are for Server
 * Actions and Server Components only.
 *
 * Cookie security:
 * - `httpOnly`: blocks document.cookie access from Client Components / XSS
 * - `sameSite: 'lax'`: lets links from email open authenticated, blocks CSRF
 * - `secure`: HTTPS-only in production (allowed plain in dev for localhost)
 * - `path: '/'`: scoped app-wide (admin routes + login + logout endpoints)
 */
const COMMON_OPTS = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: process.env.NODE_ENV === 'production',
  path: '/',
};

/**
 * Set both access + refresh cookies after a successful /auth/login or
 * /auth/refresh response. Access expires when the JWT does (server-mintedss
 * `accessTokenExpiresAt`); refresh has a hard 30-day TTL on the cookie.
 */
export async function setAuthCookies(tokens: AuthTokens): Promise<void> {
  const store = await cookies();
  store.set(ACCESS_COOKIE_NAME, tokens.accessToken, {
    ...COMMON_OPTS,
    expires: new Date(tokens.accessTokenExpiresAt * 1000),
  });
  store.set(REFRESH_COOKIE_NAME, tokens.refreshToken, {
    ...COMMON_OPTS,
    maxAge: REFRESH_COOKIE_MAX_AGE_SECONDS,
  });
}

/** Clear both cookies. Used on logout and on detected refresh failure. */
export async function clearAuthCookies(): Promise<void> {
  const store = await cookies();
  store.delete(ACCESS_COOKIE_NAME);
  store.delete(REFRESH_COOKIE_NAME);
}

/** Read the access token from cookies. `undefined` when not logged in. */
export async function getAccessTokenFromCookie(): Promise<string | undefined> {
  const store = await cookies();
  return store.get(ACCESS_COOKIE_NAME)?.value;
}
