import { describe, expect, it } from 'vitest';
import {
  companyStatusSchema,
  contractStatusSchema,
  createCompanyInputSchema,
  createContractInputSchema,
  createInvoiceInputSchema,
  createMeterInputSchema,
  createPaymentInputSchema,
  createReadingInputSchema,
  createTenantInputSchema,
  createUnitInputSchema,
  invoiceItemKindSchema,
  loginAdminInputSchema,
  loginLiffInputSchema,
  meterKindSchema,
  meterValueSchema,
  moneySchema,
  periodSchema,
  rateSchema,
  rejectPaymentInputSchema,
  slipMimeTypeSchema,
  slugSchema,
  tenantStatusSchema,
  unitStatusSchema,
  uploadSlipInputSchema,
  uuidSchema,
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

// Silence "unused" — UUID_C is reserved for future tests. Keep import stable.
void UUID_C;
