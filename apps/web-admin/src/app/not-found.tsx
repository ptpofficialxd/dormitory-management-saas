import Link from 'next/link';

/**
 * Custom 404 — overrides Next's auto-generated `_not-found` page.
 *
 * Two reasons we ship our own:
 *
 * 1. **Build stability:** the auto-generated default reaches into Next's
 *    Pages-router shim which (in Next 15.1 + React 18.3.1) hits a
 *    `Cannot read properties of null (reading 'useContext')` during static
 *    prerender. Defining ours overrides it and `dynamic = 'force-dynamic'`
 *    skips the offending prerender step.
 *
 * 2. **Localisation:** the default 404 ships English copy. We need Thai to
 *    match the rest of the admin surface (CLAUDE.md §3 #14).
 *
 * Markup is intentionally Radix-free — no Button, no Card. Plain Tailwind +
 * `next/link` keeps the dependency graph small enough that even the worker
 * with the broken React resolution can render it.
 */
export const dynamic = 'force-dynamic';

export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-3 px-4 text-center">
      <p className="text-5xl font-bold tracking-tight text-muted-foreground">404</p>
      <h1 className="text-lg font-semibold">ไม่พบหน้าที่คุณค้นหา</h1>
      <p className="max-w-sm text-sm text-muted-foreground">
        URL อาจพิมพ์ผิด หรือลิงก์ที่คุณตามมาอาจหมดอายุแล้ว
      </p>
      <Link href="/login" className="mt-2 text-sm text-primary underline-offset-4 hover:underline">
        กลับหน้าเข้าสู่ระบบ
      </Link>
    </main>
  );
}
