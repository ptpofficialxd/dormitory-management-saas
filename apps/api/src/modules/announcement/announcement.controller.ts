import {
  type Announcement,
  type CreateAnnouncementInput,
  type ListAnnouncementsInput,
  createAnnouncementInputSchema,
  listAnnouncementsInputSchema,
} from '@dorm/shared/zod';
import {
  BadRequestException,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Perm } from '../../common/decorators/perm.decorator.js';
import { ZodBody, ZodQuery } from '../../common/decorators/zod-body.decorator.js';
import type { CursorPage } from '../../common/util/cursor.util.js';
import { AnnouncementService } from './announcement.service.js';

/**
 * Announcement endpoints — `/c/:companySlug/announcements`.
 *
 * RBAC:
 *   - LIST / GET   : `announcement:read` — owner / manager / staff (staff
 *     can read what's been broadcast even if they can't compose new ones)
 *   - POST         : `announcement:broadcast` — owner / manager only (matrix
 *     in @dorm/shared/rbac). Composing a broadcast is a money/PR-adjacent
 *     decision; staff doesn't get the trigger.
 *
 * No PATCH / DELETE in v1 — once broadcast, the announcement row is the
 * audit trail of "what we told tenants and when". Phase 1 may add
 * `cancelled` transition for scheduled-but-not-yet-sent announcements.
 *
 * Idempotency-Key: REQUIRED on POST per CLAUDE.md §3.10. Same key inside
 * the same company collapses to the existing row (service catches Prisma
 * P2002 + returns the original). 8–128 chars matches the schema column.
 */
@Controller('c/:companySlug/announcements')
export class AnnouncementController {
  constructor(private readonly announcementService: AnnouncementService) {}

  @Get()
  @Perm('read', 'announcement')
  list(
    @ZodQuery(listAnnouncementsInputSchema) query: ListAnnouncementsInput,
  ): Promise<CursorPage<Announcement>> {
    return this.announcementService.list(query);
  }

  @Get(':id')
  @Perm('read', 'announcement')
  getById(@Param('id', new ParseUUIDPipe()) id: string): Promise<Announcement> {
    return this.announcementService.getById(id);
  }

  /**
   * Compose + (if `sendNow=true`) immediately broadcast to all active
   * tenants with a bound `lineUserId`. Returns the created row at status
   * `sending` (workers in flight) or `failed` (zero recipients matched).
   *
   * Always returns 201 — even on idempotent replay (service returns the
   * existing row). Differentiating fresh-vs-replay would require a deeper
   * service hook; in practice the client doesn't behave differently.
   */
  @Post()
  @HttpCode(201)
  @Perm('broadcast', 'announcement')
  create(
    @ZodBody(createAnnouncementInputSchema) body: CreateAnnouncementInput,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CurrentUser('sub') userId: string,
  ): Promise<Announcement> {
    if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
      throw new BadRequestException({
        error: 'IdempotencyKeyRequired',
        message: 'Idempotency-Key header is required (8–128 chars) for POST /announcements',
      });
    }
    return this.announcementService.createBroadcast(body, idempotencyKey, userId);
  }
}
