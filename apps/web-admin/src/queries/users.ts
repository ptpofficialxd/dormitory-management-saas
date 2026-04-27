import { type ListUsersQuery, listUsersQuerySchema, userPublicSchema } from '@dorm/shared/zod';
import { z } from 'zod';

/**
 * Wire-side schema for the User API (Task #93).
 *
 * Same `z.coerce.date()` pattern as the rest of the queries — shared
 * `userPublicSchema` uses `z.date()`, JSON-over-wire delivers ISO strings.
 *
 * Used by the maintenance assignee dropdown (Task #89). May expand into a
 * full team-page query layer in Phase 2.
 */

export const userPublicWireSchema = userPublicSchema.extend({
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type UserPublicWire = z.infer<typeof userPublicWireSchema>;

export const userPublicPageSchema = z.object({
  items: z.array(userPublicWireSchema),
  nextCursor: z.string().nullable(),
});
export type UserPublicPage = z.infer<typeof userPublicPageSchema>;

export { listUsersQuerySchema };
export type { ListUsersQuery };
