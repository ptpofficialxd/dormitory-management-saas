import { describe, expect, it } from 'vitest';
import { assertCan, can, permissionsFor } from './index.js';

describe('RBAC — company_owner', () => {
  const user = { roles: ['company_owner'] as const };

  it('can do everything on unit / property / invoice', () => {
    expect(can(user, 'create', 'unit')).toBe(true);
    expect(can(user, 'delete', 'unit')).toBe(true);
    expect(can(user, 'update', 'property')).toBe(true);
    expect(can(user, 'approve', 'slip')).toBe(true);
    expect(can(user, 'read', 'audit_log')).toBe(true);
    expect(can(user, 'broadcast', 'announcement')).toBe(true);
  });
});

describe('RBAC — property_manager', () => {
  const user = { roles: ['property_manager'] as const };

  it('can approve payments and slips', () => {
    expect(can(user, 'approve', 'slip')).toBe(true);
    expect(can(user, 'approve', 'payment')).toBe(true);
  });

  it('cannot delete properties / invoices', () => {
    expect(can(user, 'delete', 'property')).toBe(false);
    expect(can(user, 'delete', 'invoice')).toBe(false);
  });

  it('cannot manage staff users', () => {
    expect(can(user, 'create', 'staff_user')).toBe(false);
    expect(can(user, 'read', 'staff_user')).toBe(false);
  });

  it('cannot update the company row', () => {
    expect(can(user, 'update', 'company')).toBe(false);
  });
});

describe('RBAC — staff', () => {
  const user = { roles: ['staff'] as const };

  it('can create meter readings + maintenance tickets', () => {
    expect(can(user, 'create', 'meter_reading')).toBe(true);
    expect(can(user, 'create', 'maintenance_ticket')).toBe(true);
  });

  it('cannot approve slips or payments', () => {
    expect(can(user, 'approve', 'slip')).toBe(false);
    expect(can(user, 'approve', 'payment')).toBe(false);
  });

  it('cannot create invoices or contracts', () => {
    expect(can(user, 'create', 'invoice')).toBe(false);
    expect(can(user, 'create', 'contract')).toBe(false);
  });
});

describe('RBAC — tenant', () => {
  const user = { roles: ['tenant'] as const };

  it('can upload a slip and read their bills', () => {
    expect(can(user, 'create', 'slip')).toBe(true);
    expect(can(user, 'read', 'invoice')).toBe(true);
    expect(can(user, 'read', 'payment')).toBe(true);
    expect(can(user, 'create', 'maintenance_ticket')).toBe(true);
  });

  it('cannot approve their own payment', () => {
    expect(can(user, 'approve', 'payment')).toBe(false);
    expect(can(user, 'approve', 'slip')).toBe(false);
  });

  it('cannot read / create staff or tenant users', () => {
    expect(can(user, 'read', 'staff_user')).toBe(false);
    expect(can(user, 'create', 'tenant_user')).toBe(false);
  });

  it('cannot broadcast announcements', () => {
    expect(can(user, 'broadcast', 'announcement')).toBe(false);
  });
});

describe('RBAC — guardian', () => {
  const user = { roles: ['guardian'] as const };

  it('is strictly read-only', () => {
    expect(can(user, 'read', 'invoice')).toBe(true);
    expect(can(user, 'read', 'payment')).toBe(true);
    expect(can(user, 'read', 'announcement')).toBe(true);

    expect(can(user, 'create', 'slip')).toBe(false);
    expect(can(user, 'update', 'invoice')).toBe(false);
    expect(can(user, 'create', 'maintenance_ticket')).toBe(false);
  });
});

describe('RBAC — multi-role union', () => {
  it('unions permissions across assigned roles', () => {
    // A person who is both company_owner at company A and tenant at company B
    // — when operating in a context where BOTH roles are active:
    const user = { roles: ['tenant', 'staff'] as const };
    // staff can create meter_reading; tenant alone cannot.
    expect(can(user, 'create', 'meter_reading')).toBe(true);
    // tenant can create slip; staff alone cannot.
    expect(can(user, 'create', 'slip')).toBe(true);
    // Neither can approve payment.
    expect(can(user, 'approve', 'payment')).toBe(false);
  });

  it('empty roles → no permissions', () => {
    const user = { roles: [] as const };
    expect(can(user, 'read', 'invoice')).toBe(false);
    expect(can(user, 'read', 'announcement')).toBe(false);
  });
});

describe('assertCan', () => {
  it('passes on allowed action', () => {
    expect(() => assertCan({ roles: ['company_owner'] }, 'create', 'unit')).not.toThrow();
  });

  it('throws with role info on denial', () => {
    expect(() => assertCan({ roles: ['tenant'] }, 'approve', 'payment')).toThrow(
      /Forbidden.*approve:payment.*tenant/,
    );
  });
});

describe('permissionsFor', () => {
  it('returns sorted list per role', () => {
    const perms = permissionsFor('staff');
    expect(perms.length).toBeGreaterThan(0);
    expect([...perms]).toEqual([...perms].sort());
  });

  it('guardian has fewer permissions than company_owner', () => {
    expect(permissionsFor('guardian').length).toBeLessThan(permissionsFor('company_owner').length);
  });
});
