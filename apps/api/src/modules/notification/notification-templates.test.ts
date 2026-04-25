import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for notification-templates.ts.
 *
 * Pure functions — no mocks needed except the `env` module (LIFF_BIND_URL).
 * We override env BEFORE importing templates so the buildInvoiceLiffUrl
 * helper picks up the test value at module load time.
 */

vi.mock('../../config/env.js', () => ({
  env: {
    LIFF_BIND_URL: 'https://liff.line.me/1234567890-test',
  },
}));

const { renderInvoiceIssued, renderPaymentApproved, renderPaymentRejected, __testables } =
  await import('./notification-templates.js');

const COMPANY_ID = 'cccc-cccc-cccc-cccc';
const COMPANY_SLUG = 'easyslip';
const TENANT_ID = 'tttt-tttt-tttt-tttt';
const INVOICE_ID = 'iiii-iiii-iiii-iiii';
const PERIOD = '2026-04';

const BASE = {
  companyId: COMPANY_ID,
  companySlug: COMPANY_SLUG,
  tenantId: TENANT_ID,
  invoiceId: INVOICE_ID,
  period: PERIOD,
} as const;

describe('formatMoneyTh', () => {
  it('adds thousands separators to 4-digit amounts', () => {
    expect(__testables.formatMoneyTh('5500.00')).toBe('5,500.00');
  });

  it('preserves 2-decimal precision (no trailing-zero loss)', () => {
    expect(__testables.formatMoneyTh('1234.50')).toBe('1,234.50');
  });

  it('handles 7-digit amounts (Decimal(10,2) max integer ≈ 8 digits)', () => {
    expect(__testables.formatMoneyTh('1234567.89')).toBe('1,234,567.89');
  });

  it('pads single-decimal input to two decimals', () => {
    expect(__testables.formatMoneyTh('100.5')).toBe('100.50');
  });

  it('handles whole-dollar amounts (no decimal in input)', () => {
    expect(__testables.formatMoneyTh('100')).toBe('100.00');
  });
});

describe('formatDateTh', () => {
  it('renders an ISO date as Thai short form with Buddhist year', () => {
    // 2026 CE = 2569 BE; "เม.ย." for April. Spaces / abbreviation may
    // vary slightly across ICU versions — assert on the digits + month
    // marker we depend on.
    const out = __testables.formatDateTh('2026-04-30');
    expect(out).toMatch(/30/);
    expect(out).toMatch(/2569/);
    expect(out).toMatch(/เม\.ย\./);
  });

  it('handles end-of-year dates without DST shift', () => {
    const out = __testables.formatDateTh('2026-12-31');
    expect(out).toMatch(/31/);
    expect(out).toMatch(/2569/);
    expect(out).toMatch(/ธ\.ค\./);
  });
});

describe('buildInvoiceLiffUrl', () => {
  it('produces a native LIFF deep-link by appending the sub-path', () => {
    const url = __testables.buildInvoiceLiffUrl({
      companySlug: COMPANY_SLUG,
      invoiceId: INVOICE_ID,
    });
    // LINE forwards the sub-path to the endpoint URL verbatim — no ?path=
    // query trick needed (liff.state handles route restoration after OAuth).
    expect(url).toBe(
      `https://liff.line.me/1234567890-test/c/${COMPANY_SLUG}/invoices/${INVOICE_ID}`,
    );
  });

  it('does not produce double slashes between LIFF base and sub-path', () => {
    // Defensive: the implementation `.replace(/\/+$/, '')`s a trailing slash
    // on LIFF_BIND_URL so a misconfigured env doesn't yield `//c/...` URLs
    // (which break LINE's redirect handler). Output should never contain
    // `//` anywhere except in the `https://` protocol prefix.
    const url = __testables.buildInvoiceLiffUrl({
      companySlug: COMPANY_SLUG,
      invoiceId: INVOICE_ID,
    });
    const afterProtocol = url.replace(/^https?:\/\//, '');
    expect(afterProtocol).not.toContain('//');
  });
});

describe('renderInvoiceIssued', () => {
  it('includes the period, formatted amount, formatted date, and native LIFF deep-link', () => {
    const text = renderInvoiceIssued({
      kind: 'invoice_issued',
      ...BASE,
      totalAmount: '5500.00',
      dueDate: '2026-04-30',
    });

    expect(text).toContain('📄 ใบแจ้งหนี้รอบ 2026-04 ออกแล้ว');
    expect(text).toContain('5,500.00 บาท');
    expect(text).toContain('30');
    expect(text).toContain('2569');
    // Native LIFF deep-link — sub-path appended to the LIFF base URL.
    expect(text).toContain(
      `https://liff.line.me/1234567890-test/c/${COMPANY_SLUG}/invoices/${INVOICE_ID}`,
    );
  });
});

describe('renderPaymentApproved', () => {
  it('includes the period and a thank-you line, no LIFF link', () => {
    const text = renderPaymentApproved({
      kind: 'payment_approved',
      ...BASE,
    });

    expect(text).toContain('✅ ยืนยันการชำระบิลรอบ 2026-04');
    expect(text).toContain('ขอบคุณ');
    expect(text).not.toContain('https://liff.line.me');
  });
});

describe('renderPaymentRejected', () => {
  it('includes the period, the verbatim reason, and the native LIFF retry URL', () => {
    const text = renderPaymentRejected({
      kind: 'payment_rejected',
      ...BASE,
      reason: 'ยอดเงินในสลิปไม่ตรงกับใบแจ้งหนี้',
    });

    expect(text).toContain('❌ สลิปบิลรอบ 2026-04');
    expect(text).toContain('ยอดเงินในสลิปไม่ตรงกับใบแจ้งหนี้');
    expect(text).toContain(
      `https://liff.line.me/1234567890-test/c/${COMPANY_SLUG}/invoices/${INVOICE_ID}`,
    );
  });

  it('passes the reason through verbatim (no escape / sanitisation here)', () => {
    const text = renderPaymentRejected({
      kind: 'payment_rejected',
      ...BASE,
      reason: 'Test \n with newline',
    });
    // The renderer does not strip newlines — caller is responsible for
    // sanitising tenant-facing text.
    expect(text).toContain('Test \n with newline');
  });
});

beforeEach(() => {
  // No per-test setup yet; placeholder for future renderers that need it.
});
