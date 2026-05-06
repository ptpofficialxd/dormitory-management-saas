/**
 * @dorm/shared — runtime-agnostic primitives used by api / web / liff.
 *
 * Subpath exports (see `package.json#exports`) let consumers import only
 * what they need, which matters for the LIFF bundle size:
 *   import { can } from '@dorm/shared/rbac';
 *   import { money } from '@dorm/shared/money';
 *
 * The root import re-exports everything for ergonomic server-side use.
 */

export * from './constants.js';
export * from './errors.js';
export * as money from './money.js';
export * as date from './date.js';
export * as slug from './slug.js';
export * as promptpay from './promptpay.js';
export * as rbac from './rbac/index.js';
export * as billing from './billing/index.js';
export * as zod from './zod/index.js';
