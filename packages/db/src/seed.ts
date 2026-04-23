/**
 * Seed 2 companies with isolated data — used for RLS isolation tests and
 * for manual QA in dev. Idempotent: re-running upserts by stable slugs.
 *
 * Naming convention (no functional impact — purely cosmetic for QA):
 * - "EasySlip" + "PTP" are placeholder company names. Two visually distinct
 *   names make cross-tenant bug-hunting easier in logs ("did the query hit
 *   EasySlip or PTP?") than alpha/beta or foo/bar.
 * - Email domain `.test` is IETF-reserved (RFC 2606) — never resolves to a
 *   real mailbox, so accidental notification emails in dev never leak.
 *
 * Runs under `withTenant({ bypassRls: true })` so the seed can create rows
 * across multiple tenants without flipping between contexts.
 */

import { Prisma } from '@prisma/client';
import { disconnect, prisma } from './client.js';
import { hashPassword } from './password.js';
import { withTenant } from './tenant-context.js';

type SeedCompany = {
  slug: string;
  name: string;
  owner: { email: string; password: string; displayName: string };
  property: { slug: string; name: string; address: string };
  units: Array<{
    unitNumber: string;
    floor: number;
    baseRent: string; // Decimal as string — never a JS number (ADR-0005).
    sizeSqm: string;
  }>;
};

const SEED_DATA: SeedCompany[] = [
  {
    slug: 'easyslip-dorm',
    name: 'EasySlip Dormitory Building',
    owner: {
      email: 'easyslip@admin.com',
      password: 'easyslipadmin1234',
      displayName: 'EasySlip Admin',
    },
    property: {
      slug: 'main-building',
      name: 'EasySlip Main Building',
      address: '629 Moo 6, Ban Ped, Mueang Khon Kaen, Khon Kaen 40000',
    },
    units: [
      { unitNumber: '101', floor: 1, baseRent: '5500.00', sizeSqm: '24.00' },
      { unitNumber: '102', floor: 1, baseRent: '5800.00', sizeSqm: '26.50' },
    ],
  },
  {
    slug: 'ptp-apts',
    name: 'PTP Apartment Building',
    owner: {
      email: 'ptpofficialxd@gmail.com',
      password: 'ptpofficialxd1234',
      displayName: 'ptpofficialxd',
    },
    property: {
      slug: 'tower-a',
      name: 'PTP Tower A',
      address:
        '2/120 Moo 12, Rung Rueang Lake View Village, Rob Bueng Thung Sang Rd., Nai Mueang, Mueang Khon Kaen, Khon Kaen 40000',
    },
    units: [
      { unitNumber: 'A-201', floor: 2, baseRent: '8200.00', sizeSqm: '32.00' },
      { unitNumber: 'A-202', floor: 2, baseRent: '8500.00', sizeSqm: '34.00' },
    ],
  },
];

async function seedOne(input: SeedCompany): Promise<string> {
  // Upsert by slug so re-running the seed is safe.
  const company = await prisma.company.upsert({
    where: { slug: input.slug },
    update: { name: input.name },
    create: { slug: input.slug, name: input.name },
  });

  const passwordHash = await hashPassword(input.owner.password);

  const user = await prisma.user.upsert({
    where: {
      companyId_email: { companyId: company.id, email: input.owner.email },
    },
    update: { displayName: input.owner.displayName, passwordHash },
    create: {
      companyId: company.id,
      email: input.owner.email,
      passwordHash,
      displayName: input.owner.displayName,
    },
  });

  await prisma.roleAssignment.upsert({
    where: {
      companyId_userId_role: {
        companyId: company.id,
        userId: user.id,
        role: 'company_owner',
      },
    },
    update: {},
    create: {
      companyId: company.id,
      userId: user.id,
      role: 'company_owner',
    },
  });

  const property = await prisma.property.upsert({
    where: {
      companyId_slug: { companyId: company.id, slug: input.property.slug },
    },
    update: { name: input.property.name, address: input.property.address },
    create: {
      companyId: company.id,
      slug: input.property.slug,
      name: input.property.name,
      address: input.property.address,
    },
  });

  for (const u of input.units) {
    await prisma.unit.upsert({
      where: {
        propertyId_unitNumber: {
          propertyId: property.id,
          unitNumber: u.unitNumber,
        },
      },
      update: {
        baseRent: new Prisma.Decimal(u.baseRent),
        sizeSqm: new Prisma.Decimal(u.sizeSqm),
        floor: u.floor,
      },
      create: {
        companyId: company.id,
        propertyId: property.id,
        unitNumber: u.unitNumber,
        floor: u.floor,
        baseRent: new Prisma.Decimal(u.baseRent),
        sizeSqm: new Prisma.Decimal(u.sizeSqm),
      },
    });
  }

  return company.id;
}

async function main(): Promise<void> {
  console.log('Seeding 2 companies with isolated data...');
  await withTenant({ companyId: '', bypassRls: true }, async () => {
    for (const company of SEED_DATA) {
      const id = await seedOne(company);
      console.log(`  ${company.slug} -> ${id}`);
    }
  });
  console.log('Seed complete.');
}

main()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exitCode = 1;
  })
  .finally(() => disconnect());
