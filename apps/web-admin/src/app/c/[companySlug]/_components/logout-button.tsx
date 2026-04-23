import { logoutAction } from '@/actions/auth';
import { Button } from '@/components/ui/button';

/**
 * Logout button — uses Next 15 Server Action via `<form action={…}>` so we
 * get progressive enhancement (works without JS) and stay a Server Component
 * (no `'use client'`, no hooks needed).
 *
 * The Server Action clears both cookies and redirects to /login.
 */
export function LogoutButton() {
  return (
    <form action={logoutAction}>
      <Button type="submit" variant="ghost" size="sm">
        ออกจากระบบ
      </Button>
    </form>
  );
}
