import { describe, expect, it } from 'vitest';
import {
  announcementAudienceSchema,
  announcementStatusSchema,
  auditLogSchema,
  batchGenerateInvoicesInputSchema,
  companyStatusSchema,
  contractStatusSchema,
  createAnnouncementInputSchema,
  createCompanyInputSchema,
  createContractInputSchema,
  createInvoiceInputSchema,
  createMaintenanceRequestInputSchema,
  createMeterInputSchema,
  createPaymentInputSchema,
  createReadingInputSchema,
  createTenantInputSchema,
  createUnitInputSchema,
  invoiceItemKindSchema,
  issueInvoiceInputSchema,
  lineWebhookPayloadSchema,
  listAuditLogsInputSchema,
  listContractsQuerySchema,
  listInvoicesQuerySchema,
  listMetersQuerySchema,
  listPaymentsQuerySchema,
  listPropertiesQuerySchema,
  listReadingsQuerySchema,
  listTenantsQuerySchema,
  listUnitsQuerySchema,
  loginAdminInputSchema,
  loginLiffInputSchema,
  maintenanceCategorySchema,
  maintenancePrioritySchema,
  maintenanceStatusSchema,
  meterKindSchema,
  meterValueSchema,
  moneySchema,
  periodSchema,
  promptPayIdSchema,
  promptPayNameSchema,
  rateSchema,
  rejectPaymentInputSchema,
  slipMimeTypeSchema,
  slugSchema,
  tenantStatusSchema,
  unitStatusSchema,
  updateMaintenanceRequestInputSchema,
  updatePromptPaySettingsInputSchema,
  uploadSlipInputSchema,
  uuidSchema,
  voidInvoiceInputSchema,
  writeAuditLogInputSchema,
} from './index.js';

const UUID_A = '550e8400-e29b-41d4-a716-446655440000';
const UUID_B = '550e8400-e29b-41d4-a716-446655440001';
const UUID_C = '550e8400-e29b-41d4-a716-446655440002';

// =========================================================================
// primitives
// =========================================================================

describe('primitives — uuid / slug / money / rate / meterValue / period', () => {
  it('uuidSchema accepts v4', () => {
    expect(uuidSchema.safeParse(UUID_A).success).toBe(true);
  });

  it('uuidSchema rejects non-UUID', () => {
    expect(uuidSchema.safeParse('not-a-uuid').success).toBe(false);
  });

  it('slugSchema rejects uppercase + reserved is NOT enforced here', () => {
    expect(slugSchema.safeParse('Acme').success).toBe(false);
    // Reserved slug check is runtime (slug.ts), not Zod.
    expect(slugSchema.safeParse('admin').success).toBe(true);
  });

  it.each([
    ['5500.00', true],
    ['0', true],
    ['-100.5', true],
    ['12345678.99', true], // 8 integer digits max for Decimal(10,2)
    ['123456789.00', false], // 9 integer digits — rejected
    ['5500.001', false], // 3dp — rejected
    ['abc', false],
    ['-0', false], // negative zero rejected
    ['-0.00', false],
  ])('moneySchema("%s") → %s', (input, expected) => {
    expect(moneySchema.safeParse(input).success).toBe(expected);
  });

  it.each([
    ['5.8124', true], // PEA progressive tariff
    ['0', true],
    ['123456.1234', true], // 6 int + 4 dp max for Decimal(10,4)
    ['1234567.1234', false], // 7 int digits — rejected
    ['5.81245', false], // 5 dp — rejected
    ['-0', false],
  ])('rateSchema("%s") → %s', (input, expected) => {
    expect(rateSchema.safeParse(input).success).toBe(expected);
  });

  it.each([
    ['1234567890.99', true], // 10 int + 2 dp max for Decimal(12,2)
    ['12345678901.00', false], // 11 int digits — rejected
    ['45', true],
    ['1234567890.123', false],
  ])('meterValueSchema("%s") → %s', (input, expected) => {
    expect(meterValueSchema.safeParse(input).success).toBe(expected);
  });

  it.each([
    ['2026-04', true],
    ['1999-12', true],
    ['2026-00', false],
    ['2026-13', false],
    ['2026-1', false],
    ['abc', false],
  ])('periodSchema("%s") → %s', (input, expected) => {
    expect(periodSchema.safeParse(input).success).toBe(expected);
  });
});

// =========================================================================
// enums — drift canaries (fail fast if Prisma enum diverges)
// =========================================================================

describe('enum drift — matches Prisma schema', () => {
  it('companyStatus = active|suspended|churned', () => {
    expect(companyStatusSchema.safeParse('churned').success).toBe(true);
    expect(companyStatusSchema.safeParse('closed').success).toBe(false);
  });

  it('unitStatus = vacant|occupied|maintenance|reserved', () => {
    expect(unitStatusSchema.safeParse('vacant').success).toBe(true);
    expect(unitStatusSchema.safeParse('available').success).toBe(false);
  });

  it('tenantStatus = active|moved_out|blocked', () => {
    expect(tenantStatusSchema.safeParse('moved_out').success).toBe(true);
    expect(tenantStatusSchema.safeParse('suspended').success).toBe(false);
  });

  it('contractStatus = draft|active|ended|terminated', () => {
    expect(contractStatusSchema.safeParse('terminated').success).toBe(true);
    expect(contractStatusSchema.safeParse('cancelled').success).toBe(false);
  });

  it('meterKind = water|electric', () => {
    expect(meterKindSchema.safeParse('water').success).toBe(true);
    expect(meterKindSchema.safeParse('gas').success).toBe(false);
  });

  it('invoiceItemKind includes deposit + late_fee', () => {
    expect(invoiceItemKindSchema.safeParse('deposit').success).toBe(true);
    expect(invoiceItemKindSchema.safeParse('late_fee').success).toBe(true);
    expect(invoiceItemKindSchema.safeParse('service').success).toBe(false);
  });
});

// =========================================================================
// Company / Unit — inputs
// =========================================================================

describe('createCompanyInputSchema', () => {
  it('accepts minimum valid input', () => {
    expect(
      createCompanyInputSchema.safeParse({
        slug: 'acme-dorm',
        name: 'ACME Dormitory',
      }).success,
    ).toBe(true);
  });

  it('rejects empty name', () => {
    expect(createCompanyInputSchema.safeParse({ slug: 'acme', name: '' }).success).toBe(false);
  });

  it('accepts 128-char name (VarChar(128) boundary)', () => {
    expect(
      createCompanyInputSchema.safeParse({ slug: 'acme', name: 'x'.repeat(128) }).success,
    ).toBe(true);
  });

  it('rejects 129-char name', () => {
    expect(
      createCompanyInputSchema.safeParse({ slug: 'acme', name: 'x'.repeat(129) }).success,
    ).toBe(false);
  });
});

// =========================================================================
// PromptPay — IDs, merchant name, settings input
// =========================================================================

describe('promptPayIdSchema', () => {
  it.each([
    ['0812345678', true], // 10-digit phone starting with 0
    ['1234567890123', true], // 13-digit national ID
    ['123456789012345', true], // 15-digit e-wallet
    ['1234567890', false], // 10 digits but doesn't start with 0
    ['081234567', false], // 9 digits
    ['08123456789', false], // 11 digits — neither phone nor ID
    ['12345678901234', false], // 14 digits
    ['1234567890123456', false], // 16 digits
    ['081-234-5678', false], // hyphens not allowed (canonical form only)
    ['0812 345 678', false], // spaces not allowed
    ['', false],
  ])('promptPayIdSchema("%s") → %s', (input, expected) => {
    expect(promptPayIdSchema.safeParse(input).success).toBe(expected);
  });
});

describe('promptPayNameSchema', () => {
  it('accepts ASCII trading name within 25 chars', () => {
    expect(promptPayNameSchema.safeParse('DORM ACME').success).toBe(true);
    expect(promptPayNameSchema.safeParse('A').success).toBe(true);
    expect(promptPayNameSchema.safeParse('x'.repeat(25)).success).toBe(true);
  });

  it('rejects empty string and >25 chars (EMVCo tag 59 limit)', () => {
    expect(promptPayNameSchema.safeParse('').success).toBe(false);
    expect(promptPayNameSchema.safeParse('x'.repeat(26)).success).toBe(false);
  });

  it('rejects non-printable / non-ASCII (Thai glyphs render as boxes)', () => {
    expect(promptPayNameSchema.safeParse('หอพัก ACME').success).toBe(false);
    expect(promptPayNameSchema.safeParse('DORM\nACME').success).toBe(false); // newline
    expect(promptPayNameSchema.safeParse('DORM\tACME').success).toBe(false); // tab
  });

  it('accepts symbols and digits commonly used in trading names', () => {
    expect(promptPayNameSchema.safeParse('DORM-ACME 2026').success).toBe(true);
    expect(promptPayNameSchema.safeParse('A&B Co., Ltd.').success).toBe(true);
  });
});

describe('updatePromptPaySettingsInputSchema', () => {
  it('requires both promptPayId AND promptPayName', () => {
    expect(
      updatePromptPaySettingsInputSchema.safeParse({
        promptPayId: '0812345678',
        promptPayName: 'DORM ACME',
      }).success,
    ).toBe(true);

    // Missing name — half-configured PromptPay is forbidden
    expect(
      updatePromptPaySettingsInputSchema.safeParse({ promptPayId: '0812345678' }).success,
    ).toBe(false);

    // Missing ID
    expect(
      updatePromptPaySettingsInputSchema.safeParse({ promptPayName: 'DORM ACME' }).success,
    ).toBe(false);
  });

  it('rejects invalid PromptPay ID even if name is valid', () => {
    expect(
      updatePromptPaySettingsInputSchema.safeParse({
        promptPayId: 'not-digits',
        promptPayName: 'DORM ACME',
      }).success,
    ).toBe(false);
  });
});

describe('createUnitInputSchema', () => {
  it('accepts valid unit with size', () => {
    const result = createUnitInputSchema.safeParse({
      propertyId: UUID_A,
      unitNumber: 'A-305',
      floor: 3,
      sizeSqm: '24.00',
      baseRent: '5500.00',
    });
    expect(result.success).toBe(true);
  });

  it('accepts unit without sizeSqm (nullable)', () => {
    const result = createUnitInputSchema.safeParse({
      propertyId: UUID_A,
      unitNumber: '101',
      baseRent: '5500.00',
    });
    expect(result.success).toBe(true);
  });

  it('accepts 32-char unitNumber (VarChar(32) boundary)', () => {
    expect(
      createUnitInputSchema.safeParse({
        propertyId: UUID_A,
        unitNumber: 'x'.repeat(32),
        baseRent: '5500.00',
      }).success,
    ).toBe(true);
  });

  it('rejects floor out of range', () => {
    expect(
      createUnitInputSchema.safeParse({
        propertyId: UUID_A,
        unitNumber: '101',
        floor: 9999,
        baseRent: '5500',
      }).success,
    ).toBe(false);
  });
});

// =========================================================================
// Tenant / Contract / Meter / Reading — new P0 schemas
// =========================================================================

describe('createTenantInputSchema', () => {
  it('accepts minimum LIFF input', () => {
    expect(
      createTenantInputSchema.safeParse({
        lineUserId: 'U1234567890abcdef1234567890abcdef',
        displayName: 'คุณไอซ์',
      }).success,
    ).toBe(true);
  });

  it('rejects bad Thai nationalId', () => {
    expect(
      createTenantInputSchema.safeParse({
        lineUserId: 'U1',
        displayName: 'x',
        nationalId: '12345', // too short
      }).success,
    ).toBe(false);
  });

  it('rejects bad Thai mobile phone', () => {
    expect(
      createTenantInputSchema.safeParse({
        lineUserId: 'U1',
        displayName: 'x',
        phone: '123456', // doesn't start with 0
      }).success,
    ).toBe(false);
  });
});

describe('createContractInputSchema', () => {
  it('accepts open-ended contract (no endDate)', () => {
    expect(
      createContractInputSchema.safeParse({
        unitId: UUID_A,
        tenantId: UUID_B,
        startDate: '2026-04-01',
        rentAmount: '5500.00',
        depositAmount: '11000.00',
      }).success,
    ).toBe(true);
  });

  it('accepts fixed-term contract with valid dates', () => {
    expect(
      createContractInputSchema.safeParse({
        unitId: UUID_A,
        tenantId: UUID_B,
        startDate: '2026-04-01',
        endDate: '2027-03-31',
        rentAmount: '5500.00',
        depositAmount: '11000.00',
      }).success,
    ).toBe(true);
  });

  it('rejects endDate ≤ startDate', () => {
    expect(
      createContractInputSchema.safeParse({
        unitId: UUID_A,
        tenantId: UUID_B,
        startDate: '2026-04-01',
        endDate: '2026-03-31',
        rentAmount: '5500.00',
        depositAmount: '11000.00',
      }).success,
    ).toBe(false);
  });

  it('rejects malformed startDate', () => {
    expect(
      createContractInputSchema.safeParse({
        unitId: UUID_A,
        tenantId: UUID_B,
        startDate: '2026-4-1', // no zero-padding
        rentAmount: '5500.00',
        depositAmount: '11000.00',
      }).success,
    ).toBe(false);
  });
});

describe('createMeterInputSchema', () => {
  it('accepts electric meter with PEA rate', () => {
    expect(
      createMeterInputSchema.safeParse({
        unitId: UUID_A,
        kind: 'electric',
        unitOfMeasure: 'kWh',
        ratePerUnit: '5.8124',
      }).success,
    ).toBe(true);
  });

  it('rejects 5-decimal rate', () => {
    expect(
      createMeterInputSchema.safeParse({
        unitId: UUID_A,
        kind: 'water',
        unitOfMeasure: 'm3',
        ratePerUnit: '18.00001',
      }).success,
    ).toBe(false);
  });
});

describe('createReadingInputSchema', () => {
  it('accepts valid reading', () => {
    expect(
      createReadingInputSchema.safeParse({
        meterId: UUID_A,
        period: '2026-04',
        valueCurrent: '1234.56',
      }).success,
    ).toBe(true);
  });

  it('rejects bad period', () => {
    expect(
      createReadingInputSchema.safeParse({
        meterId: UUID_A,
        period: '2026/04',
        valueCurrent: '100',
      }).success,
    ).toBe(false);
  });
});

// =========================================================================
// Invoice / Payment — updated schemas
// =========================================================================

describe('createInvoiceInputSchema', () => {
  it('accepts valid invoice with one item', () => {
    const result = createInvoiceInputSchema.safeParse({
      contractId: UUID_A,
      period: '2026-04',
      dueDate: '2026-04-15T00:00:00Z',
      items: [
        {
          kind: 'rent',
          description: 'Monthly rent — 101',
          quantity: '1',
          unitPrice: '5500.00',
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('accepts electric line item with 4-decimal rate + reading link', () => {
    const result = createInvoiceInputSchema.safeParse({
      contractId: UUID_A,
      period: '2026-04',
      dueDate: '2026-04-15T00:00:00Z',
      items: [
        {
          kind: 'electric',
          description: 'Electric 45 kWh',
          quantity: '45.00',
          unitPrice: '5.8124',
          readingId: UUID_B,
          sortOrder: 1,
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects zero items', () => {
    expect(
      createInvoiceInputSchema.safeParse({
        contractId: UUID_A,
        period: '2026-04',
        dueDate: '2026-04-15T00:00:00Z',
        items: [],
      }).success,
    ).toBe(false);
  });

  it('rejects invalid item kind', () => {
    expect(
      createInvoiceInputSchema.safeParse({
        contractId: UUID_A,
        period: '2026-04',
        dueDate: '2026-04-15T00:00:00Z',
        items: [{ kind: 'mystery', description: 'x', quantity: '1', unitPrice: '0' }],
      }).success,
    ).toBe(false);
  });
});

// =========================================================================
// Invoice batch generation + lifecycle
// =========================================================================

describe('batchGenerateInvoicesInputSchema', () => {
  it('accepts minimum input (period + dueDayOfMonth)', () => {
    expect(
      batchGenerateInvoicesInputSchema.safeParse({
        period: '2026-04',
        dueDayOfMonth: 5,
      }).success,
    ).toBe(true);
  });

  it('accepts optional propertyId + additionalItems', () => {
    expect(
      batchGenerateInvoicesInputSchema.safeParse({
        period: '2026-04',
        dueDayOfMonth: 10,
        propertyId: UUID_A,
        additionalItems: [
          { kind: 'common_fee', description: 'Common fee', quantity: '1', unitPrice: '300.00' },
        ],
      }).success,
    ).toBe(true);
  });

  it.each([
    [0, false], // Invalid — day 0 doesn't exist
    [1, true],
    [28, true], // Boundary — Feb-safe
    [29, false], // Feb-30 trap
    [31, false],
  ])('dueDayOfMonth %d → %s', (day, expected) => {
    expect(
      batchGenerateInvoicesInputSchema.safeParse({
        period: '2026-04',
        dueDayOfMonth: day,
      }).success,
    ).toBe(expected);
  });

  it('rejects additionalItem with water/electric/late_fee/rent (handled by service)', () => {
    for (const kind of ['water', 'electric', 'late_fee', 'rent']) {
      expect(
        batchGenerateInvoicesInputSchema.safeParse({
          period: '2026-04',
          dueDayOfMonth: 5,
          additionalItems: [{ kind, description: 'x', quantity: '1', unitPrice: '100.00' }],
        }).success,
      ).toBe(false);
    }
  });

  it('rejects >10 additionalItems (DoS guard)', () => {
    const items = Array.from({ length: 11 }, () => ({
      kind: 'other' as const,
      description: 'x',
      quantity: '1',
      unitPrice: '1.00',
    }));
    expect(
      batchGenerateInvoicesInputSchema.safeParse({
        period: '2026-04',
        dueDayOfMonth: 5,
        additionalItems: items,
      }).success,
    ).toBe(false);
  });

  it('rejects malformed period', () => {
    expect(
      batchGenerateInvoicesInputSchema.safeParse({
        period: '2026/04',
        dueDayOfMonth: 5,
      }).success,
    ).toBe(false);
  });
});

describe('issueInvoiceInputSchema', () => {
  it('accepts empty body', () => {
    expect(issueInvoiceInputSchema.safeParse({}).success).toBe(true);
  });

  it('rejects unknown extra fields (.strict() guard)', () => {
    expect(issueInvoiceInputSchema.safeParse({ status: 'paid' }).success).toBe(false);
  });
});

describe('voidInvoiceInputSchema', () => {
  it('requires reason ≥4 chars (avoid noise like "x")', () => {
    expect(voidInvoiceInputSchema.safeParse({ reason: 'x' }).success).toBe(false);
    expect(voidInvoiceInputSchema.safeParse({ reason: 'oops' }).success).toBe(true);
  });

  it('rejects reason >512 chars', () => {
    expect(voidInvoiceInputSchema.safeParse({ reason: 'x'.repeat(513) }).success).toBe(false);
  });

  it('rejects missing reason', () => {
    expect(voidInvoiceInputSchema.safeParse({}).success).toBe(false);
  });
});

describe('listInvoicesQuerySchema', () => {
  it('defaults limit to 20 when omitted', () => {
    const r = listInvoicesQuerySchema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.limit).toBe(20);
  });

  it('coerces string limit (query string is always string)', () => {
    const r = listInvoicesQuerySchema.safeParse({ limit: '50' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.limit).toBe(50);
  });

  it('rejects limit >100 (pagination DoS guard)', () => {
    expect(listInvoicesQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
  });

  it('accepts all filters together', () => {
    expect(
      listInvoicesQuerySchema.safeParse({
        status: 'issued',
        period: '2026-04',
        tenantId: UUID_A,
        cursor: 'opaque-cursor',
        limit: 20,
      }).success,
    ).toBe(true);
  });
});

describe('createPaymentInputSchema', () => {
  it('accepts promptpay payment (no slipId in body — slip is separate)', () => {
    expect(
      createPaymentInputSchema.safeParse({
        invoiceId: UUID_A,
        amount: '5500.00',
        method: 'promptpay',
      }).success,
    ).toBe(true);
  });

  it('rejects unknown method', () => {
    expect(
      createPaymentInputSchema.safeParse({
        invoiceId: UUID_A,
        amount: '5500.00',
        method: 'bitcoin',
      }).success,
    ).toBe(false);
  });
});

describe('rejectPaymentInputSchema', () => {
  it('requires non-empty rejectionReason', () => {
    expect(rejectPaymentInputSchema.safeParse({ rejectionReason: '' }).success).toBe(false);
    expect(rejectPaymentInputSchema.safeParse({ rejectionReason: 'Slip mismatch' }).success).toBe(
      true,
    );
  });
});

// =========================================================================
// Slip / Auth
// =========================================================================

describe('uploadSlipInputSchema', () => {
  const VALID_SHA = 'a'.repeat(64);

  it('accepts valid slip metadata', () => {
    expect(
      uploadSlipInputSchema.safeParse({
        mimeType: 'image/jpeg',
        sizeBytes: 500_000,
        sha256: VALID_SHA,
      }).success,
    ).toBe(true);
  });

  it('rejects unsupported MIME type', () => {
    expect(
      uploadSlipInputSchema.safeParse({
        mimeType: 'image/gif',
        sizeBytes: 500_000,
        sha256: VALID_SHA,
      }).success,
    ).toBe(false);
    expect(slipMimeTypeSchema.safeParse('image/gif').success).toBe(false);
  });

  it('rejects uppercase hex SHA-256', () => {
    expect(
      uploadSlipInputSchema.safeParse({
        mimeType: 'image/jpeg',
        sizeBytes: 500_000,
        sha256: 'A'.repeat(64),
      }).success,
    ).toBe(false);
  });

  it('rejects oversized slip (>10MB)', () => {
    expect(
      uploadSlipInputSchema.safeParse({
        mimeType: 'image/jpeg',
        sizeBytes: 11 * 1024 * 1024,
        sha256: VALID_SHA,
      }).success,
    ).toBe(false);
  });
});

describe('loginAdminInputSchema', () => {
  it('accepts valid admin login', () => {
    expect(
      loginAdminInputSchema.safeParse({
        companySlug: 'acme-dorm',
        email: 'ice@acme.co',
        password: 'correct-horse-battery',
      }).success,
    ).toBe(true);
  });

  it('rejects short password', () => {
    expect(
      loginAdminInputSchema.safeParse({
        companySlug: 'acme',
        email: 'a@b.co',
        password: 'short',
      }).success,
    ).toBe(false);
  });

  it('rejects invalid email', () => {
    expect(
      loginAdminInputSchema.safeParse({
        companySlug: 'acme',
        email: 'not-an-email',
        password: 'long-enough-pw',
      }).success,
    ).toBe(false);
  });
});

describe('loginLiffInputSchema', () => {
  it('accepts valid LIFF idToken', () => {
    expect(
      loginLiffInputSchema.safeParse({
        companySlug: 'acme-dorm',
        idToken: 'eyJhbGciOi.Imbedded.jwt.here',
      }).success,
    ).toBe(true);
  });

  it('rejects empty idToken', () => {
    expect(loginLiffInputSchema.safeParse({ companySlug: 'acme', idToken: '' }).success).toBe(
      false,
    );
  });
});

// =========================================================================
// P1 — audit-log / maintenance / announcement / webhook-line
// =========================================================================

describe('auditLogSchema', () => {
  const valid = {
    id: UUID_A,
    companyId: UUID_B,
    actorUserId: UUID_C,
    action: 'POST /c/acme/payments',
    resource: 'payment',
    resourceId: '550e8400-e29b-41d4-a716-446655440099',
    metadata: { invoiceId: UUID_A, amount: '5500.00' },
    ipAddress: '203.0.113.42',
    userAgent: 'Mozilla/5.0 …',
    createdAt: '2026-04-22T10:00:00Z',
  };

  it('accepts a fully-populated row', () => {
    expect(auditLogSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts null actorUserId (system-originated event)', () => {
    expect(auditLogSchema.safeParse({ ...valid, actorUserId: null }).success).toBe(true);
  });

  it('accepts IPv6 in ipAddress column', () => {
    expect(auditLogSchema.safeParse({ ...valid, ipAddress: '2001:db8::1' }).success).toBe(true);
  });

  it('rejects action longer than 64 chars (Prisma VarChar(64))', () => {
    expect(auditLogSchema.safeParse({ ...valid, action: 'x'.repeat(65) }).success).toBe(false);
  });
});

describe('writeAuditLogInputSchema', () => {
  it('accepts minimum action + resource', () => {
    expect(
      writeAuditLogInputSchema.safeParse({
        action: 'payment.confirm',
        resource: 'payment',
      }).success,
    ).toBe(true);
  });

  it('rejects empty action', () => {
    expect(writeAuditLogInputSchema.safeParse({ action: '', resource: 'payment' }).success).toBe(
      false,
    );
  });
});

describe('listAuditLogsInputSchema', () => {
  it('defaults limit to 20 when omitted', () => {
    const parsed = listAuditLogsInputSchema.parse({});
    expect(parsed.limit).toBe(20);
  });

  it('rejects limit above 100', () => {
    expect(listAuditLogsInputSchema.safeParse({ limit: 101 }).success).toBe(false);
  });
});

describe('maintenance — enum drift canaries', () => {
  it('status includes cancelled', () => {
    expect(maintenanceStatusSchema.safeParse('cancelled').success).toBe(true);
    expect(maintenanceStatusSchema.safeParse('deleted').success).toBe(false);
  });

  it('priority = low|normal|high|urgent', () => {
    expect(maintenancePrioritySchema.safeParse('urgent').success).toBe(true);
    expect(maintenancePrioritySchema.safeParse('critical').success).toBe(false);
  });

  it('category covers internet + other', () => {
    expect(maintenanceCategorySchema.safeParse('internet').success).toBe(true);
    expect(maintenanceCategorySchema.safeParse('other').success).toBe(true);
    expect(maintenanceCategorySchema.safeParse('mystery').success).toBe(false);
  });
});

describe('createMaintenanceRequestInputSchema', () => {
  it('accepts minimum tenant-facing payload (defaults priority=normal, photos=[])', () => {
    const parsed = createMaintenanceRequestInputSchema.parse({
      unitId: UUID_A,
      category: 'plumbing',
      title: 'ก๊อกน้ำรั่ว',
      description: 'น้ำหยดตลอดคืนในห้องน้ำ',
    });
    expect(parsed.priority).toBe('normal');
    expect(parsed.photoR2Keys).toEqual([]);
  });

  it('rejects > 10 photos (MAINTENANCE_PHOTO_MAX)', () => {
    expect(
      createMaintenanceRequestInputSchema.safeParse({
        unitId: UUID_A,
        category: 'aircon',
        title: 'แอร์ไม่เย็น',
        description: 'เสียงดัง',
        photoR2Keys: Array.from({ length: 11 }, (_, i) => `maint/${i}.jpg`),
      }).success,
    ).toBe(false);
  });
});

describe('updateMaintenanceRequestInputSchema', () => {
  it('rejects empty patch (all fields undefined)', () => {
    expect(updateMaintenanceRequestInputSchema.safeParse({}).success).toBe(false);
  });

  it('accepts assignedToUserId = null (explicit unassign)', () => {
    expect(updateMaintenanceRequestInputSchema.safeParse({ assignedToUserId: null }).success).toBe(
      true,
    );
  });
});

describe('announcement — enum drift canaries', () => {
  it('status includes sending + cancelled', () => {
    expect(announcementStatusSchema.safeParse('sending').success).toBe(true);
    expect(announcementStatusSchema.safeParse('cancelled').success).toBe(true);
    expect(announcementStatusSchema.safeParse('paused').success).toBe(false);
  });

  it('audience = all|property|floor|unit|tenant', () => {
    expect(announcementAudienceSchema.safeParse('floor').success).toBe(true);
    expect(announcementAudienceSchema.safeParse('everyone').success).toBe(false);
  });
});

describe('createAnnouncementInputSchema — discriminated audience', () => {
  it('accepts `all` target with no extra fields', () => {
    expect(
      createAnnouncementInputSchema.safeParse({
        title: 'ประกาศ: ตัดน้ำประปา',
        body: 'ตัดน้ำ 08:00–12:00 วันที่ 25/4',
        target: { audience: 'all' },
      }).success,
    ).toBe(true);
  });

  it('rejects `property` target without propertyId', () => {
    expect(
      createAnnouncementInputSchema.safeParse({
        title: 't',
        body: 'b',
        target: { audience: 'property' },
      }).success,
    ).toBe(false);
  });

  it('accepts `floor` target with propertyId + floor', () => {
    expect(
      createAnnouncementInputSchema.safeParse({
        title: 't',
        body: 'b',
        target: { audience: 'floor', propertyId: UUID_A, floor: 3 },
      }).success,
    ).toBe(true);
  });

  it('rejects `unit` target with empty unitIds', () => {
    expect(
      createAnnouncementInputSchema.safeParse({
        title: 't',
        body: 'b',
        target: { audience: 'unit', unitIds: [] },
      }).success,
    ).toBe(false);
  });

  it('rejects `tenant` target with >200 tenantIds', () => {
    const tooMany = Array.from({ length: 201 }, () => UUID_A);
    expect(
      createAnnouncementInputSchema.safeParse({
        title: 't',
        body: 'b',
        target: { audience: 'tenant', tenantIds: tooMany },
      }).success,
    ).toBe(false);
  });

  it('rejects body > 4000 chars (LINE headroom)', () => {
    expect(
      createAnnouncementInputSchema.safeParse({
        title: 't',
        body: 'x'.repeat(4001),
        target: { audience: 'all' },
      }).success,
    ).toBe(false);
  });
});

describe('lineWebhookPayloadSchema', () => {
  it('accepts a text-message event from a 1:1 user chat', () => {
    const payload = {
      destination: 'Ucccccccccccccccccccccccccccccccc',
      events: [
        {
          type: 'message',
          timestamp: 1_745_234_567_890,
          webhookEventId: 'evt_01ABCXYZ',
          deliveryContext: { isRedelivery: false },
          source: { type: 'user', userId: 'U1234567890abcdef1234567890abcdef' },
          replyToken: `rtok_${'x'.repeat(20)}`,
          message: { type: 'text', id: '000001', text: 'สวัสดีครับ' },
        },
      ],
    };
    expect(lineWebhookPayloadSchema.safeParse(payload).success).toBe(true);
  });

  it('accepts an empty events array (LINE console verify hit)', () => {
    expect(lineWebhookPayloadSchema.safeParse({ destination: 'Udest', events: [] }).success).toBe(
      true,
    );
  });

  it('passthrough: tolerates unknown event type (forward-compat)', () => {
    const payload = {
      destination: 'Udest',
      events: [
        {
          type: 'videoPlayComplete',
          timestamp: 1_745_234_567_890,
          source: { type: 'user', userId: 'U1' },
          futureField: { foo: 'bar' },
        },
      ],
    };
    expect(lineWebhookPayloadSchema.safeParse(payload).success).toBe(true);
  });

  it('rejects events batch > 100 items', () => {
    const fakeEvent = {
      type: 'message',
      timestamp: 1_745_234_567_890,
      source: { type: 'user', userId: 'U1' },
      replyToken: `rtok_${'x'.repeat(20)}`,
      message: { type: 'text', id: '1', text: 'hi' },
    };
    const payload = {
      destination: 'Udest',
      events: Array.from({ length: 101 }, () => fakeEvent),
    };
    expect(lineWebhookPayloadSchema.safeParse(payload).success).toBe(false);
  });

  it('rejects non-numeric timestamp', () => {
    const payload = {
      destination: 'Udest',
      events: [
        {
          type: 'follow',
          timestamp: 'not-a-number',
          source: { type: 'user', userId: 'U1' },
        },
      ],
    };
    expect(lineWebhookPayloadSchema.safeParse(payload).success).toBe(false);
  });
});

describe('listPropertiesQuerySchema', () => {
  it('coerces string limit (query strings are always strings)', () => {
    const parsed = listPropertiesQuerySchema.parse({ limit: '50' });
    expect(parsed.limit).toBe(50);
  });

  it('defaults limit to 20 when omitted', () => {
    const parsed = listPropertiesQuerySchema.parse({});
    expect(parsed.limit).toBe(20);
  });

  it('rejects limit > 100 (DoS guard)', () => {
    expect(listPropertiesQuerySchema.safeParse({ limit: 500 }).success).toBe(false);
  });

  it('rejects limit < 1', () => {
    expect(listPropertiesQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
  });

  it('accepts an opaque cursor string', () => {
    const parsed = listPropertiesQuerySchema.parse({ cursor: 'eyJhIjoxfQ==', limit: 10 });
    expect(parsed.cursor).toBe('eyJhIjoxfQ==');
  });

  it('rejects cursor longer than 512 chars', () => {
    expect(listPropertiesQuerySchema.safeParse({ cursor: 'x'.repeat(513) }).success).toBe(false);
  });
});

describe('listUnitsQuerySchema', () => {
  it('coerces string limit + applies default 20', () => {
    const parsed = listUnitsQuerySchema.parse({ limit: '50' });
    expect(parsed.limit).toBe(50);
    expect(listUnitsQuerySchema.parse({}).limit).toBe(20);
  });

  it('accepts optional propertyId + status filters', () => {
    const parsed = listUnitsQuerySchema.parse({
      propertyId: UUID_A,
      status: 'vacant',
      limit: '10',
    });
    expect(parsed.propertyId).toBe(UUID_A);
    expect(parsed.status).toBe('vacant');
  });

  it('rejects non-UUID propertyId (caller bug surface)', () => {
    expect(listUnitsQuerySchema.safeParse({ propertyId: 'not-a-uuid' }).success).toBe(false);
  });

  it('rejects unknown status enum values', () => {
    expect(listUnitsQuerySchema.safeParse({ status: 'demolished' }).success).toBe(false);
  });

  it('rejects limit > 100 (DoS guard)', () => {
    expect(listUnitsQuerySchema.safeParse({ limit: 200 }).success).toBe(false);
  });
});

describe('listContractsQuerySchema', () => {
  it('coerces string limit + applies default 20', () => {
    expect(listContractsQuerySchema.parse({ limit: '50' }).limit).toBe(50);
    expect(listContractsQuerySchema.parse({}).limit).toBe(20);
  });

  it('accepts optional unitId + tenantId + status filters', () => {
    const parsed = listContractsQuerySchema.parse({
      unitId: UUID_A,
      tenantId: UUID_B,
      status: 'active',
      limit: '10',
    });
    expect(parsed.unitId).toBe(UUID_A);
    expect(parsed.tenantId).toBe(UUID_B);
    expect(parsed.status).toBe('active');
  });

  it('rejects non-UUID unitId / tenantId', () => {
    expect(listContractsQuerySchema.safeParse({ unitId: 'not-uuid' }).success).toBe(false);
    expect(listContractsQuerySchema.safeParse({ tenantId: 'not-uuid' }).success).toBe(false);
  });

  it('rejects unknown status enum', () => {
    expect(listContractsQuerySchema.safeParse({ status: 'cancelled' }).success).toBe(false);
  });

  it('rejects limit > 100 (DoS guard)', () => {
    expect(listContractsQuerySchema.safeParse({ limit: 200 }).success).toBe(false);
  });
});

describe('listTenantsQuerySchema', () => {
  it('coerces string limit + applies default 20', () => {
    expect(listTenantsQuerySchema.parse({ limit: '50' }).limit).toBe(50);
    expect(listTenantsQuerySchema.parse({}).limit).toBe(20);
  });

  it('accepts optional status filter', () => {
    const parsed = listTenantsQuerySchema.parse({ status: 'moved_out', limit: '10' });
    expect(parsed.status).toBe('moved_out');
  });

  it('rejects unknown status enum values', () => {
    expect(listTenantsQuerySchema.safeParse({ status: 'pending' }).success).toBe(false);
  });

  it('rejects limit > 100 (DoS guard)', () => {
    expect(listTenantsQuerySchema.safeParse({ limit: 200 }).success).toBe(false);
  });

  it('accepts an opaque cursor string', () => {
    const parsed = listTenantsQuerySchema.parse({ cursor: 'eyJhIjoxfQ==', limit: 10 });
    expect(parsed.cursor).toBe('eyJhIjoxfQ==');
  });
});

describe('listMetersQuerySchema', () => {
  it('coerces string limit + applies default 20', () => {
    expect(listMetersQuerySchema.parse({ limit: '50' }).limit).toBe(50);
    expect(listMetersQuerySchema.parse({}).limit).toBe(20);
  });

  it('accepts optional unitId + kind filters', () => {
    const parsed = listMetersQuerySchema.parse({
      unitId: UUID_A,
      kind: 'water',
    });
    expect(parsed.unitId).toBe(UUID_A);
    expect(parsed.kind).toBe('water');
  });

  it('rejects non-UUID unitId', () => {
    expect(listMetersQuerySchema.safeParse({ unitId: 'not-uuid' }).success).toBe(false);
  });

  it('rejects unknown kind enum', () => {
    expect(listMetersQuerySchema.safeParse({ kind: 'gas' }).success).toBe(false);
  });

  it('rejects limit > 100 (DoS guard)', () => {
    expect(listMetersQuerySchema.safeParse({ limit: 200 }).success).toBe(false);
  });
});

describe('listReadingsQuerySchema', () => {
  it('coerces string limit + applies default 20', () => {
    expect(listReadingsQuerySchema.parse({ limit: '50' }).limit).toBe(50);
    expect(listReadingsQuerySchema.parse({}).limit).toBe(20);
  });

  it('accepts optional meterId + period filters', () => {
    const parsed = listReadingsQuerySchema.parse({
      meterId: UUID_A,
      period: '2026-04',
    });
    expect(parsed.meterId).toBe(UUID_A);
    expect(parsed.period).toBe('2026-04');
  });

  it('rejects malformed period (must be YYYY-MM)', () => {
    expect(listReadingsQuerySchema.safeParse({ period: '2026-4' }).success).toBe(false);
    expect(listReadingsQuerySchema.safeParse({ period: '2026-13' }).success).toBe(false);
    expect(listReadingsQuerySchema.safeParse({ period: '2026-04-01' }).success).toBe(false);
  });

  it('rejects non-UUID meterId', () => {
    expect(listReadingsQuerySchema.safeParse({ meterId: 'not-uuid' }).success).toBe(false);
  });

  it('rejects limit > 100 (DoS guard)', () => {
    expect(listReadingsQuerySchema.safeParse({ limit: 200 }).success).toBe(false);
  });
});

describe('listPaymentsQuerySchema', () => {
  it('coerces string limit + applies default 20', () => {
    expect(listPaymentsQuerySchema.parse({ limit: '50' }).limit).toBe(50);
    expect(listPaymentsQuerySchema.parse({}).limit).toBe(20);
  });

  it('accepts optional status / invoiceId / tenantId filters', () => {
    const parsed = listPaymentsQuerySchema.parse({
      status: 'pending',
      invoiceId: UUID_A,
      tenantId: UUID_B,
    });
    expect(parsed.status).toBe('pending');
    expect(parsed.invoiceId).toBe(UUID_A);
    expect(parsed.tenantId).toBe(UUID_B);
  });

  it('rejects invalid status', () => {
    expect(listPaymentsQuerySchema.safeParse({ status: 'totally_paid' }).success).toBe(false);
  });

  it('rejects non-UUID invoiceId / tenantId', () => {
    expect(listPaymentsQuerySchema.safeParse({ invoiceId: 'not-uuid' }).success).toBe(false);
    expect(listPaymentsQuerySchema.safeParse({ tenantId: 'not-uuid' }).success).toBe(false);
  });

  it('rejects limit > 100 (DoS guard)', () => {
    expect(listPaymentsQuerySchema.safeParse({ limit: 200 }).success).toBe(false);
  });
});

// Silence "unused" — UUID_C now referenced in auditLog tests.
void UUID_C;
