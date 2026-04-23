import { redirect } from 'next/navigation';

/**
 * Root `/` — bounce to `/login`.
 *
 * Once we wire the auth middleware (Task #58), unauthenticated traffic at
 * any path under `/c/[slug]/*` is redirected to `/login`; conversely, a
 * logged-in user hitting `/` should land on their company dashboard. Until
 * then, always send to `/login` so onboarding has a single entry point.
 */
export default function RootPage(): never {
  redirect('/login');
}
