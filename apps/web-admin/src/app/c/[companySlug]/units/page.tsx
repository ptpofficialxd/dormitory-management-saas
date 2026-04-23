import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError, api } from '@/lib/api';
import { getAccessTokenFromCookie } from '@/lib/cookies';
import { type PropertyPage, propertyPageSchema } from '@/queries/properties';
import { type UnitPage, unitPageSchema } from '@/queries/units';
import { Plus } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AddUnitButton } from './_components/add-unit-button';
import { UnitsTable } from './_components/units-table';

export const metadata: Metadata = {
  title: 'ห้อง',
};

interface UnitsPageProps {
  params: Promise<{ companySlug: string }>;
  searchParams: Promise<{ cursor?: string; propertyId?: string }>;
}

/**
 * /c/[companySlug]/units — list view.
 *
 * Two parallel fetches:
 *   - units list (filterable by propertyId / status — wired via searchParams)
 *   - properties list (small — for the propertyId → name lookup in the table
 *     and for the empty-state "create a property first" CTA)
 *
 * If the company has zero properties yet, we hide the units table and tell
 * the user to create a property first — units cannot exist without one.
 */
export default async function UnitsPage({ params, searchParams }: UnitsPageProps) {
  const { companySlug } = await params;
  const sp = await searchParams;

  const token = await getAccessTokenFromCookie();
  if (!token) {
    redirect(`/login?next=/c/${companySlug}/units`);
  }

  const qs = new URLSearchParams();
  if (sp.cursor) qs.set('cursor', sp.cursor);
  if (sp.propertyId) qs.set('propertyId', sp.propertyId);
  const queryString = qs.toString() ? `?${qs.toString()}` : '';

  // Use the exported wire types directly — `z.ZodType<T>` inference doesn't
  // narrow defaults (`unitSchema.status.default('vacant')`) so the verbose
  // `Awaited<ReturnType<...>>` form gives back the input shape, not output.
  let unitsPage: UnitPage;
  let propertiesPage: PropertyPage;
  try {
    [unitsPage, propertiesPage] = await Promise.all([
      api.get(`/c/${companySlug}/units${queryString}`, unitPageSchema, { token }),
      api.get(`/c/${companySlug}/properties?limit=100`, propertyPageSchema, { token }),
    ]);
  } catch (err) {
    if (
      err instanceof ApiError &&
      (err.statusCode === 401 || err.code === 'UnauthorizedException')
    ) {
      redirect(`/login?next=/c/${companySlug}/units`);
    }
    console.error('[units/list] failed to load:', err);
    return (
      <Card>
        <CardHeader>
          <CardTitle>โหลดข้อมูลไม่สำเร็จ</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">กรุณาลองรีเฟรชหน้านี้</p>
        </CardContent>
      </Card>
    );
  }

  const propertyNameById = new Map(propertiesPage.items.map((p) => [p.id, p.name]));
  const hasProperties = propertiesPage.items.length > 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">ห้อง / ยูนิต</h1>
          <p className="text-sm text-muted-foreground">
            จัดการห้องเช่าในแต่ละอาคาร ({unitsPage.items.length}
            {unitsPage.nextCursor ? '+' : ''} รายการ)
          </p>
        </div>
        <AddUnitButton companySlug={companySlug} disabled={!hasProperties} />
      </div>

      {!hasProperties ? (
        <Card>
          <CardContent className="py-6 text-center text-sm text-muted-foreground">
            ต้องสร้างอาคารก่อนถึงจะเพิ่มห้องได้ —{' '}
            <Link
              href={`/c/${companySlug}/properties/new`}
              className="text-primary underline-offset-4 hover:underline"
            >
              สร้างอาคารใหม่
            </Link>
          </CardContent>
        </Card>
      ) : (
        <UnitsTable items={unitsPage.items} propertyNameById={propertyNameById} />
      )}

      {unitsPage.nextCursor ? (
        <div className="flex justify-end">
          <Button asChild variant="outline" size="sm">
            <Link
              href={`/c/${companySlug}/units?cursor=${encodeURIComponent(unitsPage.nextCursor)}`}
            >
              หน้าถัดไป
              <Plus className="ml-1 h-3 w-3" />
            </Link>
          </Button>
        </div>
      ) : null}
    </div>
  );
}
