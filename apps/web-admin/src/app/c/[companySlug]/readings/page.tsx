import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError, api } from '@/lib/api';
import { getAccessTokenFromCookie } from '@/lib/cookies';
import { meterPageSchema } from '@/queries/meters';
import { propertyPageSchema } from '@/queries/properties';
import { readingPageSchema } from '@/queries/readings';
import { unitPageSchema } from '@/queries/units';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import {
  type GridMeter,
  type GridProperty,
  type GridReading,
  type GridUnit,
  ReadingsGrid,
} from './_components/readings-grid';

export const metadata: Metadata = {
  title: 'ค่ามิเตอร์',
};

interface ReadingsPageProps {
  params: Promise<{ companySlug: string }>;
  searchParams: Promise<{ propertyId?: string; period?: string }>;
}

/**
 * /c/[companySlug]/readings — Monthly meter reading entry.
 *
 * Workflow this page implements:
 *   1. Staff walks the building once a month to read every meter.
 *   2. They open this page, pick the period (default = current Bangkok month)
 *      and the property they're walking, and see one row per meter.
 *   3. Each row shows the previous reading + an empty input for today's value.
 *      Inline save → server resolves valuePrevious + computes consumption +
 *      enforces "no backwards meters" (NegativeConsumption rule).
 *   4. After all rows are filled, the operator goes to /invoices/generate
 *      to issue the bills — those bills include water/electric line items
 *      sourced from these readings.
 *
 * Server-side fetches in parallel:
 *   - properties → property picker
 *   - units (filtered by property) → row keys
 *   - meters (all company meters, max 100) → 1-2 per unit
 *   - readings (filtered by period) → existing values for the row
 *
 * Why no `unitId`/`propertyId` filter on /meters?
 *   - The API exposes only `unitId` + `kind` filters on meters. Doing N round
 *     trips per unit is wasteful for a 40-room dorm (80 meters fits in 1 page).
 *     We project property-side filtering on the client by joining
 *     unit.propertyId → meter.unitId.
 *
 * Phase 2 wishlist (not blocking MVP):
 *   - API endpoint that returns "readings sheet" pre-joined per period
 *   - Combobox + search-as-you-type for >100 units
 *   - Photo upload via R2 presigned PUT (same pattern as slips)
 */
export default async function ReadingsPage({ params, searchParams }: ReadingsPageProps) {
  const { companySlug } = await params;
  const sp = await searchParams;

  const token = await getAccessTokenFromCookie();
  if (!token) {
    redirect(`/login?next=/c/${companySlug}/readings`);
  }

  // Default period = current Bangkok month. Date.now() is UTC; Asia/Bangkok
  // is UTC+7, so the only edge cases are the 17:00 UTC roll-over each night.
  // `Intl.DateTimeFormat('en-CA')` outputs YYYY-MM-DD; we slice to YYYY-MM.
  const defaultPeriod = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(new Date())
    .slice(0, 7);

  // Period validation: shape only (regex YYYY-MM). Garbage falls back to default
  // — same defensive pattern as contracts list status filter. The regex match
  // also acts as TS narrowing so we don't need to cast `sp.period` to string.
  const period =
    typeof sp.period === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(sp.period)
      ? sp.period
      : defaultPeriod;

  let properties: GridProperty[] = [];
  let units: GridUnit[] = [];
  let meters: GridMeter[] = [];
  let readings: GridReading[] = [];
  try {
    const [propertiesPage, unitsPage, metersPage, readingsPage] = await Promise.all([
      api.get(`/c/${companySlug}/properties?limit=100`, propertyPageSchema, { token }),
      api.get(`/c/${companySlug}/units?limit=100`, unitPageSchema, { token }),
      // Meter list endpoint has no propertyId filter, just unitId + kind.
      // For MVP scale (≤100 meters per company) we pull the lot in one shot
      // and filter client-side via the unit join.
      api.get(`/c/${companySlug}/meters?limit=100`, meterPageSchema, { token }),
      api.get(
        `/c/${companySlug}/readings?period=${encodeURIComponent(period)}&limit=100`,
        readingPageSchema,
        { token },
      ),
    ]);

    properties = propertiesPage.items.map((p) => ({ id: p.id, name: p.name }));

    // Optional property filter — empty / unknown propertyId falls through
    // showing every unit, which is the right default for single-property
    // operators (i.e. nearly everyone in MVP).
    const filteredUnits = sp.propertyId
      ? unitsPage.items.filter((u) => u.propertyId === sp.propertyId)
      : unitsPage.items;

    units = filteredUnits.map((u) => ({
      id: u.id,
      propertyId: u.propertyId,
      unitNumber: u.unitNumber,
      floor: u.floor,
      status: u.status,
    }));

    // Filter meters to those belonging to filtered units. Avoids paying for a
    // table row of an out-of-scope meter when the user has selected a property.
    const visibleUnitIds = new Set(units.map((u) => u.id));
    // Decimal fields (`ratePerUnit`, `valueCurrent`, etc.) are already strings
    // per ADR-0005 — we pass them through unchanged. Projecting to the picker
    // shape keeps the Client Component payload lean (no Date objects to
    // serialise across the SC/CC boundary, no surplus PII).
    meters = metersPage.items
      .filter((m) => visibleUnitIds.has(m.unitId))
      .map((m) => ({
        id: m.id,
        unitId: m.unitId,
        kind: m.kind,
        unitOfMeasure: m.unitOfMeasure,
        ratePerUnit: m.ratePerUnit,
      }));

    readings = readingsPage.items.map((r) => ({
      id: r.id,
      meterId: r.meterId,
      period: r.period,
      valueCurrent: r.valueCurrent,
      valuePrevious: r.valuePrevious,
      consumption: r.consumption,
      photoKey: r.photoKey,
      readAt: r.readAt,
    }));
  } catch (err) {
    if (
      err instanceof ApiError &&
      (err.statusCode === 401 || err.code === 'UnauthorizedException')
    ) {
      redirect(`/login?next=/c/${companySlug}/readings`);
    }
    console.error('[readings/page] failed to load:', err);
    return (
      <Card>
        <CardHeader>
          <CardTitle>โหลดข้อมูลไม่สำเร็จ</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            กรุณาลองรีเฟรชหน้านี้ หรือติดต่อทีมเทคนิคหากปัญหายังเกิดขึ้น
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">ค่ามิเตอร์</h1>
        <p className="text-sm text-muted-foreground">
          กรอกค่ามิเตอร์น้ำ-ไฟรายเดือน ก่อนกด &ldquo;ออกบิล&rdquo; ที่หน้าใบแจ้งหนี้ — ระบบจะคำนวณ consumption
          อัตโนมัติ (current − previous) และปฏิเสธค่าที่เดินถอยหลัง
        </p>
      </div>

      {properties.length === 0 || meters.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">ยังไม่มีมิเตอร์ให้กรอก</CardTitle>
            <CardDescription>
              {properties.length === 0
                ? 'ต้องสร้างอาคารและห้องก่อน — ไปที่เมนู "อาคาร" แล้วเพิ่มอาคาร / ห้อง'
                : 'มีอาคาร/ห้องแล้ว แต่ยังไม่ได้ติดตั้งมิเตอร์ — เพิ่มมิเตอร์ผ่าน API หรือ Prisma Studio (admin UI สำหรับ meter จะมาใน Phase 2)'}
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <ReadingsGrid
          companySlug={companySlug}
          period={period}
          activePropertyId={sp.propertyId ?? null}
          properties={properties}
          units={units}
          meters={meters}
          readings={readings}
        />
      )}
    </div>
  );
}
