'use client';

import { useRole } from '@/lib/rbac';
import { cn } from '@/lib/utils';
import type { Action, Resource } from '@dorm/shared/rbac';
import {
  Building2,
  ChevronRight,
  DoorOpen,
  FileText,
  Gauge,
  LayoutDashboard,
  Megaphone,
  Menu,
  Receipt,
  Settings,
  Users,
  Wallet,
  Wrench,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { type ComponentType, type ReactNode, useState } from 'react';

/**
 * AdminShell — top-level chrome for every page under /c/[companySlug]/*.
 *
 * Layout: fixed sidebar (left) + topbar (top, with breadcrumb + user menu) +
 * scrollable main content. Mobile (≤md): sidebar collapses behind a backdrop
 * drawer toggled by the hamburger button.
 *
 * Server/Client split:
 * - This component is `'use client'` because it uses `useState` (mobile
 *   drawer), `usePathname` (active nav highlight + breadcrumb), and
 *   `useRole` (filters the nav items by the current user's permissions —
 *   table-driven via @dorm/shared/rbac).
 * - The Server `layout.tsx` wraps this component, runs the auth claims
 *   check, hands `<RbacProvider>` to feed the role context, and passes
 *   `<LogoutButton />` (Server Component) as the `logoutSlot` prop.
 *
 * Nav structure: items can be leaves (single link) OR groups (header +
 * indented children). The discriminated union keeps the render logic
 * exhaustive — TS narrows on `kind`. Groups whose children all fail the
 * RBAC filter are dropped entirely (no orphan headers).
 */

interface NavLeaf {
  kind: 'leaf';
  label: string;
  href: string;
  icon: ComponentType<{ className?: string }>;
  /** false → render disabled with "เร็วๆ นี้" badge — page not yet built. */
  ready: boolean;
  /**
   * Permission required to even SEE this item in the sidebar. `undefined` =
   * no gate (everyone in any role sees it — used for Dashboard). The check
   * is filtering only — don't rely on it as a security boundary; the API
   * enforces the same matrix on every endpoint.
   */
  requires?: { action: Action; resource: Resource };
}

interface NavGroup {
  kind: 'group';
  label: string;
  /** Children are filtered individually; the group is dropped if all hide. */
  items: NavLeaf[];
}

type NavItem = NavLeaf | NavGroup;

function buildNavItems(slug: string): NavItem[] {
  const base = `/c/${slug}`;
  return [
    {
      kind: 'leaf',
      label: 'แดชบอร์ด',
      href: `${base}/dashboard`,
      icon: LayoutDashboard,
      ready: true,
      // No requires — every authenticated admin role lands here.
    },
    {
      kind: 'leaf',
      label: 'อาคาร',
      href: `${base}/properties`,
      icon: Building2,
      ready: true,
      requires: { action: 'read', resource: 'property' },
    },
    {
      kind: 'leaf',
      label: 'ห้อง',
      href: `${base}/units`,
      icon: DoorOpen,
      ready: true,
      requires: { action: 'read', resource: 'unit' },
    },
    {
      kind: 'leaf',
      label: 'ผู้เช่า',
      href: `${base}/tenants`,
      icon: Users,
      ready: true,
      requires: { action: 'read', resource: 'tenant_user' },
    },
    {
      kind: 'leaf',
      label: 'สัญญา',
      href: `${base}/contracts`,
      icon: FileText,
      ready: true,
      requires: { action: 'read', resource: 'contract' },
    },
    {
      // Billing group — invoices + payments live together because the
      // operator's daily flow goes invoice -> slip -> payment confirm.
      // Readings is upstream of invoice generation (must be entered before
      // batch-generate emits water/electric line items), so it sits at the
      // top of the group as the first step in the monthly cycle.
      kind: 'group',
      label: 'การเงิน',
      items: [
        {
          kind: 'leaf',
          label: 'ค่ามิเตอร์',
          href: `${base}/readings`,
          icon: Gauge,
          ready: true,
          requires: { action: 'read', resource: 'meter_reading' },
        },
        {
          kind: 'leaf',
          label: 'ใบแจ้งหนี้',
          href: `${base}/invoices`,
          icon: Receipt,
          ready: true,
          requires: { action: 'read', resource: 'invoice' },
        },
        {
          kind: 'leaf',
          label: 'การชำระเงิน',
          href: `${base}/payments`,
          icon: Wallet,
          ready: true,
          requires: { action: 'read', resource: 'payment' },
        },
      ],
    },
    {
      kind: 'leaf',
      label: 'แจ้งซ่อม',
      href: `${base}/maintenance`,
      icon: Wrench,
      ready: false,
      requires: { action: 'read', resource: 'maintenance_ticket' },
    },
    {
      kind: 'leaf',
      label: 'ประกาศ',
      href: `${base}/announcements`,
      icon: Megaphone,
      ready: false,
      requires: { action: 'read', resource: 'announcement' },
    },
    {
      kind: 'leaf',
      label: 'ตั้งค่า',
      href: `${base}/settings`,
      icon: Settings,
      ready: true,
      // company:update is owner-only in the shared matrix — staff +
      // property_manager won't see this entry at all.
      requires: { action: 'update', resource: 'company' },
    },
  ];
}

/** Thai labels for breadcrumb segments. Falls back to the raw slug if unknown. */
const BREADCRUMB_LABELS: Record<string, string> = {
  dashboard: 'แดชบอร์ด',
  properties: 'อาคาร',
  units: 'ห้อง',
  tenants: 'ผู้เช่า',
  contracts: 'สัญญา',
  readings: 'ค่ามิเตอร์',
  invoices: 'ใบแจ้งหนี้',
  generate: 'สร้างรอบบิล',
  payments: 'การชำระเงิน',
  maintenance: 'แจ้งซ่อม',
  announcements: 'ประกาศ',
  settings: 'ตั้งค่า',
};

export interface AdminShellProps {
  companySlug: string;
  email: string;
  /**
   * `<LogoutButton />` rendered in the Server layout and passed in. Accepted
   * as ReactNode (not the component itself) so AdminShell stays a pure
   * Client Component — Server Components can't be imported, only handed in.
   */
  logoutSlot: ReactNode;
  children: ReactNode;
}

export function AdminShell({ companySlug, email, logoutSlot, children }: AdminShellProps) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const { can } = useRole();

  // Filter the nav tree by permission. Groups whose children all hide are
  // dropped entirely — no orphan section headers.
  const navItems = filterByPermissions(buildNavItems(companySlug), can);

  // Derive breadcrumb segments from the path after /c/[slug]/.
  const slugPrefix = `/c/${companySlug}`;
  const segments = pathname?.startsWith(slugPrefix)
    ? pathname.slice(slugPrefix.length).split('/').filter(Boolean)
    : [];

  return (
    <div className="flex min-h-screen bg-muted/20">
      {/* Mobile backdrop — click to dismiss the drawer. */}
      {mobileOpen ? (
        <button
          type="button"
          aria-label="ปิดเมนู"
          onClick={() => setMobileOpen(false)}
          className="fixed inset-0 z-40 bg-black/40 md:hidden"
        />
      ) : null}

      {/* Sidebar.
          - Desktop (md+): static, always visible.
          - Mobile: fixed-position drawer; transform translates off-screen
            when closed. CSS-only transition; no JS animation lib needed. */}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex w-60 flex-col border-r bg-background transition-transform md:static md:translate-x-0',
          mobileOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex h-14 items-center justify-between border-b px-4">
          <Link href={`${slugPrefix}/dashboard`} className="text-sm font-semibold tracking-tight">
            Dorm Admin
          </Link>
          <button
            type="button"
            onClick={() => setMobileOpen(false)}
            aria-label="ปิดเมนู"
            className="rounded-md p-1 hover:bg-accent md:hidden"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto p-2" aria-label="หลัก">
          <ul className="space-y-0.5">
            {navItems.map((item, idx) =>
              item.kind === 'group' ? (
                <NavGroupBlock
                  key={`group-${item.label}-${idx}`}
                  group={item}
                  pathname={pathname ?? ''}
                  onNavigate={() => setMobileOpen(false)}
                />
              ) : (
                <li key={item.href}>
                  <NavRow
                    item={item}
                    active={pathname === item.href}
                    onNavigate={() => setMobileOpen(false)}
                  />
                </li>
              ),
            )}
          </ul>
        </nav>

        <div className="border-t px-4 py-3 text-[11px] text-muted-foreground">
          <p className="font-medium">Dorm SaaS · MVP</p>
          <p className="mt-0.5">v0.0.1</p>
        </div>
      </aside>

      {/* Main column — topbar + scrollable page content. */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-2 border-b bg-background/95 px-4 backdrop-blur">
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              onClick={() => setMobileOpen(true)}
              aria-label="เปิดเมนู"
              className="rounded-md p-1 hover:bg-accent md:hidden"
            >
              <Menu className="h-5 w-5" />
            </button>
            <Breadcrumb companySlug={companySlug} segments={segments} />
          </div>
          <div className="flex items-center gap-2">
            <span
              className="hidden max-w-[160px] truncate text-xs text-muted-foreground sm:inline"
              title={email}
            >
              {email}
            </span>
            {logoutSlot}
          </div>
        </header>

        <main className="flex-1 overflow-y-auto p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}

// -------------------------------------------------------------------------
// Filtering
// -------------------------------------------------------------------------

/**
 * Recursively filter the nav tree by RBAC. A leaf without `requires`
 * always passes; a leaf with `requires` passes when `can()` returns true.
 * A group is kept only when ≥1 child survives (no orphan headers).
 */
function filterByPermissions(
  items: NavItem[],
  can: (action: Action, resource: Resource) => boolean,
): NavItem[] {
  const out: NavItem[] = [];
  for (const item of items) {
    if (item.kind === 'leaf') {
      if (!item.requires || can(item.requires.action, item.requires.resource)) {
        out.push(item);
      }
    } else {
      const survivors = item.items.filter(
        (child) => !child.requires || can(child.requires.action, child.requires.resource),
      );
      if (survivors.length > 0) {
        out.push({ ...item, items: survivors });
      }
    }
  }
  return out;
}

// -------------------------------------------------------------------------
// Subcomponents
// -------------------------------------------------------------------------

function NavGroupBlock({
  group,
  pathname,
  onNavigate,
}: {
  group: NavGroup;
  pathname: string;
  onNavigate: () => void;
}) {
  return (
    <li className="pt-3 first:pt-0">
      <div
        className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70"
        // Treat the header as a non-interactive label (sub-items still focusable).
        aria-hidden="true"
      >
        {group.label}
      </div>
      <ul className="space-y-0.5">
        {group.items.map((child) => (
          <li key={child.href}>
            <NavRow
              item={child}
              active={pathname === child.href}
              onNavigate={onNavigate}
              indented
            />
          </li>
        ))}
      </ul>
    </li>
  );
}

function NavRow({
  item,
  active,
  onNavigate,
  indented = false,
}: {
  item: NavLeaf;
  active: boolean;
  onNavigate: () => void;
  /** When true, render with extra left-padding so children of a NavGroup nest visually. */
  indented?: boolean;
}) {
  const Icon = item.icon;
  const baseClass = cn(
    'flex items-center gap-3 rounded-md py-2 text-sm transition-colors',
    indented ? 'pl-6 pr-3' : 'px-3',
  );

  // Disabled / "Soon" — render a span (not a Link) so it's not navigable.
  if (!item.ready) {
    return (
      <span
        aria-disabled="true"
        className={cn(baseClass, 'cursor-not-allowed text-muted-foreground/60')}
      >
        <Icon className="h-4 w-4 shrink-0" />
        <span className="flex-1 truncate">{item.label}</span>
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          เร็วๆ นี้
        </span>
      </span>
    );
  }

  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      className={cn(
        baseClass,
        active
          ? 'bg-accent font-medium text-accent-foreground'
          : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
      )}
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span className="truncate">{item.label}</span>
    </Link>
  );
}

function Breadcrumb({ companySlug, segments }: { companySlug: string; segments: string[] }) {
  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1 text-sm">
      <span className="truncate font-semibold text-foreground">{companySlug}</span>
      {segments.map((seg, i) => (
        <span
          key={`${i}-${seg}`}
          className="flex shrink-0 items-center gap-1 text-muted-foreground"
        >
          <ChevronRight className="h-3 w-3" />
          <span className="truncate">{BREADCRUMB_LABELS[seg] ?? seg}</span>
        </span>
      ))}
    </nav>
  );
}
