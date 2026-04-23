/**
 * Cookie name constants — kept in a side-effect-free module so middleware
 * (Edge runtime) can import them without pulling in `next/headers` (which is
 * server-only and would error during the Edge bundle).
 *
 * Names are prefixed with `dorm_admin_` to keep apart from the LIFF tenant
 * app should both ever share a domain in the future.
 */
export const ACCESS_COOKIE_NAME = 'dorm_admin_access';
export const REFRESH_COOKIE_NAME = 'dorm_admin_refresh';

/** TTL of the refresh-token cookie. Matches API default `JWT_REFRESH_TTL = 30d`. */
export const REFRESH_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
