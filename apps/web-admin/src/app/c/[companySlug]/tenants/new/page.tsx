import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ChevronLeft } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { TenantForm } from '../_components/tenant-form';

export const metadata: Metadata = {
  title: 'เพิ่มผู้เช่า',
};

interface NewTenantPageProps {
  params: Promise<{ companySlug: string }>;
}

/**
 * /c/[companySlug]/tenants/new — Create form page.
 *
 * Server Component shell — back link + Card chrome, then delegates the
 * actual react-hook-form + Server Action plumbing to <TenantForm/>.
 *
 * Note: admin creates the tenant row FIRST (no LINE binding); the LINE
 * userId is filled in later when the tenant redeems an invite via LIFF
 * (Task #41 flow). Same DTO covers both paths via optional lineUserId.
 */
export default async function NewTenantPage({ params }: NewTenantPageProps) {
  const { companySlug } = await params;

  return (
    <div className="mx-auto max-w-xl space-y-4">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link href={`/c/${companySlug}/tenants`}>
          <ChevronLeft className="mr-1 h-4 w-4" />
          กลับไปรายการผู้เช่า
        </Link>
      </Button>

      <Card>
        <CardHeader>
          <CardTitle>เพิ่มผู้เช่าใหม่</CardTitle>
          <CardDescription>
            กรอกข้อมูลพื้นฐาน — ผู้เช่าจะเข้ามาผูกบัญชี LINE เองภายหลังผ่านลิงก์ LIFF ที่หอพักแชร์ให้ (ดูปุ่ม
            "สร้างลิงก์ผูกบัญชี" ในหน้ารายละเอียด)
          </CardDescription>
        </CardHeader>
        <CardContent>
          <TenantForm companySlug={companySlug} />
        </CardContent>
      </Card>
    </div>
  );
}
