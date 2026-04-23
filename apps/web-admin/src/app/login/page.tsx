import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import type { Metadata } from 'next';
import { LoginForm } from './_components/login-form';

export const metadata: Metadata = {
  title: 'เข้าสู่ระบบ',
};

interface LoginPageProps {
  searchParams: Promise<{ next?: string; slug?: string }>;
}

/**
 * /login — admin entry point.
 *
 * `next` (set by middleware on auth-required redirects) and `slug` (optional
 * deep-link convenience) come in via searchParams. Both are sanitised before
 * being passed to the client form: `next` only when it points under `/c/`,
 * `slug` is just a string the user can change anyway.
 *
 * The actual safety check on `next` lives in `loginAction` (server-side)
 * — we cannot rely on this server-component sanitisation alone because
 * the client could call `loginAction(values, '<malicious>')` directly.
 */
export default async function LoginPage({ searchParams }: LoginPageProps) {
  const sp = await searchParams;
  const safeNext = typeof sp.next === 'string' && sp.next.startsWith('/c/') ? sp.next : undefined;
  const slug = typeof sp.slug === 'string' ? sp.slug : undefined;

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/30 px-4 py-12">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">เข้าสู่ระบบผู้ดูแล</CardTitle>
          <CardDescription>สำหรับเจ้าของหอพัก ผู้จัดการ และพนักงานที่ได้รับสิทธิ์เท่านั้น</CardDescription>
        </CardHeader>
        <CardContent>
          <LoginForm defaultCompanySlug={slug} next={safeNext} />
        </CardContent>
        <CardFooter>
          <p className="w-full text-center text-xs text-muted-foreground">
            หากลืมรหัสผ่าน กรุณาติดต่อแอดมินของบริษัท
          </p>
        </CardFooter>
      </Card>
    </main>
  );
}
