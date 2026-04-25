import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError, api } from '@/lib/api';
import { getAccessTokenFromCookie } from '@/lib/cookies';
import { propertyPageSchema } from '@/queries/properties';
import { tenantPageSchema } from '@/queries/tenants';
import { unitPageSchema } from '@/queries/units';
import { ChevronLeft } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  ContractForm,
  type PickerProperty,
  type PickerTenant,
  type PickerUnit,
} from '../_components/contract-form';

export const metadata: Metadata = {
  title: 'เพิ่มสัญญา',
};

interface NewContractPageProps {
  params: Promise<{ companySlug: string }>;
}

/**
 * /c/[companySlug]/contracts/new — Create form page.
 *
 * Server-side fetches the unit + tenant + property dictionaries up-front
 * so the form has everything it needs for the dropdown pickers + the
 * "auto-fill rent/deposit from unit.baseRent" UX. No client-side fetch
 * round-trips → form is interactive immediately.
 *
 * Limit 100 each — fine for MVP (typical Thai dorm ≤40 rooms). Phase 2
 * wishlist: combobox with search-as-you-type for 100+ rows.
 */
export default async function NewContractPage({ params }: NewContractPageProps) {
  const { companySlug } = await params;

  const token = await getAccessTokenFromCookie();
  if (!token) {
    redirect(`/login?next=/c/${companySlug}/contracts/new`);
  }

  let units: PickerUnit[] = [];
  let tenants: PickerTenant[] = [];
  let properties: PickerProperty[] = [];
  try {
    const [unitsPage, tenantsPage, propertiesPage] = await Promise.all([
      api.get(`/c/${companySlug}/units?limit=100`, unitPageSchema, { token }),
      api.get(`/c/${companySlug}/tenants?status=active&limit=100`, tenantPageSchema, { token }),
      api.get(`/c/${companySlug}/properties?limit=100`, propertyPageSchema, { token }),
    ]);
    // Project to the smaller picker shape — keeps the Client Component
    // payload lean (no `Date` objects to serialise, no leftover PII).
    units = unitsPage.items.map((u) => ({
      id: u.id,
      propertyId: u.propertyId,
      unitNumber: u.unitNumber,
      baseRent: String(u.baseRent),
    }));
    tenants = tenantsPage.items.map((t) => ({
      id: t.id,
      displayName: t.displayName,
      hasContract: Boolean(t.lineUserId), // approximate — real check is contracts list
    }));
    properties = propertiesPage.items.map((p) => ({ id: p.id, name: p.name }));
  } catch (err) {
    if (err instanceof ApiError && err.statusCode === 401) {
      redirect(`/login?next=/c/${companySlug}/contracts/new`);
    }
    console.error('[contracts/new] failed to load pickers:', err);
    return (
      <Card>
        <CardHeader>
          <CardTitle>โหลดข้อมูลไม่สำเร็จ</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            ต้องมีอย่างน้อย 1 อาคาร / 1 ห้อง / 1 ผู้เช่าก่อนสร้างสัญญา กรุณาเพิ่มข้อมูลเหล่านี้ก่อน
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="mx-auto max-w-xl space-y-4">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link href={`/c/${companySlug}/contracts`}>
          <ChevronLeft className="mr-1 h-4 w-4" />
          กลับไปรายการสัญญา
        </Link>
      </Button>

      <Card>
        <CardHeader>
          <CardTitle>สร้างสัญญาเช่าใหม่</CardTitle>
          <CardDescription>
            เลือกห้อง + ผู้เช่า + กำหนดวันเริ่ม-สิ้นสุด สัญญาจะอยู่ที่สถานะ "ร่าง" จนกดปุ่ม "ยืนยันสัญญา" ในหน้ารายละเอียด —
            ตอนนั้นบิลถึงจะออกอัตโนมัติในรอบถัดไป
          </CardDescription>
        </CardHeader>
        <CardContent>
          {units.length === 0 || tenants.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              ต้องมีอย่างน้อย 1 ห้อง + 1 ผู้เช่าที่สถานะ "พักอยู่" ก่อนจึงจะสร้างสัญญาได้ —{' '}
              <Link href={`/c/${companySlug}/tenants/new`} className="text-primary underline">
                เพิ่มผู้เช่า
              </Link>{' '}
              หรือ{' '}
              <Link href={`/c/${companySlug}/units`} className="text-primary underline">
                ดูห้องทั้งหมด
              </Link>
            </p>
          ) : (
            <ContractForm
              companySlug={companySlug}
              units={units}
              tenants={tenants}
              properties={properties}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
