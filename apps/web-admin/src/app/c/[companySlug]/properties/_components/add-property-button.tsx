'use client';

import { Button } from '@/components/ui/button';
import { Can } from '@/lib/rbac';
import { Plus } from 'lucide-react';
import Link from 'next/link';

/**
 * "Add Property" button — gated by `create:property` permission via the
 * declarative `<Can>` component. Owner + property_manager have the
 * permission per the shared matrix; staff doesn't (won't see this button).
 *
 * Client Component because <Can> uses the RbacContext (Client-only).
 * The button itself is just a styled <Link> — no client state, no event
 * handlers — but the surrounding gate forces 'use client'.
 */
export function AddPropertyButton({ companySlug }: { companySlug: string }) {
  return (
    <Can action="create" resource="property">
      <Button asChild size="sm">
        <Link href={`/c/${companySlug}/properties/new`}>
          <Plus className="mr-1 h-4 w-4" />
          เพิ่มอาคาร
        </Link>
      </Button>
    </Can>
  );
}
