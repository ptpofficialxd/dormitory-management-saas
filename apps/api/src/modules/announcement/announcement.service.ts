import { Prisma, getTenantContext, prisma } from '@dorm/db';
import type {
  Announcement,
  CreateAnnouncementInput,
  ListAnnouncementsInput,
} from '@dorm/shared/zod';
import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { type CursorPage, buildCursorPage, decodeCursor } from '../../common/util/cursor.util.js';
import { NotificationService } from '../notification/notification.service.js';

/**
 * AnnouncementService — broadcast composition + persistence (COM-003).
 *
 * v1 scope hard-enforced here:
 *   - target.audience MUST be 'all' (other shapes accepted by Zod for
 *     forward-compat but rejected at the service layer)
 *   - sendNow MUST be true (no scheduling — scheduledAt path lands in
 *     Phase 1)
 *
 * Idempotency contract (CLAUDE.md §3.10):
 *   - Caller (controller) supplies an Idempotency-Key header
 *   - DB unique constraint `(companyId, idempotencyKey)` is the source of
 *     truth — duplicate POST returns the EXISTING row, NEVER a fresh one
 *   - We pre-check via findFirst to short-circuit; the create() catches
 *     P2002 as the race-condition fallback (concurrent same-key POST that
 *     slips past the pre-check window)
 *
 * Recipient resolution:
 *   - Active tenants in the company that have a bound `lineUserId`
 *   - Snapshotted into the broadcast payload (totalRecipients) so the
 *     worker can detect terminal-batch state without an extra query
 *
 * Edge case — zero recipients:
 *   - Still create the row (so the admin sees what they tried to send)
 *   - Set status='failed' immediately + sentAt=now
 *   - Skip enqueue — nothing to fan out
 *   - This matches the worker's terminal-state logic: zero deliveries → failed
 */
@Injectable()
export class AnnouncementService {
  constructor(private readonly notification: NotificationService) {}

  // ---------------------------------------------------------------
  // Read paths
  // ---------------------------------------------------------------

  /**
   * Cursor-paginated list with optional filters (status, audience,
   * createdByUserId, fromDate, toDate). Sort key is `(createdAt DESC,
   * id DESC)` — same convention as every other list endpoint.
   */
  async list(query: ListAnnouncementsInput): Promise<CursorPage<Announcement>> {
    const { cursor, limit, status, audience, createdByUserId, fromDate, toDate } = query;
    const decoded = cursor ? decodeCursor(cursor) : null;

    const baseWhere: Prisma.AnnouncementWhereInput = {};
    if (status) baseWhere.status = status;
    if (createdByUserId) baseWhere.createdByUserId = createdByUserId;
    if (fromDate || toDate) {
      baseWhere.createdAt = {};
      if (fromDate) baseWhere.createdAt.gte = new Date(fromDate);
      if (toDate) baseWhere.createdAt.lte = new Date(toDate);
    }
    // `audience` filter cuts across the JSONB column — Prisma supports
    // path filters but the syntax is verbose; we use a JSON-contains check.
    // For v1 (only 'all' written), filtering by audience is mostly future-
    // proofing for the Phase 1 list page targeting filter.
    if (audience) {
      baseWhere.target = { equals: { audience } } as Prisma.JsonFilter<'Announcement'>;
    }

    const where: Prisma.AnnouncementWhereInput = decoded
      ? {
          AND: [
            baseWhere,
            {
              OR: [
                { createdAt: { lt: new Date(decoded.createdAt) } },
                { createdAt: new Date(decoded.createdAt), id: { lt: decoded.id } },
              ],
            },
          ],
        }
      : baseWhere;

    const rows = await prisma.announcement.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    return buildCursorPage(rows as unknown as Announcement[], limit);
  }

  async getById(id: string): Promise<Announcement> {
    const row = await prisma.announcement.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`Announcement ${id} not found`);
    return row as unknown as Announcement;
  }

  // ---------------------------------------------------------------
  // Write path — create + (synchronously) enqueue broadcast
  // ---------------------------------------------------------------

  /**
   * Create an announcement and (when `sendNow=true`, the only v1 mode)
   * fan out the LINE push jobs. Idempotent on `(companyId, idempotencyKey)`.
   *
   * Order of operations is deliberate:
   *   1. Idempotency pre-check  — short-circuit duplicate POSTs cheaply
   *   2. v1 scope validation     — fail before any DB write
   *   3. Recipient resolution    — query active tenants with lineUserId
   *   4. Company slug lookup     — for the broadcast payload (worker uses
   *                                slug for log lines + future deep-link)
   *   5. Create announcement     — initial status: 'sending' (or 'failed'
   *                                if zero recipients)
   *   6. Enqueue fan-out         — only if recipients > 0
   *
   * If steps 1–5 succeed but step 6 throws (Redis down), the row stays
   * at 'sending' forever. Same trade-off as InvoiceService: DB row is
   * source of truth, a Phase-1 sweep can re-enqueue stale 'sending'
   * announcements. For v1, admin can re-broadcast with a fresh
   * Idempotency-Key.
   */
  async createBroadcast(
    input: CreateAnnouncementInput,
    idempotencyKey: string,
    actorUserId: string,
  ): Promise<Announcement> {
    const ctx = getTenantContext();
    if (!ctx?.companyId) {
      throw new InternalServerErrorException('Tenant context missing on create');
    }

    // 1. Idempotency pre-check — RLS scopes to current company so we
    //    don't accidentally collide on another tenant's key.
    const existing = await prisma.announcement.findFirst({
      where: { idempotencyKey },
    });
    if (existing) {
      return existing as unknown as Announcement;
    }

    // 2. v1 scope guards — Zod accepts the full shape (forward-compat),
    //    so we narrow at the service boundary.
    if (input.target.audience !== 'all') {
      throw new BadRequestException({
        error: 'UnsupportedAudience',
        message:
          "v1 only supports target.audience='all'. Targeted broadcasts (property/floor/unit/tenant) land in Phase 1.",
      });
    }
    if (!input.sendNow) {
      throw new BadRequestException({
        error: 'UnsupportedSchedule',
        message: 'v1 only supports sendNow=true. Scheduled broadcasts land in Phase 1.',
      });
    }

    // 3. Pre-check: company must have a LINE OA channel configured. Without
    //    one, every push job would soft-skip with channel-missing and the
    //    announcement would land at status='failed' without telling the
    //    admin why. Fail upfront with an actionable error so the admin
    //    knows to go set up LINE in Settings first.
    const channel = await prisma.companyLineChannel.findFirst({
      select: { id: true },
    });
    if (!channel) {
      throw new BadRequestException({
        error: 'NoLineChannel',
        message:
          'หอพักนี้ยังไม่ได้เชื่อม LINE Official Account — กรุณาตั้งค่า LINE OA ในหน้า "ตั้งค่า" ก่อนส่งประกาศ',
      });
    }

    // 4. Resolve recipients — active tenants with a bound LINE userId.
    //    RLS scopes the read to the current company automatically.
    //    Zero recipients = no point creating an announcement row that
    //    will immediately flip to 'failed' — fail upfront like the
    //    no-channel case so the admin knows what to fix.
    const recipients = await prisma.tenant.findMany({
      where: {
        status: 'active',
        lineUserId: { not: null },
      },
      select: { id: true },
    });
    const tenantIds = recipients.map((r) => r.id);
    if (tenantIds.length === 0) {
      throw new BadRequestException({
        error: 'NoRecipients',
        message: 'ยังไม่มีผู้เช่าที่ผูกบัญชี LINE — ให้ผู้เช่าเปิดลิงก์ LIFF เพื่อผูกบัญชี LINE ก่อน แล้วค่อยส่งประกาศ',
      });
    }

    // 5. Snapshot the slug for the broadcast payload. RLS narrows
    //    `findFirst` on Company to the current tenant — there's exactly
    //    one row visible, so the result is deterministic.
    const company = await prisma.company.findFirst({
      select: { slug: true },
    });
    if (!company) {
      throw new InternalServerErrorException(
        'No company visible in current tenant context — RLS misconfigured?',
      );
    }

    // 6. Create the row. We've already pre-validated channel + recipients
    //    upstream, so initial status is always 'sending' — the worker can
    //    still flip individual deliveries to failedCount per LINE response,
    //    but the row always starts in-flight.
    let created: Awaited<ReturnType<typeof prisma.announcement.create>>;
    try {
      created = await prisma.announcement.create({
        data: {
          companyId: ctx.companyId,
          title: input.title,
          body: input.body,
          target: input.target,
          status: 'sending',
          scheduledAt: null,
          sentAt: null,
          deliveredCount: 0,
          failedCount: 0,
          createdByUserId: actorUserId,
          idempotencyKey,
        },
      });
    } catch (err) {
      // P2002 race — another concurrent POST won the unique constraint
      // between our pre-check and create. Look up + return the winner.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const found = await prisma.announcement.findFirst({
          where: { idempotencyKey },
        });
        if (found) return found as unknown as Announcement;
      }
      throw err;
    }
    await this.notification.enqueueAnnouncementBroadcast({
      announcementId: created.id,
      companyId: ctx.companyId,
      companySlug: company.slug,
      title: input.title,
      body: input.body,
      tenantIds,
    });

    return created as unknown as Announcement;
  }
}
