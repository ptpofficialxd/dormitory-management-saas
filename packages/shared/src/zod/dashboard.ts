import { z } from 'zod';
import { moneySchema, periodSchema } from './primitives.js';

/**
 * Admin Dashboard summary — single-call snapshot used by `/c/:slug/dashboard`.
 *
 * Why one endpoint (not five):
 *   - Page renders all five widgets together; fan-out would multiply the
 *     auth + tenant-context + audit overhead by 5× for no UX benefit.
 *   - The API service runs the underlying SELECTs in parallel inside one
 *     RLS-scoped transaction (see DashboardService) — same wall-clock cost
 *     as a single query, much less network chatter.
 *
 * Money: every amount is a string `"5500.00"` (Decimal(10,2) wire format,
 * see ADR-0005 + `moneySchema`). Counts are non-negative integers.
 *
 * Versioning: this is a frozen contract for the LIFF / web-admin client.
 * ADD new fields with `.optional()` so older clients keep working; never
 * REMOVE or RENAME a field — bump a `/dashboard/v2` route instead.
 */

/** A single arrears aging bucket — invoice count + sum of `invoice.total`. */
export const arrearsBucketSchema = z.object({
  /** Number of invoices in this bucket. */
  count: z.number().int().min(0),
  /**
   * Sum of `invoice.total` for invoices in this bucket.
   *
   * Known v1 simplification: this is the FACE total, not the unpaid
   * remainder — partially-paid invoices over-report by the confirmed
   * payment amount. Acceptable for MVP (Thai dorm partial-pay rate is low)
   * and documented as a follow-up. The accurate version subtracts
   * `SUM(payments.amount WHERE status=confirmed)` per invoice but doubles
   * the query weight; defer until beta customer flags it.
   */
  amount: moneySchema,
});
export type ArrearsBucket = z.infer<typeof arrearsBucketSchema>;

export const dashboardArrearsSchema = z.object({
  /** 1–30 days past due. */
  bucket1to30: arrearsBucketSchema,
  /** 31–60 days past due. */
  bucket31to60: arrearsBucketSchema,
  /** 61+ days past due. */
  bucket60plus: arrearsBucketSchema,
  /** All overdue invoices summed (= bucket1to30 + bucket31to60 + bucket60plus). */
  total: arrearsBucketSchema,
});
export type DashboardArrears = z.infer<typeof dashboardArrearsSchema>;

export const dashboardRevenueSchema = z.object({
  /**
   * Sum of payments with status=`confirmed` whose `paidAt` falls inside the
   * current Bangkok-local month. Excludes pending / rejected.
   */
  confirmed: moneySchema,
  /**
   * Sum of payments with status=`pending` regardless of `paidAt` — these
   * are slips waiting for admin to confirm. Surfaces the review queue size
   * in money terms; the count lives in `pipeline.pendingPayments`.
   */
  pendingConfirm: moneySchema,
});
export type DashboardRevenue = z.infer<typeof dashboardRevenueSchema>;

export const dashboardOccupancySchema = z.object({
  totalUnits: z.number().int().min(0),
  occupiedUnits: z.number().int().min(0),
  vacantUnits: z.number().int().min(0),
  maintenanceUnits: z.number().int().min(0),
  reservedUnits: z.number().int().min(0),
  /**
   * `occupied / total` as a fraction in `[0, 1]`. Server computes this so
   * the client doesn't need division-by-zero handling for empty companies
   * (returns `0` when totalUnits = 0).
   */
  rate: z.number().min(0).max(1),
});
export type DashboardOccupancy = z.infer<typeof dashboardOccupancySchema>;

export const dashboardPipelineSchema = z.object({
  /** Contracts with status=`active` (excludes draft/ended/terminated). */
  activeContracts: z.number().int().min(0),
  /** Maintenance tickets with status in (`open`, `in_progress`). */
  openMaintenance: z.number().int().min(0),
  /** Payments with status=`pending` — slips waiting for admin to confirm. */
  pendingPayments: z.number().int().min(0),
});
export type DashboardPipeline = z.infer<typeof dashboardPipelineSchema>;

export const dashboardSummarySchema = z.object({
  /**
   * UTC instant the snapshot was taken — clients display "as of HH:mm" so
   * users know whether to hit refresh.
   */
  asOf: z.coerce.date(),
  /**
   * Bangkok-local month the revenue figures cover (e.g. `"2026-05"`). Sent
   * back so the client renders the right header without recomputing TZ.
   */
  period: periodSchema,
  revenue: dashboardRevenueSchema,
  arrears: dashboardArrearsSchema,
  occupancy: dashboardOccupancySchema,
  pipeline: dashboardPipelineSchema,
});
export type DashboardSummary = z.infer<typeof dashboardSummarySchema>;
