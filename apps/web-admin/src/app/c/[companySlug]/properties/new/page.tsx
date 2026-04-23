import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ChevronLeft } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { PropertyForm } from '../_components/property-form';

export const metadata: Metadata = {
  title: 'เพิ่มอาคาร',
};

interface NewPropertyPageProps {
  params: Promise<{ companySlug: string }>;
}

/**
 * /c/[companySlug]/properties/new — Create form page.
 *
 * Server Component shell — renders the breadcrumb-back link + Card chrome,
 * then hands off to `<PropertyForm>` (Client) for the actual react-hook-form
 * + Server Action submission.
 */
export default async function NewPropertyPage({ params }: NewPropertyPageProps) {
  const { companySlug } = await params;

  return (
    <div className="mx-auto max-w-xl space-y-4">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link href={`/c/${companySlug}/properties`}>
          <ChevronLeft className="mr-1 h-4 w-4" />
          กลับไปรายการอาคาร
        </Link>
      </Button>

      <Card>
        <CardHeader>
          <CardTitle>เพิ่มอาคารใหม่</CardTitle>
          <CardDescription>
            กรอกข้อมูลอาคารหรือโครงการ — รหัสอาคารใช้ใน URL ต้องไม่ซ้ำกับอาคารอื่นในบริษัทเดียวกัน
          </CardDescription>
        </CardHeader>
        <CardContent>
          <PropertyForm companySlug={companySlug} />
        </CardContent>
      </Card>
    </div>
  );
}
