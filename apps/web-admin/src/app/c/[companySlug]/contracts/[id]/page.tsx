import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError, api } from '@/lib/api';
import { getAccessTokenFromCookie } from '@/lib/cookies';
import { type ContractWire, contractWireSchema } from '@/queries/contracts';
import { tenantWireSchema } from '@/queries/tenants';
import { unitWireSchema } from '@/queries/units';
import { ChevronLeft } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ContractDetail } from '../_components/contract-detail';

export const metadata: Metadata = {
  title: 'สัญญา · รายละเอียด',
};

interface ContractDetailPageProps {
  params: Promise<{ companySlug: string; id: string }>;
}

/**
 * /c/[companySlug]/contracts/[id] — Detail page.
 *
 * Server-side fetches contract + linked unit + tenant in parallel so the
 * detail page can render the resolved names (not raw UUIDs). All three
 * fail soft → page rendering continues with placeholder text.
 *
 * The Client Component owns the state machine (status flip, notes edit)
 * and posts back via `updateContractAction`.
 */
export default async function ContractDetailPage({ params }: ContractDetailPageProps) {
  const { companySlug, id } = await params;

  const token = await getAccessTokenFromCookie();
  if (!token) {
    redirect(`/login?next=/c/${companySlug}/contracts/${id}`);
  }

  let contract: ContractWire;
  try {
    contract = await api.get(`/c/${companySlug}/contracts/${id}`, contractWireSchema, { token });
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.statusCode === 401 || err.code === 'UnauthorizedException') {
        redirect(`/login?next=/c/${companySlug}/contracts/${id}`);
      }
      if (err.statusCode === 404 || err.code === 'NotFoundException') {
        notFound();
      }
    }
    console.error('[contracts/detail] failed to load:', err);
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

  // Best-effort fetch of unit + tenant — failures degrade to "ไม่ทราบ"
  // labels rather than blocking the contract render.
  const [unit, tenant] = await Promise.all([
    api
      .get(`/c/${companySlug}/units/${contract.unitId}`, unitWireSchema, { token })
      .catch(() => null),
    api
      .get(`/c/${companySlug}/tenants/${contract.tenantId}`, tenantWireSchema, { token })
      .catch(() => null),
  ]);

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link href={`/c/${companySlug}/contracts`}>
          <ChevronLeft className="mr-1 h-4 w-4" />
          กลับไปรายการสัญญา
        </Link>
      </Button>

      <ContractDetail
        companySlug={companySlug}
        contract={contract}
        unitNumber={unit?.unitNumber ?? null}
        tenantDisplayName={tenant?.displayName ?? null}
      />
    </div>
  );
}
