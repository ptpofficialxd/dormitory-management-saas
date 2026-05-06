import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import type { Metadata } from 'next';
import Link from 'next/link';
import { SignupForm } from './_components/signup-form';

export const metadata: Metadata = {
  title: 'สมัครหอพักใหม่',
};

/**
 * `/signup` — self-signup wizard for new dormitory owners (AUTH-004 / Task #114).
 *
 * v1 is a single-step form: companyName + slug + ownerEmail + password +
 * displayName + acceptTerms → creates Company + User + RoleAssignment + audit
 * row in one tx, mints JWT cookies, lands the user at `/signup/welcome`.
 *
 * No `searchParams` (yet) — affiliate / referral codes are Phase 2.
 */
export default function SignupPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/30 px-4 py-12">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-xl">สมัครหอพักใหม่</CardTitle>
          <CardDescription>
            สร้างบัญชีเจ้าของหอ + ลิงก์ <code className="font-mono">/c/[รหัสหอ]</code> ของคุณเองภายใน 1 นาที
            — ทดลองใช้ฟรี 14 วัน
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SignupForm />
        </CardContent>
        <CardFooter>
          <p className="w-full text-center text-xs text-muted-foreground">
            มีบัญชีอยู่แล้ว?{' '}
            <Link href="/login" className="text-primary underline underline-offset-2">
              เข้าสู่ระบบ
            </Link>
          </p>
        </CardFooter>
      </Card>
    </main>
  );
}
