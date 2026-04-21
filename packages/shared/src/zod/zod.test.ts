import { describe, expect, it } from 'vitest';
import {
  createCompanyInputSchema,
  createInvoiceInputSchema,
  createPaymentInputSchema,
  createUnitInputSchema,
  moneySchema,
  periodSchema,
  slugSchema,
  uuidSchema,
} from './index.js';

describe('primitives — uuid / slug / money / period', () => {
  it('uuidSchema accepts v4', () => {
    expect(
      uuidSchema.safeParse('550e8400-e29b-41d4-a716-446655440000').success,
    ).toBe(true);
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
    ['12345678.99', true], // 8 integer digits max
    ['123456789.00', false], // 9 integer digits — rejected
    ['5500.001', false], // 3dp — rejected
    ['abc', false],
    ['-0', false], // negative zero rejected
    ['-0.00', false],
  ])('moneySchema("%s") → %s', (input, expected) => {
    expect(moneySchema.safeParse(input).success).toBe(expected);
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
    expect(
      createCompanyInputSchema.safeParse({ slug: 'acme', name: '' }).success,
    ).toBe(false);
  });
});

describe('createUnitInputSchema', () => {
  it('accepts valid unit', () => {
    const result = createUnitInputSchema.safeParse({
      propertyId: '550e8400-e29b-41d4-a716-446655440000',
      unitNumber: '101',
      floor: 1,
      sizeSqm: '24.00',
      baseRent: '5500.00',
    });
    expect(result.success).toBe(true);
  });

  it('rejects floor out of range', () => {
    expect(
      createUnitInputSchema.safeParse({
        propertyId: '550e8400-e29b-41d4-a716-446655440000',
        unitNumber: '101',
        floor: 9999,
        sizeSqm: '24',
        baseRent: '5500',
      }).success,
    ).toBe(false);
  });
});

describe('createInvoiceInputSchema', () => {
  it('accepts a valid invoice with one item', () => {
    const result = createInvoiceInputSchema.safeParse({
      contractId: '550e8400-e29b-41d4-a716-446655440000',
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

  it('rejects zero items', () => {
    expect(
      createInvoiceInputSchema.safeParse({
        contractId: '550e8400-e29b-41d4-a716-446655440000',
        period: '2026-04',
        dueDate: '2026-04-15T00:00:00Z',
        items: [],
      }).success,
    ).toBe(false);
  });

  it('rejects invalid item kind', () => {
    expect(
      createInvoiceInputSchema.safeParse({
        contractId: '550e8400-e29b-41d4-a716-446655440000',
        period: '2026-04',
        dueDate: '2026-04-15T00:00:00Z',
        items: [
          {
            kind: 'mystery',
            description: 'x',
            quantity: '1',
            unitPrice: '0',
          },
        ],
      }).success,
    ).toBe(false);
  });
});

describe('createPaymentInputSchema', () => {
  it('accepts promptpay with slipId', () => {
    expect(
      createPaymentInputSchema.safeParse({
        invoiceId: '550e8400-e29b-41d4-a716-446655440000',
        amount: '5500.00',
        method: 'promptpay',
        slipId: '550e8400-e29b-41d4-a716-446655440001',
      }).success,
    ).toBe(true);
  });

  it('rejects unknown method', () => {
    expect(
      createPaymentInputSchema.safeParse({
        invoiceId: '550e8400-e29b-41d4-a716-446655440000',
        amount: '5500.00',
        method: 'bitcoin',
      }).success,
    ).toBe(false);
  });
});
