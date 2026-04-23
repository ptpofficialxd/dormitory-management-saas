import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'เข้าสู่ระบบ',
};

/**
 * Placeholder login page — UI shell only.
 *
 * Task #58 will:
 *   - Convert this into a Client Component (or use Server Action),
 *   - Hook react-hook-form + zodResolver for client-side validation,
 *   - POST to /auth/login via the server-side `api` client,
 *   - Set the `auth_token` httpOnly cookie + redirect to /c/[slug]/dashboard.
 *
 * Keeping it server-rendered for the scaffold lets us verify Tailwind +
 * shadcn primitives compile + render without bringing in client-side JS.
 */
export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/30 px-4 py-12">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">เข้าสู่ระบบผู้ดูแล</CardTitle>
          <CardDescription>สำหรับเจ้าของหอพัก ผู้จัดการ และพนักงานที่ได้รับสิทธิ์เท่านั้น</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">อีเมล</Label>
              <Input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                placeholder="owner@example.com"
                required
                disabled
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">รหัสผ่าน</Label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                disabled
              />
            </div>
          </form>
        </CardContent>
        <CardFooter className="flex flex-col gap-3">
          <Button type="submit" className="w-full" disabled>
            เข้าสู่ระบบ (รอ task #58)
          </Button>
          <p className="text-center text-xs text-muted-foreground">
            หากลืมรหัสผ่าน กรุณาติดต่อแอดมินของบริษัท
          </p>
        </CardFooter>
      </Card>
    </main>
  );
}
