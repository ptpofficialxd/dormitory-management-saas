'use client';

import { Button } from '@/components/ui/button';
import { Can } from '@/lib/rbac';
import { Plus } from 'lucide-react';
import Link from 'next/link';

/**
 * "Add Unit" button — gated by `create:unit` permission via `<Can>`.
 *
 * `disabled` is set by the page when the company has zero properties yet
 * (creating a unit requires picking a propertyId — without any properties,
 * the form is meaningless). Title attr surfaces the reason on hover.
 */
export function AddUnitButton({
  companySlug,
  disabled = false,
}: {
  companySlug: string;
  disabled?: boolean;
}) {
  return (
    <Can action="create" resource="unit">
      {disabled ? (
        <Button size="sm" disabled title="ต้องสร้างอาคารก่อน">
          <Plus className="mr-1 h-4 w-4" />
          เพิ่มห้อง
        </Button>
      ) : (
        <Button asChild size="sm">
          <Link href={`/c/${companySlug}/units/new`}>
            <Plus className="mr-1 h-4 w-4" />
            เพิ่มห้อง
          </Link>
        </Button>
      )}
    </Can>
  );
}
