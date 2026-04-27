import { type ListUsersQuery, type UserPublic, listUsersQuerySchema } from '@dorm/shared/zod';
import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { Perm } from '../../common/decorators/perm.decorator.js';
import { ZodQuery } from '../../common/decorators/zod-body.decorator.js';
import type { CursorPage } from '../../common/util/cursor.util.js';
import { UserService } from './user.service.js';

/**
 * User endpoints — `/c/:companySlug/users` (admin path).
 *
 * MVP scope: LIST + GET only — powers the maintenance assignee dropdown
 * (Sprint B Task #89) and any future "team page" reuse.
 *
 * RBAC (matrix-driven via @dorm/shared/rbac):
 *   - LIST / GET : `staff_user:read` (owner / property_manager only)
 *
 *   Staff role does NOT have read:staff_user — design decision: a staff
 *   member shouldn't enumerate their colleagues. The maintenance UI gates
 *   the assignee dropdown behind `<Can resource="staff_user">` — staff
 *   editing a ticket sees the existing assignee but can't change it.
 *
 * No POST / PATCH / DELETE — admin user lifecycle (create / disable /
 * delete) is deferred to Phase 2's self-signup wizard + team page.
 */
@Controller('c/:companySlug/users')
export class UserController {
  constructor(private readonly service: UserService) {}

  @Get()
  @Perm('read', 'staff_user')
  list(@ZodQuery(listUsersQuerySchema) query: ListUsersQuery): Promise<CursorPage<UserPublic>> {
    return this.service.list(query);
  }

  @Get(':id')
  @Perm('read', 'staff_user')
  getById(@Param('id', new ParseUUIDPipe()) id: string): Promise<UserPublic> {
    return this.service.getById(id);
  }
}
