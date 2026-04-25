import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError, api } from '@/lib/api';
import { getAccessTokenFromCookie } from '@/lib/cookies';
import { type TenantWire, tenantWireSchema } from '@/queries/tenants';
import { ChevronLeft } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { TenantDetail } from '../_components/tenant-detail';

export const metadata: Metadata = {
  title: 'ผู้เช่า · รายละเอียด',
};

interface TenantDetailPageProps {
  params: Promise<{ companySlug: string; id: string }>;
}

/**
 * /c/[companySlug]/tenants/[id] — Detail page (read + edit + status change).
 *
 * Server Component does the initial fetch with the user's JWT, then hands
 * the row off to <TenantDetail/> (Client) which owns the reveal-PII toggle
 * + the status dropdown wired to `updateTenantAction`.
 *
 * 404 → Next's `notFound()` (renders not-found.tsx). Cross-tenant probe
 * (admin from company A asking for tenant from company B) trips RLS at
 * the API and surfaces here as 404 too — no leak of existence.
 */
export default async function TenantDetailPage({ params }: TenantDetailPageProps) {
  const { companySlug, id } = await params;

  const token = await getAccessTokenFromCookie();
  if (!token) {
    redirect(`/login?next=/c/${companySlug}/tenants/${id}`);
  }

  let tenant: TenantWire;
  try {
    tenant = await api.get(`/c/${companySlug}/tenants/${id}`, tenantWireSchema, { token });
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.statusCode === 401 || err.code === 'UnauthorizedException') {
        redirect(`/login?next=/c/${companySlug}/tenants/${id}`);
      }
      if (err.statusCode === 404 || err.code === 'NotFoundException') {
        notFound();
      }
    }
    console.error('[tenants/detail] failed to load:', err);
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
    <div className="mx-auto max-w-2xl space-y-4">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link href={`/c/${companySlug}/tenants`}>
          <ChevronLeft className="mr-1 h-4 w-4" />
          กลับไปรายการผู้เช่า
        </Link>
      </Button>

      <TenantDetail companySlug={companySlug} tenant={tenant} />
    </div>
  );
}
