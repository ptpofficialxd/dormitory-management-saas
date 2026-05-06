/**
 * Wire-side schema for the Dashboard API.
 *
 * Different from `queries/contracts.ts` and friends: the shared
 * `dashboardSummarySchema` ALREADY uses `z.coerce.date()` for `asOf` (the
 * only Date field) and string-typed money / period, so no extension is
 * required to round-trip JSON safely. We re-export here purely so consumers
 * stay on the `@/queries/*` import convention used elsewhere in the app.
 *
 * If we add fields with raw `z.date()` later (e.g. monthly cashflow series),
 * extend the schema here with `z.coerce.date()` like contractWireSchema does.
 */
export {
  dashboardSummarySchema,
  type DashboardSummary,
  type DashboardArrears,
  type DashboardRevenue,
  type DashboardOccupancy,
  type DashboardPipeline,
  type ArrearsBucket,
} from '@dorm/shared/zod';
