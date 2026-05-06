import type { EntitlementsWire } from '@dorm/shared/billing';
import { AlertTriangle, Clock } from 'lucide-react';

/**
 * Trial-state banner (Task #121 / SAAS-002).
 *
 * Three render states:
 *   1. `inTrial && trialDaysRemaining ≤ 7` → amber "ทดลองใช้เหลือ X วัน"
 *   2. `trialExpired === true`             → red    "ทดลองใช้หมดแล้ว"
 *   3. otherwise                            → null   (no banner)
 *
 * v1 is warn-only — banner shows but writes are NOT blocked (SAAS-001
 * trade-off chosen at planning time). The "อัปเกรด" CTA links nowhere
 * yet; Phase 1 (SAAS-004 Stripe wire-up) replaces it with a real flow.
 *
 * Server Component — entitlements come from the /me payload that the
 * layout already fetched. Re-renders only when the layout re-renders
 * (i.e. on navigation), which keeps the banner in step with whatever
 * the SPA last knew about plan/trial state.
 */
export function TrialBanner({ entitlements }: { entitlements: EntitlementsWire }) {
  if (entitlements.trialExpired) {
    return (
      <div
        role="alert"
        className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
      >
        <AlertTriangle className="h-4 w-4 shrink-0" />
        <span className="flex-1">
          ทดลองใช้หมดแล้ว — ฟีเจอร์ทั้งหมดยังใช้งานได้ในช่วงเบต้า แต่กรุณาอัปเกรดเพื่อใช้งานต่อในระยะถัดไป
        </span>
        <UpgradeButton />
      </div>
    );
  }

  if (
    entitlements.inTrial &&
    entitlements.trialDaysRemaining !== null &&
    entitlements.trialDaysRemaining <= 7
  ) {
    return (
      <output className="flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
        <Clock className="h-4 w-4 shrink-0" />
        <span className="flex-1">
          ทดลองใช้เหลืออีก <strong>{entitlements.trialDaysRemaining}</strong> วัน —
          อัปเกรดก่อนหมดเพื่อใช้งานต่อเนื่อง
        </span>
        <UpgradeButton />
      </output>
    );
  }

  return null;
}

/**
 * Upgrade CTA — placeholder until SAAS-004 ships Stripe checkout. The
 * `<a>` deliberately has no href so screen readers read it as inert; we
 * swap to a real Link once the upgrade route exists.
 */
function UpgradeButton() {
  return (
    <span
      aria-disabled="true"
      className="shrink-0 cursor-not-allowed rounded-md border border-current/30 bg-background/40 px-2 py-0.5 text-[11px] font-medium opacity-80"
      title="เร็วๆ นี้: ระบบอัปเกรดอัตโนมัติ"
    >
      อัปเกรด (เร็วๆ นี้)
    </span>
  );
}
