/**
 * Seed 2 companies with isolated data — used for RLS isolation tests and
 * for manual QA in dev. Idempotent: re-running upserts by stable slugs.
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
    slug: 'acme-dorm',
    name: 'ACME Dormitory',
    owner: {
      email: 'owner@acme-dorm.test',
      password: 'acme-demo-pw-1234',
      displayName: 'ACME Owner',
    },
    property: {
      slug: 'main-building',
      name: 'ACME Main Building',
      address: '99 Pracha Uthit, Thung Khru, Bangkok 10140',
    },
    units: [
      { unitNumber: '101', floor: 1, baseRent: '5500.00', sizeSqm: '24.00' },
      { unitNumber: '102', floor: 1, baseRent: '5800.00', sizeSqm: '26.50' },
    ],
  },
  {
    slug: 'beta-apts',
    name: 'Beta Apartments',
    owner: {
      email: 'owner@beta-apts.test',
      password: 'beta-demo-pw-1234',
      displayName: 'Beta Owner',
    },
    property: {
      slug: 'tower-a',
      name: 'Beta Tower A',
      address: '12/3 Sukhumvit 21, Khlong Toei Nuea, Bangkok 10110',
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
