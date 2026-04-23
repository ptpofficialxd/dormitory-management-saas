import { redirect } from 'next/navigation';

/**
 * Root `/` — bounce to `/login`.
 *
 * `dynamic = 'force-dynamic'` is REQUIRED in Next 15.1: trying to statically
 * pre-render a page whose body is just `redirect()` triggers a React internal
 * "Cannot read properties of null (reading 'useContext')" error during
 * `next build` (the prerender worker can't resolve the redirect against the
 * static export pipeline). Marking the route dynamic skips that step entirely
 * — the redirect happens at request time instead, which is what we want
 * anyway since it has zero static value.
 *
 * Once auth is wired (Task #58 ✅), an authenticated visit to `/` could be
 * upgraded to `redirect('/c/[claimsSlug]/dashboard')` by reading cookies here
 * — kept simple for now and let middleware handle the gating.
 */
export const dynamic = 'force-dynamic';

export default function RootPage(): never {
  redirect('/login');
}
