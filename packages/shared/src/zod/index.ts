/**
 * Barrel — re-exports every domain schema + primitive. Import via:
 *   import { invoiceSchema, moneySchema, ... } from '@dorm/shared/zod';
 * or the typed form via `@dorm/shared` root.
 */
export * from './primitives.js';
export * from './company.js';
export * from './property.js';
export * from './unit.js';
export * from './invoice.js';
export * from './payment.js';
