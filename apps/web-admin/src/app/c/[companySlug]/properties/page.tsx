import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError, api } from '@/lib/api';
import { getAccessTokenFromCookie } from '@/lib/cookies';
import { propertyPageSchema } from '@/queries/properties';
import { Plus } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AddPropertyButton } from './_components/add-property-button';
import { PropertiesTable } from './_components/properties-table';

export const metadata: Metadata = {
  title: 'อาคาร',
};

interface PropertiesPageProps {
  params: Promise<{ companySlug: string }>;
  searchParams: Promise<{ cursor?: string }>;
}

/**
 * /c/[companySlug]/properties — list view.
 *
 * Server Component does the initial fetch with the user's JWT (read from
 * the httpOnly cookie). Pagination is cursor-based — the API returns
 * `nextCursor` if there's a next page; we render a "next" link below.
 *
 * The "Add Property" button is gated by RBAC via the AddPropertyButton
 * Client Component (uses `<Can>` to render only when the role can create).
 * The API enforces the same matrix — the gate is purely UX.
 */
export default async function PropertiesPage({ params, searchParams }: PropertiesPageProps) {
  const { companySlug } = await params;
  const sp = await searchParams;

  const token = await getAccessTokenFromCookie();
  if (!token) {
    redirect(`/login?next=/c/${companySlug}/properties`);
  }

  const queryString = sp.cursor ? `?cursor=${encodeURIComponent(sp.cursor)}` : '';

  let page: Awaited<ReturnType<typeof api.get<typeof propertyPageSchema._type>>>;
  try {
    page = await api.get(`/c/${companySlug}/properties${queryString}`, propertyPageSchema, {
      token,
    });
  } catch (err) {
    if (
      err instanceof ApiError &&
      (err.statusCode === 401 || err.code === 'UnauthorizedException')
    ) {
      redirect(`/login?next=/c/${companySlug}/properties`);
    }
    // Surface other errors as a friendly empty state — better than crashing.
    console.error('[properties/list] failed to load:', err);
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
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">อาคาร / โครงการ</h1>
          <p className="text-sm text-muted-foreground">
            จัดการอาคารและโครงการของหอพัก ({page.items.length} {page.nextCursor ? '+ ' : ''}รายการ)
          </p>
        </div>
        <AddPropertyButton companySlug={companySlug} />
      </div>

      <PropertiesTable items={page.items} />

      {page.nextCursor ? (
        <div className="flex justify-end">
          <Button asChild variant="outline" size="sm">
            <Link
              href={`/c/${companySlug}/properties?cursor=${encodeURIComponent(page.nextCursor)}`}
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
