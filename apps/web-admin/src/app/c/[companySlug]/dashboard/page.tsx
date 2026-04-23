import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'แดชบอร์ด',
};

/**
 * Dashboard placeholder. Real KPIs (occupancy, MRR, overdue invoices, slip
 * review queue) come once the corresponding admin CRUD tasks land.
 *
 * For now the page exists so we can:
 *   1. Verify the route renders end-to-end through the layout,
 *   2. Provide a target for the post-login redirect (Task #58),
 *   3. Show breadcrumb in the shell skeleton (Task #59).
 */
export default async function DashboardPage({
  params,
}: {
  params: Promise<{ companySlug: string }>;
}) {
  const { companySlug } = await params;
  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">บริษัท</CardTitle>
          <CardDescription>company slug ปัจจุบัน</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="font-mono text-sm">{companySlug}</p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">สถานะ</CardTitle>
          <CardDescription>การ scaffold สำเร็จ</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            หน้านี้เป็น placeholder — KPIs จริงจะมาเมื่อ admin CRUD พร้อม
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">ขั้นต่อไป</CardTitle>
          <CardDescription>roadmap ที่กำลังรอ</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="list-disc space-y-1 pl-4 text-sm text-muted-foreground">
            <li>Task #58 — login + JWT + middleware</li>
            <li>Task #59 — sidebar + topbar shell</li>
            <li>Task #60 — TanStack Query + API client</li>
            <li>Task #61 — RBAC hook</li>
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
