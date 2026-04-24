#!/usr/bin/env node
/**
 * One-shot E2E setup script — creates (or reuses) tenant + contract +
 * fresh invite, prints LIFF URL ready to share with phone for binding.
 *
 * Usage:
 *   bun run e2e:invite           # uses unit 101
 *   bun run e2e:invite -- --unit 102
 *
 * Reads from root .env: API_URL, LIFF_BIND_URL
 *
 * Idempotent: if unit already has a draft/active contract, reuses its
 * tenant and just mints a fresh invite (old invite stays revokable but
 * we don't bother — TTL kills it). Avoids ContractOverlap on re-runs.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// --- tiny .env loader (no dep) ---
function loadEnv() {
  const txt = readFileSync(join(ROOT, '.env'), 'utf8');
  const env = {};
  for (const line of txt.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}
const env = loadEnv();
const API = env.API_URL || 'http://127.0.0.1:4000';
const LIFF_BIND_URL = env.LIFF_BIND_URL;

// --- CLI args ---
const argv = process.argv.slice(2);
const unitArgIdx = argv.indexOf('--unit');
const UNIT_NUMBER = unitArgIdx >= 0 ? argv[unitArgIdx + 1] : '101';

// --- config (edit if testing different company) ---
const COMPANY_SLUG = 'easyslip-dorm';
const ADMIN_EMAIL = 'easyslip@admin.com';
const ADMIN_PASSWORD = 'easyslipadmin1234';
const PROPERTY_SLUG = 'main-building';

// --- helpers ---
async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  if (!res.ok) {
    const err = new Error(`${method} ${path} → ${res.status}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

// --- run ---
console.log(`▶ API: ${API}`);
console.log(`▶ Company: ${COMPANY_SLUG}`);
console.log(`▶ Unit: ${UNIT_NUMBER}\n`);

console.log('1️⃣  Login admin...');
const login = await api('POST', '/auth/login', {
  body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD, companySlug: COMPANY_SLUG },
});
const token = login.accessToken;
console.log('   ✓ JWT acquired\n');

console.log(`2️⃣  Find unit ${UNIT_NUMBER}...`);
// (removed stray "t" typo in step header)
const properties = await api('GET', `/c/${COMPANY_SLUG}/properties`, { token });
const property = (properties.items || properties).find((p) => p.slug === PROPERTY_SLUG);
if (!property) {
  console.error('Property not found:', PROPERTY_SLUG);
  process.exit(1);
}
const units = await api('GET', `/c/${COMPANY_SLUG}/units?propertyId=${property.id}`, { token });
const unit = (units.items || units).find((u) => u.unitNumber === UNIT_NUMBER);
if (!unit) {
  console.error('Unit not found:', UNIT_NUMBER);
  process.exit(1);
}
console.log(`   ✓ Unit ${unit.unitNumber} (id=${unit.id})\n`);

// 3️⃣ Find existing contract on this unit, OR create new
console.log(`3️⃣  Check for existing contract on unit ${UNIT_NUMBER}...`);
const existingContracts = await api('GET', `/c/${COMPANY_SLUG}/contracts?unitId=${unit.id}`, {
  token,
});
const items = existingContracts.items || existingContracts;
const reusable = items.find((c) => c.status === 'draft' || c.status === 'active');

let tenantId;
let contractId;

if (reusable) {
  tenantId = reusable.tenantId;
  contractId = reusable.id;
  console.log(`   ✓ Reusing existing contract id=${contractId} (status=${reusable.status})`);
  console.log(`     → tenant id=${tenantId}`);

  // Activate if previous run left it as draft.
  if (reusable.status === 'draft') {
    await api('PATCH', `/c/${COMPANY_SLUG}/contracts/${contractId}`, {
      token,
      body: { status: 'active' },
    });
    console.log('   ✓ Contract activated (draft → active)\n');
  } else {
    console.log('');
  }
} else {
  console.log('   ✓ No active contract — will create fresh\n');

  const stamp = Date.now().toString().slice(-6);
  console.log('4️⃣  Create tenant...');
  const tenant = await api('POST', `/c/${COMPANY_SLUG}/tenants`, {
    token,
    body: {
      displayName: `Test Tenant ${stamp}`,
      phone: '0812345678',
    },
  });
  tenantId = tenant.id;
  console.log(`   ✓ Tenant id=${tenantId} (${tenant.displayName})\n`);

  console.log('5️⃣  Create contract (unit ↔ tenant)...');
  const today = new Date().toISOString().slice(0, 10);
  const contract = await api('POST', `/c/${COMPANY_SLUG}/contracts`, {
    token,
    body: {
      unitId: unit.id,
      tenantId: tenantId,
      startDate: today,
      rentAmount: String(unit.baseRent),
      depositAmount: String(unit.baseRent),
    },
  });
  contractId = contract.id;
  console.log(`   ✓ Contract id=${contractId} (status=${contract.status})`);

  // Activate immediately — batch invoice generation skips `draft` contracts
  // (legal posture: draft = not yet signed → no billing). For E2E test we
  // want billing to flow, so flip to active right after create.
  if (contract.status === 'draft') {
    await api('PATCH', `/c/${COMPANY_SLUG}/contracts/${contractId}`, {
      token,
      body: { status: 'active' },
    });
    console.log('   ✓ Contract activated (draft → active)\n');
  } else {
    console.log('');
  }
}

// Skip invite generation if tenant is already bound to a LINE user. The API
// blocks repeat invites with 409 TenantAlreadyBound (security: prevents an
// admin from re-binding someone else's tenant to a different LINE account).
// Just print the home URL — the user can re-enter the LIFF directly.
console.log('6️⃣  Check tenant bind status...');
const tenant = await api('GET', `/c/${COMPANY_SLUG}/tenants/${tenantId}`, { token });
const alreadyBound = Boolean(tenant.lineUserId);
console.log(`   ✓ Tenant lineUserId: ${tenant.lineUserId ?? '<not bound>'}\n`);

// LIFF URL convention: subpath after liff-id is forwarded to endpoint URL.
// `https://liff.line.me/<id>/c/<slug>/...` → LINE redirects to
// `https://<endpoint>/c/<slug>/...`. The `?path=` query approach is NOT a
// LIFF feature — must be subpath. (Bug fixed.)
let liffUrl;
let code = null;

if (alreadyBound) {
  liffUrl = `${LIFF_BIND_URL}/c/${COMPANY_SLUG}/invoices`;
  console.log('━'.repeat(60));
  console.log('✅ Tenant already bound — open invoice list directly:\n');
  console.log(`   ${liffUrl}\n`);
  console.log('━'.repeat(60));
  console.log('Tenant:  ', tenantId);
  console.log('Contract:', contractId);
  console.log('LineUser:', tenant.lineUserId);
  console.log('\nTo re-test bind: clear tenant.lineUserId in Prisma Studio first.');
} else {
  console.log('7️⃣  Generate fresh LIFF invite code...');
  const inviteRes = await api('POST', `/c/${COMPANY_SLUG}/tenants/${tenantId}/invites`, {
    token,
    body: {},
  });
  code = inviteRes.code;
  const inviteId = inviteRes.invite?.id;
  const expiresAt = inviteRes.invite?.expiresAt;
  console.log(`   ✓ Invite id=${inviteId}, code=${code}`);
  console.log(`     expires ${expiresAt}\n`);

  liffUrl = `${LIFF_BIND_URL}/c/${COMPANY_SLUG}/bind?code=${code}`;
  console.log('━'.repeat(60));
  console.log('✅ READY — share this URL with phone (LINE chat / Keep memo):\n');
  console.log(`   ${liffUrl}\n`);
  console.log('━'.repeat(60));
  console.log('Tenant:  ', tenantId);
  console.log('Contract:', contractId);
  console.log('Code:    ', code);
}
