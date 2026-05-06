import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ChevronLeft } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { AnnouncementForm } from './_components/announcement-form';

export const metadata: Metadata = {
  title: 'ประกาศใหม่',
};

interface NewAnnouncementPageProps {
  params: Promise<{ companySlug: string }>;
}

/**
 * /c/[companySlug]/announcements/new — compose form page (Task #108).
 *
 * Server Component shell — back link + Card chrome + warning text. The
 * actual form (react-hook-form + zod + Server Action) is the Client
 * `<AnnouncementForm/>` since v1 only ever lands the "audience=all +
 * sendNow=true" shape, no recipient picker is needed.
 *
 * Phase 1 wishlist: server-side fetch active-tenant count to render
 * "X recipients will receive this" before the user clicks send. For v1
 * the warning text below tells them what'll happen without the count.
 */
export default async function NewAnnouncementPage({ params }: NewAnnouncementPageProps) {
  const { companySlug } = await params;

  return (
    <div className="mx-auto max-w-xl space-y-4">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link href={`/c/${companySlug}/announcements`}>
          <ChevronLeft className="mr-1 h-4 w-4" />
          กลับไปรายการประกาศ
        </Link>
      </Button>

      <Card>
        <CardHeader>
          <CardTitle>ส่งประกาศใหม่</CardTitle>
          <CardDescription>
            ข้อความนี้จะถูกส่งไปยังผู้เช่าทุกคนที่ผูกบัญชี LINE แล้ว ผ่าน LINE OA ของหอ — ส่งแล้วยกเลิกไม่ได้
            กรุณาตรวจทานก่อนกด "ส่งประกาศ"
          </CardDescription>
        </CardHeader>
        <CardContent>
          <AnnouncementForm companySlug={companySlug} />
        </CardContent>
      </Card>
    </div>
  );
}
