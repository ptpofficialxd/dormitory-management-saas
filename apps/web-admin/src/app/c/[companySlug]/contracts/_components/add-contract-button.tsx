'use client';

import { Button } from '@/components/ui/button';
import { Can } from '@/lib/rbac';
import { Plus } from 'lucide-react';
import Link from 'next/link';

/**
 * "Add Contract" button — gated by `create:contract` permission via `<Can>`.
 *
 * Per the shared RBAC matrix: owner + property_manager only (staff doesn't
 * sign contracts — legal commitment). The API enforces the same via
 * @Perm('create','contract'); the gate here is purely UX.
 */
export function AddContractButton({ companySlug }: { companySlug: string }) {
  return (
    <Can action="create" resource="contract">
      <Button asChild size="sm">
        <Link href={`/c/${companySlug}/contracts/new`}>
          <Plus className="mr-1 h-4 w-4" />
          เพิ่มสัญญา
        </Link>
      </Button>
    </Can>
  );
}
