import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError, api } from '@/lib/api';
import { getAccessTokenFromCookie } from '@/lib/cookies';
import { type PropertyPage, propertyPageSchema } from '@/queries/properties';
import { ChevronLeft } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { UnitForm } from '../_components/unit-form';

export const metadata: Metadata = {
  title: 'เพิ่มห้อง',
};

interface NewUnitPageProps {
  params: Promise<{ companySlug: string }>;
}

/**
 * /c/[companySlug]/units/new — Create form page.
 *
 * Server Component fetches properties (for the dropdown) then hands off to
 * `<UnitForm>` (Client) for the actual form. We pass only `id + name` so
 * the client bundle doesn't ship full Property objects (smaller payload +
 * less data leaked into the HTML stream).
 */
export default async function NewUnitPage({ params }: NewUnitPageProps) {
  const { companySlug } = await params;

  const token = await getAccessTokenFromCookie();
  if (!token) {
    redirect(`/login?next=/c/${companySlug}/units/new`);
  }

  let propertiesPage: PropertyPage;
  try {
    propertiesPage = await api.get(`/c/${companySlug}/properties?limit=100`, propertyPageSchema, {
      token,
    });
  } catch (err) {
    if (
      err instanceof ApiError &&
      (err.statusCode === 401 || err.code === 'UnauthorizedException')
    ) {
      redirect(`/login?next=/c/${companySlug}/units/new`);
    }
    throw err;
  }

  // Empty-state — block the form entirely if no property exists yet.
  if (propertiesPage.items.length === 0) {
    return (
      <div className="mx-auto max-w-xl space-y-4">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link href={`/c/${companySlug}/units`}>
            <ChevronLeft className="mr-1 h-4 w-4" />
            กลับไปรายการห้อง
          </Link>
        </Button>
        <Card>
          <CardHeader>
            <CardTitle>ไม่มีอาคารในระบบ</CardTitle>
            <CardDescription>ต้องสร้างอาคารก่อนจึงจะเพิ่มห้องได้</CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild>
              <Link href={`/c/${companySlug}/properties/new`}>สร้างอาคารใหม่</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Strip to just the fields the form needs.
  const propertyOptions = propertiesPage.items.map((p) => ({ id: p.id, name: p.name }));

  return (
    <div className="mx-auto max-w-xl space-y-4">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link href={`/c/${companySlug}/units`}>
          <ChevronLeft className="mr-1 h-4 w-4" />
          กลับไปรายการห้อง
        </Link>
      </Button>

      <Card>
        <CardHeader>
          <CardTitle>เพิ่มห้องใหม่</CardTitle>
          <CardDescription>กรอกข้อมูลห้องเช่า — หมายเลขห้องต้องไม่ซ้ำในอาคารเดียวกัน</CardDescription>
        </CardHeader>
        <CardContent>
          <UnitForm companySlug={companySlug} properties={propertyOptions} />
        </CardContent>
      </Card>
    </div>
  );
}
