import { z } from 'zod';
import { companyIdSchema, isoDateSchema, moneySchema, uuidSchema } from './primitives.js';

/**
 * Contract status — mirrors Prisma enum `contract_status`.
 *   - `draft`      : created but not yet signed — no billing happens
 *   - `active`     : signed + start date reached — billing cycle runs
 *   - `ended`      : end date reached naturally
 *   - `terminated` : ended early by tenant OR owner (deposit rules differ)
 */
export const contractStatusSchema = z.enum(['draft', 'active', 'ended', 'terminated']);
export type ContractStatus = z.infer<typeof contractStatusSchema>;

/**
 * Rental contract between a tenant and a unit. `rentAmount` and
 * `depositAmount` are SNAPSHOTS — if the owner raises `unit.baseRent`,
 * existing contracts keep billing the old rate until renewed.
 *
 * `endDate` is nullable — month-to-month contracts are common in Thai dorms.
 */
export const contractSchema = z.object({
  id: uuidSchema,
  companyId: companyIdSchema,
  unitId: uuidSchema,
  tenantId: uuidSchema,
  startDate: isoDateSchema,
  endDate: isoDateSchema.nullable(),
  rentAmount: moneySchema,
  depositAmount: moneySchema,
  status: contractStatusSchema.default('draft'),
  notes: z.string().max(1024).nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type Contract = z.infer<typeof contractSchema>;

/**
 * Input for `POST /contracts`. Service must:
 *   - verify unit belongs to current company (RLS covers this)
 *   - verify unit has no other active contract
 *   - enforce endDate > startDate when endDate is provided
 */
export const createContractInputSchema = z
  .object({
    unitId: uuidSchema,
    tenantId: uuidSchema,
    startDate: isoDateSchema,
    endDate: isoDateSchema.optional(),
    rentAmount: moneySchema,
    depositAmount: moneySchema,
    notes: z.string().max(1024).optional(),
  })
  .refine((v) => v.endDate === undefined || v.endDate > v.startDate, {
    path: ['endDate'],
    message: 'endDate must be after startDate',
  });
export type CreateContractInput = z.infer<typeof createContractInputSchema>;

/** Input for `PATCH /contracts/:id` — limited to status + notes in MVP. */
export const updateContractInputSchema = z.object({
  status: contractStatusSchema.optional(),
  endDate: isoDateSchema.optional(),
  notes: z.string().max(1024).optional(),
});
export type UpdateContractInput = z.infer<typeof updateContractInputSchema>;

/**
 * Query string for `GET /contracts`. Filter by `unitId`/`tenantId`/`status`
 * combine under AND; cursor + limit follow the standard pattern.
 */
export const listContractsQuerySchema = z.object({
  unitId: uuidSchema.optional(),
  tenantId: uuidSchema.optional(),
  status: contractStatusSchema.optional(),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListContractsQuery = z.infer<typeof listContractsQuerySchema>;
