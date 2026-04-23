import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ArrowLeft } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { GenerateForm } from './_components/generate-form';

export const metadata: Metadata = {
  title: 'สร้างใบแจ้งหนี้ประจำรอบ',
};

interface GeneratePageProps {
  params: Promise<{ companySlug: string }>;
}

/**
 * /c/[companySlug]/invoices/generate — batch generation wizard.
 *
 * Single-page form (not a multi-step wizard) — the inputs fit one screen:
 * period, dueDayOfMonth. The result panel renders inline below the form
 * after submit so the operator can read skip reasons, fix the underlying
 * data (missing meter readings etc), and re-run without navigating.
 *
 * The propertyId scope filter and per-batch additionalItems are out of
 * MVP scope; both are accepted by the API and can be added to the form
 * once the dorm has multiple properties or recurring fees beyond
 * rent + meter readings.
 *
 * RBAC: this entire route requires `create:invoice` (owner + manager).
 * The link in to this page is gated by <Can> on the list page; the API
 * enforces the same matrix on POST /invoices/batch.
 */
export default async function GeneratePage({ params }: GeneratePageProps) {
  const { companySlug } = await params;

  return (
    <div className="space-y-4">
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-3">
          <Link href={`/c/${companySlug}/invoices`}>
            <ArrowLeft className="mr-1 h-4 w-4" />
            กลับไปรายการ
          </Link>
        </Button>
      </div>

      <div>
        <h1 className="text-xl font-semibold tracking-tight">สร้างใบแจ้งหนี้ประจำรอบ</h1>
        <p className="text-sm text-muted-foreground">
          ระบบจะสร้างบิลแบบ "ร่าง" ให้ทุกสัญญาที่ใช้งานอยู่ในรอบที่เลือก จากนั้นกด "ออกบิล" ในแต่ละใบเพื่อยืนยัน
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>ตั้งค่ารอบบิล</CardTitle>
        </CardHeader>
        <CardContent>
          <GenerateForm companySlug={companySlug} />
        </CardContent>
      </Card>
    </div>
  );
}
