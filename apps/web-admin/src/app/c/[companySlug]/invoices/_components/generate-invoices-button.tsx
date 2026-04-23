'use client';

import { Button } from '@/components/ui/button';
import { Can } from '@/lib/rbac';
import { Sparkles } from 'lucide-react';
import Link from 'next/link';

/**
 * "Generate invoices for period" CTA — gated by `create:invoice`.
 *
 * Owner + property_manager have the permission per the shared matrix; staff
 * does not. The wizard (Task #69) lives at /invoices/generate; for now this
 * button just links there — the page may not exist yet during incremental
 * delivery, in which case Next 14+ surfaces a friendly 404.
 */
export function GenerateInvoicesButton({ companySlug }: { companySlug: string }) {
  return (
    <Can action="create" resource="invoice">
      <Button asChild size="sm">
        <Link href={`/c/${companySlug}/invoices/generate`}>
          <Sparkles className="mr-1 h-4 w-4" />
          สร้างใบแจ้งหนี้
        </Link>
      </Button>
    </Can>
  );
}
