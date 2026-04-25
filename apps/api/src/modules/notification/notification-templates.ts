import { env } from '../../config/env.js';
import type {
  LineNotificationInvoiceIssued,
  LineNotificationPaymentApproved,
  LineNotificationPaymentRejected,
} from './notification.types.js';

/**
 * Pure-function template renderers — one per notification kind.
 *
 * Why pure functions (not a templating engine):
 *   - 3 templates total, all short, all hard-coded Thai text
 *   - Easy to unit test (no IO, no DI, no env coupling beyond LIFF base URL)
 *   - i18n is out of scope for MVP (CLAUDE.md §5 — Thai default, no en yet)
 *
 * LINE text-message limits (enforced by their API, not by us here):
 *   - Single message: ≤5,000 chars (we're nowhere close)
 *   - URLs auto-link in the LINE chat — no markdown formatting
 *   - Newlines render as expected; do NOT use \r\n (LINE strips \r)
 *
 * Money formatting:
 *   - Stored as `Decimal(10,2)` string per ADR-0005 (e.g. `"5500.00"`)
 *   - Formatted with `Intl.NumberFormat('th-TH')` for thousands separator
 *   - We display the raw decimal string with thousands separators rather
 *     than parsing to Number — never want a JS-float precision loss in a
 *     message the tenant treats as authoritative
 *
 * Date formatting:
 *   - `dueDate` is `YYYY-MM-DD` (Postgres @db.Date)
 *   - Re-rendered as Thai locale long form (e.g. "30 เม.ย. 2569")
 *   - Period (`YYYY-MM`) is shown as-is — operators recognise it instantly
 */

/**
 * Build the LIFF deep-link to an invoice detail page.
 *
 * LIFF deep-link convention:
 *   `https://liff.line.me/{LIFF_ID}/c/{slug}/invoices/{id}`
 *
 * LINE forwards the sub-path verbatim to the configured Endpoint URL, so
 * `liff.line.me/{LIFF_ID}/c/easyslip/invoices/abc` lands on
 * `<endpoint>/c/easyslip/invoices/abc`. The LIFF SDK then encodes the
 * sub-URL into `?liff.state=` during the OAuth round-trip and restores it
 * via `history.replaceState` after `liff.init()` resolves — see
 * `apps/liff-tenant/src/main.tsx` JSDoc for the routing contract.
 *
 * `LIFF_BIND_URL` is the LIFF base URL (`https://liff.line.me/{LIFF_ID}`)
 * — name kept for back-compat with `buildLiffBindUrl` in
 * line-event-handler. We trim a trailing slash defensively so the joined
 * path doesn't end up with `//c/...`.
 */
function buildInvoiceLiffUrl(args: { companySlug: string; invoiceId: string }): string {
  const base = env.LIFF_BIND_URL.replace(/\/+$/, '');
  return `${base}/c/${args.companySlug}/invoices/${args.invoiceId}`;
}

/**
 * Format a money string for human display.
 *   "5500.00" → "5,500.00"
 *
 * Splits on the decimal separator + adds thousands separators to the integer
 * part with `Intl.NumberFormat`. Avoids `Number(s)` because that can clip
 * trailing zeros ("1234.50" → "1234.5") and lose precision past 2^53.
 */
function formatMoneyTh(money: string): string {
  // String.prototype.split always returns at least one element — but
  // tsconfig has `noUncheckedIndexedAccess: true`, which types array
  // accesses as `T | undefined`. Hard-fallback to '0' / '00' so BigInt
  // never receives undefined (also handles weird input like the empty
  // string defensively — formatter spits out "0.00" instead of throwing).
  const parts = money.split('.');
  const whole = parts[0] ?? '0';
  const frac = parts[1] ?? '00';
  // BigInt is overkill for Decimal(10,2) but cheap insurance — keeps the
  // formatter from rounding 8-digit integers (max under our schema is 8
  // integer digits before the decimal).
  const wholeWithSep = new Intl.NumberFormat('en-US').format(BigInt(whole));
  return `${wholeWithSep}.${frac.padEnd(2, '0').slice(0, 2)}`;
}

/**
 * Format an ISO date `YYYY-MM-DD` as Thai short form `D MMM YYYY` (Buddhist year).
 *
 * Example: `"2026-04-30"` → `"30 เม.ย. 2569"`
 *
 * We construct a UTC Date so the string round-trips without DST surprises.
 * Bangkok's offset (UTC+7) is well past midnight UTC for the same calendar
 * day, so `new Date('2026-04-30')` is `2026-04-30T00:00:00Z` — no shift.
 */
function formatDateTh(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  return new Intl.DateTimeFormat('th-TH-u-ca-buddhist', {
    timeZone: 'Asia/Bangkok',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(d);
}

// ---------------------------------------------------------------------------
// Template: INVOICE_ISSUED
// ---------------------------------------------------------------------------

export function renderInvoiceIssued(args: LineNotificationInvoiceIssued): string {
  const url = buildInvoiceLiffUrl(args);
  const amount = formatMoneyTh(args.totalAmount);
  const due = formatDateTh(args.dueDate);
  return [
    `📄 ใบแจ้งหนี้รอบ ${args.period} ออกแล้ว`,
    `ยอดรวม ${amount} บาท`,
    `ครบกำหนด ${due}`,
    '',
    'ดูบิล + ชำระเงิน:',
    url,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Template: PAYMENT_APPROVED
// ---------------------------------------------------------------------------

export function renderPaymentApproved(args: LineNotificationPaymentApproved): string {
  return [`✅ ยืนยันการชำระบิลรอบ ${args.period} เรียบร้อยแล้วครับ`, 'ขอบคุณที่ใช้บริการ 🙏'].join('\n');
}

// ---------------------------------------------------------------------------
// Template: PAYMENT_REJECTED
// ---------------------------------------------------------------------------

export function renderPaymentRejected(args: LineNotificationPaymentRejected): string {
  const url = buildInvoiceLiffUrl(args);
  return [
    `❌ สลิปบิลรอบ ${args.period} ไม่ผ่านการตรวจสอบ`,
    `เหตุผล: ${args.reason}`,
    '',
    'กรุณาส่งสลิปใหม่:',
    url,
  ].join('\n');
}

// Re-export helpers for unit testing — kept un-exported in the public surface
// otherwise (only the renderers should be called from the processor).
export const __testables = {
  buildInvoiceLiffUrl,
  formatMoneyTh,
  formatDateTh,
};
