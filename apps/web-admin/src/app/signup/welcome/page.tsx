import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getAccessTokenFromCookie } from '@/lib/cookies';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

export const metadata: Metadata = {
  title: 'ยินดีต้อนรับ',
};

interface WelcomePageProps {
  searchParams: Promise<{ slug?: string }>;
}

/**
 * `/signup/welcome` — landing page right after self-signup (Task #114).
 *
 * Showed once: tells the new owner what to set up first. Three CTA cards
 * point at:
 *   1. PromptPay (required before issuing the first invoice)
 *   2. LINE OA   (required before sending push notifications)
 *   3. ห้องแรก   (the first thing they'll want to do anyway)
 *
 * Auth posture: signupAction sets cookies BEFORE redirecting here, so a
 * fresh visit always has the JWT. If someone hits /signup/welcome without
 * a cookie, redirect them to /signup (most likely they bookmarked this).
 *
 * The `slug` is read from query params (signupAction puts it there) so the
 * CTAs can deep-link without us having to decode the JWT here. Falls back
 * to /login if the slug is missing — a half-broken state we shouldn't try
 * to recover.
 */
export default async function WelcomePage({ searchParams }: WelcomePageProps) {
  const sp = await searchParams;
  const slug = typeof sp.slug === 'string' && sp.slug.length > 0 ? sp.slug : undefined;
  const token = await getAccessTokenFromCookie();

  if (!token || !slug) {
    redirect('/signup');
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/30 px-4 py-12">
      <div className="w-full max-w-2xl space-y-6">
        <header className="space-y-2 text-center">
          <p className="text-3xl">✓</p>
          <h1 className="text-2xl font-semibold tracking-tight">ยินดีต้อนรับสู่หอพักของคุณ!</h1>
          <p className="text-sm text-muted-foreground">
            สมัครสำเร็จแล้ว — ใช้ฟรี 14 วัน เริ่มต้นใช้งานด้วย 3 ขั้นตอนนี้
          </p>
        </header>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <CtaCard
            href={`/c/${slug}/settings`}
            badge="1"
            title="ตั้งค่า PromptPay"
            description="ผูกบัญชี PromptPay ของหอ — ใช้สร้าง QR ในใบแจ้งหนี้ให้ผู้เช่าโอนได้"
          />
          <CtaCard
            href={`/c/${slug}/settings`}
            badge="2"
            title="เชื่อม LINE OA"
            description="เพิ่ม Channel ID + Secret + Access Token เพื่อ push บิลและประกาศไปหาผู้เช่า"
          />
          <CtaCard
            href={`/c/${slug}/dashboard`}
            badge="3"
            title="สร้างห้องแรก"
            description="เพิ่มข้อมูลห้องและประเภทห้อง — เริ่มจากห้องเดียวก็ได้ ค่อยขยายภายหลัง"
          />
        </div>

        <p className="text-center text-xs text-muted-foreground">
          ข้ามขั้นตอนได้ —{' '}
          <Link href={`/c/${slug}/dashboard`} className="text-primary underline underline-offset-2">
            ไปแดชบอร์ดเลย
          </Link>
        </p>
      </div>
    </main>
  );
}

interface CtaCardProps {
  href: string;
  badge: string;
  title: string;
  description: string;
}

function CtaCard({ href, badge, title, description }: CtaCardProps) {
  return (
    <Link href={href} className="block transition hover:scale-[1.01]">
      <Card className="h-full">
        <CardHeader className="space-y-2">
          <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
            {badge}
          </span>
          <CardTitle className="text-base">{title}</CardTitle>
        </CardHeader>
        <CardContent>
          <CardDescription>{description}</CardDescription>
        </CardContent>
      </Card>
    </Link>
  );
}
