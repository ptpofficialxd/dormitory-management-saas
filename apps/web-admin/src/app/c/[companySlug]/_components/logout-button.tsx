import { logoutAction } from '@/actions/auth';
import { Button } from '@/components/ui/button';
import { LogOut } from 'lucide-react';

/**
 * Logout button — uses Next 15 Server Action via `<form action={…}>` so we
 * get progressive enhancement (works without JS) and stay a Server Component.
 *
 * Shipped as a Server Component on purpose so it can be passed as a
 * `ReactNode` prop into the Client `AdminShell` (Server Components cannot be
 * imported by Client Components, but they CAN be passed as children/props).
 *
 * The Server Action clears both auth cookies and redirects to /login.
 */
export function LogoutButton() {
  return (
    <form action={logoutAction}>
      <Button type="submit" variant="ghost" size="sm">
        <LogOut className="mr-1 h-4 w-4" />
        <span className="hidden sm:inline">ออกจากระบบ</span>
      </Button>
    </form>
  );
}
