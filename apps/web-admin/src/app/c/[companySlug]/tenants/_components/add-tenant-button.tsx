'use client';

import { Button } from '@/components/ui/button';
import { Can } from '@/lib/rbac';
import { Plus } from 'lucide-react';
import Link from 'next/link';

/**
 * "Add Tenant" button — gated by `create:tenant_user` permission via the
 * declarative `<Can>` component. Owner / property_manager / staff have
 * the permission per the shared matrix; staff are the day-to-day
 * onboarding hands so they need write access here.
 *
 * Client Component because <Can> uses RbacContext (Client-only).
 */
export function AddTenantButton({ companySlug }: { companySlug: string }) {
  return (
    <Can action="create" resource="tenant_user">
      <Button asChild size="sm">
        <Link href={`/c/${companySlug}/tenants/new`}>
          <Plus className="mr-1 h-4 w-4" />
          เพิ่มผู้เช่า
        </Link>
      </Button>
    </Can>
  );
}
