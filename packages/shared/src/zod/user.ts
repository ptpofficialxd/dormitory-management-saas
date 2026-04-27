import { z } from 'zod';
import {
  companyIdSchema,
  cursorSchema,
  emailSchema,
  roleSchema,
  uuidSchema,
} from './primitives.js';

/**
 * Admin / staff user public view (Sprint B / Task #93).
 *
 * Powers the `GET /c/:slug/users` endpoint that the maintenance assignee
 * dropdown depends on. Phase 2 may add a full CRUD page (signup wizard,
 * role-assignment management) — for MVP we only need the LIST shape.
 *
 * NEVER includes:
 *   - `passwordHash`         (security)
 *   - `lastLoginAt`          (could leak activity patterns; Phase 2 admin
 *                             audit panel will surface deliberately)
 *
 * `roles` is aggregated server-side from `RoleAssignment` rows for the
 * active company — a single user may hold multiple roles (e.g. an owner
 * who's also tagged as staff for ops backfill).
 */
export const userStatusSchema = z.enum(['active', 'disabled']);
export type UserStatus = z.infer<typeof userStatusSchema>;

export const userPublicSchema = z.object({
  id: uuidSchema,
  companyId: companyIdSchema,
  email: emailSchema,
  displayName: z.string().min(1).max(128),
  status: userStatusSchema,
  /** Aggregated from RoleAssignment WHERE companyId = current. */
  roles: z.array(roleSchema),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type UserPublic = z.infer<typeof userPublicSchema>;

/**
 * Query params for `GET /c/:slug/users`. Cursor-paginated like the rest;
 * only `status` filter for now (admin "show me disabled users to reactivate"
 * vs default "active only" view). No role filter in MVP — assignee dropdown
 * surfaces all admin users; the UI can client-filter if needed.
 */
export const listUsersQuerySchema = z.object({
  status: userStatusSchema.optional(),
  cursor: cursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;
