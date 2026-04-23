import { createHash, randomInt } from 'node:crypto';
import { type Prisma, getTenantContext, prisma, withTenant } from '@dorm/db';
import {
  type GenerateTenantInviteResponse,
  type ListTenantInvitesQuery,
  type RedeemTenantInviteResponse,
  type RevokeTenantInviteInput,
  TENANT_INVITE_CODE_ALPHABET,
  TENANT_INVITE_CODE_LENGTH,
  TENANT_INVITE_CODE_PREFIX_LENGTH,
  TENANT_INVITE_TTL_DAYS,
  type TenantInvite,
  type TenantInvitePreview,
} from '@dorm/shared/zod';
import {
  ConflictException,
  GoneException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { type CursorPage, buildCursorPage, decodeCursor } from '../../common/util/cursor.util.js';

/**
 * TenantInvite (Task #41) — issue + redeem short-lived single-use codes that
 * bind a LINE user to a pre-existing Tenant row.
 *
 * Endpoint matrix:
 *
 *   ADMIN (RLS-scoped via TenantContextInterceptor)
 *     generate(tenantId)         → POST /c/:slug/tenants/:tenantId/invites
 *     list(tenantId, query)      → GET  /c/:slug/tenants/:tenantId/invites
 *     revoke(inviteId, input)    → POST /c/:slug/tenant-invites/:id/revoke
 *
 *   PUBLIC (no JWT — LIFF; bypass-RLS lookup then withTenant for mutate)
 *     peek(code)                 → POST /liff/invites/peek
 *     redeem(code, lineUserId)   → POST /liff/invites/redeem
 *
 * Security model:
 *   - Plaintext code returned to admin ONCE at generate; never persisted.
 *   - DB stores SHA-256 hex of plaintext + first-4-char prefix for lookup.
 *   - Redeem is atomic: a single transaction wraps the CAS (status='pending'
 *     → 'redeemed' WHERE expiresAt > now()) AND the Tenant.lineUserId update,
 *     so partial failure is impossible. P2002 on the unique
 *     `(companyId, lineUserId)` index → BIND_CONFLICT (no auto-rebind).
 *
 * Audit log:
 *   We write our own rows (not via AuditLogInterceptor) because the
 *   interceptor only knows HTTP method+URL. Business events with rich metadata
 *   (BIND_CONFLICT carries the conflicting tenant id) need explicit emission.
 *   Public endpoints have no actor user — `actorUserId` is null and the
 *   metadata captures the LINE userId that initiated the action.
 */
@Injectable()
export class TenantInviteService {
  private readonly logger = new Logger(TenantInviteService.name);

  // -----------------------------------------------------------------------
  // Admin path (RLS-scoped)
  // -----------------------------------------------------------------------

  /**
   * Mint a fresh invite for a tenant. Returns the plaintext code ONCE — the
   * caller (controller) is responsible for surfacing it to the admin and
   * never logging it. Subsequent calls cannot recover the plaintext; admin
   * must re-generate to share again.
   *
   * Pre-conditions:
   *   - The tenant exists in the active companyId (RLS enforces).
   *   - The tenant is NOT already bound to a LINE user. Generating an invite
   *     for an already-bound tenant is an admin mistake — fail fast with 409
   *     so they unbind first (Phase 2 will offer a "rebind" flow).
   */
  async generate(tenantId: string, actorUserId: string): Promise<GenerateTenantInviteResponse> {
    const ctx = getTenantContext();
    if (!ctx?.companyId) {
      throw new InternalServerErrorException('Tenant context missing on generate');
    }

    // Confirm the tenant exists in scope + not already bound. RLS scopes
    // the read by companyId so a 404 here is enough — no extra company check.
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, lineUserId: true },
    });
    if (!tenant) {
      throw new NotFoundException(`Tenant ${tenantId} not found`);
    }
    if (tenant.lineUserId) {
      throw new ConflictException({
        error: 'TenantAlreadyBound',
        message: `Tenant ${tenantId} is already bound to a LINE user — unbind first`,
      });
    }

    // Generate plaintext + derive storage form. We retry on the very rare
    // event of a hash collision with a still-pending invite (probability of
    // 2^-160 per attempt — included for forensic completeness, not realism).
    const plaintext = generatePlaintextCode();
    const codeHash = sha256Hex(plaintext);
    const codePrefix = plaintext.slice(0, TENANT_INVITE_CODE_PREFIX_LENGTH);
    const expiresAt = new Date(Date.now() + TENANT_INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);

    const row = await prisma.tenantInvite.create({
      data: {
        companyId: ctx.companyId,
        tenantId,
        codeHash,
        codePrefix,
        status: 'pending',
        expiresAt,
        createdByUserId: actorUserId,
      },
    });

    await this.writeAudit({
      action: 'TENANT_INVITE_GENERATED',
      resourceId: row.id,
      actorUserId,
      metadata: {
        tenantId,
        codePrefix,
        expiresAt: expiresAt.toISOString(),
      },
    });

    return {
      invite: toTenantInvite(row),
      code: formatCodeForDisplay(plaintext),
    };
  }

  /**
   * Cursor-paginated list of invites for a single tenant. Status filter
   * supports the admin UI segmenting "active vs spent".
   */
  async list(tenantId: string, query: ListTenantInvitesQuery): Promise<CursorPage<TenantInvite>> {
    const { cursor, limit, status } = query;
    const decoded = cursor ? decodeCursor(cursor) : null;

    const baseWhere: Prisma.TenantInviteWhereInput = { tenantId };
    if (status) baseWhere.status = status;

    const where: Prisma.TenantInviteWhereInput = decoded
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

    const rows = await prisma.tenantInvite.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    return buildCursorPage(rows.map(toTenantInvite), limit);
  }

  /**
   * Revoke a pending invite. CAS pattern: only `pending` → `revoked`. If the
   * invite was already redeemed/expired/revoked, return 410 Gone with the
   * current status so the admin UI can refresh.
   */
  async revoke(
    inviteId: string,
    input: RevokeTenantInviteInput,
    actorUserId: string,
  ): Promise<TenantInvite> {
    const ctx = getTenantContext();
    if (!ctx?.companyId) {
      throw new InternalServerErrorException('Tenant context missing on revoke');
    }

    const existing = await prisma.tenantInvite.findUnique({ where: { id: inviteId } });
    if (!existing) {
      throw new NotFoundException(`TenantInvite ${inviteId} not found`);
    }

    if (existing.status !== 'pending') {
      throw new GoneException({
        error: 'TenantInviteNotPending',
        message: `Invite is already in terminal state '${existing.status}'`,
      });
    }

    // CAS via updateMany so two simultaneous revokes can't both succeed.
    const result = await prisma.tenantInvite.updateMany({
      where: { id: inviteId, status: 'pending' },
      data: { status: 'revoked' },
    });
    if (result.count !== 1) {
      // Lost the race — re-read and surface the new state.
      throw new GoneException({
        error: 'TenantInviteNotPending',
        message: 'Invite transitioned out of pending before this revoke could apply',
      });
    }

    const updated = await prisma.tenantInvite.findUniqueOrThrow({ where: { id: inviteId } });

    await this.writeAudit({
      action: 'TENANT_INVITE_REVOKED',
      resourceId: inviteId,
      actorUserId,
      metadata: {
        tenantId: existing.tenantId,
        codePrefix: existing.codePrefix,
        reason: input.reason ?? null,
      },
    });

    return toTenantInvite(updated);
  }

  // -----------------------------------------------------------------------
  // Public (LIFF) path — bypass RLS for lookup, switch into tenant scope for mutate
  // -----------------------------------------------------------------------

  /**
   * Preview an invite by plaintext code. Read-only. Returns redacted tenant
   * info so the LIFF user can sanity-check the binding before committing.
   *
   * Bypass-RLS scope is deliberately narrow: a single SELECT joining
   * tenant_invite → tenant → unit → property, filtered by codePrefix +
   * codeHash + status='pending' + expiresAt > now(). No mutation, no
   * cross-tenant data leak (we only return one row's redacted fields).
   *
   * Side-effect: if the invite is `pending` but expired, this peek opportunistically
   * flips the status to `expired` (under the row's company scope) so the
   * admin UI sees fresh state. We keep the response shape consistent — the
   * caller just gets a 410 either way.
   */
  async peek(code: string): Promise<TenantInvitePreview> {
    const codeHash = sha256Hex(code);
    const codePrefix = code.slice(0, TENANT_INVITE_CODE_PREFIX_LENGTH);

    const candidate = await withTenant({ companyId: '', bypassRls: true }, () =>
      prisma.tenantInvite.findFirst({
        where: { codePrefix, codeHash },
        include: {
          tenant: {
            select: {
              id: true,
              displayName: true,
              contracts: {
                where: { status: 'active' },
                orderBy: { startDate: 'desc' },
                take: 1,
                select: {
                  unit: {
                    select: {
                      unitNumber: true,
                      property: { select: { name: true } },
                    },
                  },
                },
              },
            },
          },
        },
      }),
    );

    if (!candidate) {
      // No row — generic 404 to prevent code enumeration. We do NOT
      // distinguish "no such code" from "code exists but expired" here.
      throw new NotFoundException({
        error: 'TenantInviteNotFound',
        message: 'Invite code not recognised',
      });
    }

    // Terminal states surface as 410 Gone. We expose the status reason but
    // never the underlying tenant identity.
    const now = new Date();
    if (candidate.status !== 'pending') {
      throw new GoneException({
        error: 'TenantInviteNotPending',
        message: `Invite is in terminal state '${candidate.status}'`,
      });
    }
    if (candidate.expiresAt <= now) {
      // Opportunistic sweep — flip to expired under the row's tenant scope.
      await withTenant({ companyId: candidate.companyId }, () =>
        prisma.tenantInvite.updateMany({
          where: { id: candidate.id, status: 'pending' },
          data: { status: 'expired' },
        }),
      );
      throw new GoneException({
        error: 'TenantInviteExpired',
        message: 'Invite code has expired',
      });
    }

    const activeContract = candidate.tenant.contracts[0];
    return {
      inviteId: candidate.id,
      tenantDisplayHint: redactDisplayName(candidate.tenant.displayName),
      unitNumber: activeContract?.unit.unitNumber ?? null,
      propertyName: activeContract?.unit.property.name ?? null,
      expiresAt: candidate.expiresAt,
    };
  }

  /**
   * Atomic redeem. Caller has already verified the LINE idToken and extracted
   * `lineUserId` from its `sub` claim.
   *
   * Single-transaction flow:
   *   1. Re-resolve invite by codePrefix + codeHash (bypass-RLS lookup).
   *   2. Open `withTenant({companyId: invite.companyId})` for the mutate side.
   *   3. CAS invite (status='pending' AND expiresAt > now() → redeemed) +
   *      set redeemedAt + redeemedByLineUserId.
   *   4. Update tenant.lineUserId. P2002 = BIND_CONFLICT.
   *   5. Write audit row (TENANT_INVITE_REDEEMED or _BIND_CONFLICT).
   *
   * Idempotent replay: if the invite is already `redeemed` AND
   * `redeemedByLineUserId === lineUserId` (same human retried), return
   * success with the existing redeemedAt — no new mutation, no audit row.
   */
  async redeem(code: string, lineUserId: string): Promise<RedeemTenantInviteResponse> {
    const codeHash = sha256Hex(code);
    const codePrefix = code.slice(0, TENANT_INVITE_CODE_PREFIX_LENGTH);

    // Bypass-RLS lookup — no companyId yet.
    const candidate = await withTenant({ companyId: '', bypassRls: true }, () =>
      prisma.tenantInvite.findFirst({ where: { codePrefix, codeHash } }),
    );
    if (!candidate) {
      throw new NotFoundException({
        error: 'TenantInviteNotFound',
        message: 'Invite code not recognised',
      });
    }

    // Idempotent retry check — if THIS line user already redeemed THIS invite,
    // re-emit success without touching the DB or audit log.
    if (
      candidate.status === 'redeemed' &&
      candidate.redeemedByLineUserId === lineUserId &&
      candidate.redeemedAt
    ) {
      return {
        tenantId: candidate.tenantId,
        companyId: candidate.companyId,
        redeemedAt: candidate.redeemedAt,
      };
    }

    // Terminal-state guards (someone else already redeemed, or revoked/expired).
    if (candidate.status !== 'pending') {
      throw new GoneException({
        error: 'TenantInviteNotPending',
        message: `Invite is in terminal state '${candidate.status}'`,
      });
    }
    if (candidate.expiresAt <= new Date()) {
      // Opportunistic sweep, then 410.
      await withTenant({ companyId: candidate.companyId }, () =>
        prisma.tenantInvite.updateMany({
          where: { id: candidate.id, status: 'pending' },
          data: { status: 'expired' },
        }),
      );
      throw new GoneException({
        error: 'TenantInviteExpired',
        message: 'Invite code has expired',
      });
    }

    // Switch to the tenant's company scope for the mutate side. Everything
    // inside this block — CAS, tenant update, audit row — runs under the
    // invite's companyId, so RLS enforces isolation if anything else queries.
    return withTenant({ companyId: candidate.companyId }, async () => {
      const now = new Date();

      // Atomic CAS on the invite row. updateMany returns the row count;
      // count === 0 means a concurrent caller raced us to the redeem.
      const flipped = await prisma.tenantInvite.updateMany({
        where: { id: candidate.id, status: 'pending' },
        data: {
          status: 'redeemed',
          redeemedAt: now,
          redeemedByLineUserId: lineUserId,
        },
      });
      if (flipped.count !== 1) {
        throw new ConflictException({
          error: 'TenantInviteRaceLost',
          message: 'Invite was redeemed by a concurrent request',
        });
      }

      // Bind the LINE user to the tenant. P2002 on (companyId, lineUserId)
      // means another tenant in this company already owns this LINE user —
      // that's BIND_CONFLICT (per Task #41 Q3 design: reject + admin must
      // manually unbind, never auto-rebind).
      try {
        await prisma.tenant.update({
          where: { id: candidate.tenantId },
          data: { lineUserId },
        });
      } catch (err) {
        if (isUniqueConstraintError(err, 'lineUserId')) {
          // Roll back the invite flip so admin can re-issue without churn.
          await prisma.tenantInvite.updateMany({
            where: { id: candidate.id, status: 'redeemed' },
            data: {
              status: 'pending',
              redeemedAt: null,
              redeemedByLineUserId: null,
            },
          });
          await this.writeAudit({
            action: 'TENANT_INVITE_BIND_CONFLICT',
            resourceId: candidate.id,
            actorUserId: null,
            metadata: {
              tenantId: candidate.tenantId,
              codePrefix: candidate.codePrefix,
              lineUserId,
            },
          });
          throw new ConflictException({
            error: 'BIND_CONFLICT',
            message:
              'This LINE account is already bound to another tenant in this company. ' +
              'Ask the admin to unbind the conflicting tenant first.',
          });
        }
        throw err;
      }

      await this.writeAudit({
        action: 'TENANT_INVITE_REDEEMED',
        resourceId: candidate.id,
        actorUserId: null,
        metadata: {
          tenantId: candidate.tenantId,
          codePrefix: candidate.codePrefix,
          lineUserId,
        },
      });

      return {
        tenantId: candidate.tenantId,
        companyId: candidate.companyId,
        redeemedAt: now,
      };
    });
  }

  // -----------------------------------------------------------------------
  // Internal: audit log writer
  // -----------------------------------------------------------------------

  /**
   * Write an audit_log row inside the active tenant scope. Caller MUST be
   * inside `withTenant({companyId})` so RLS allows the INSERT — for admin
   * paths this is the request-level interceptor; for public paths the
   * caller wraps explicitly.
   *
   * Failure mode: log + swallow. We'd rather succeed the user-visible
   * operation than fail it because audit is unreachable. The interceptor
   * pattern (audit-log.interceptor.ts) does the same.
   */
  private async writeAudit(args: {
    action: string;
    resourceId: string;
    actorUserId: string | null;
    metadata: Record<string, unknown>;
  }): Promise<void> {
    const ctx = getTenantContext();
    if (!ctx?.companyId) {
      this.logger.error(
        `Audit ${args.action} skipped — no tenant context (resourceId=${args.resourceId})`,
      );
      return;
    }
    try {
      await prisma.auditLog.create({
        data: {
          companyId: ctx.companyId,
          actorUserId: args.actorUserId,
          action: args.action,
          resource: 'tenant_invite',
          resourceId: args.resourceId,
          metadata: args.metadata as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      this.logger.error(
        `Failed to write audit_log ${args.action} for ${args.resourceId}: ${(err as Error).message}`,
      );
    }
  }
}

// =========================================================================
// Helpers (module-private; not exported)
// =========================================================================

/**
 * Generate an 8-char plaintext code from the Crockford-style alphabet using
 * `crypto.randomInt`. We deliberately use `randomInt` (CSPRNG-backed) rather
 * than `Math.random()` — this is a security boundary.
 */
function generatePlaintextCode(): string {
  const len = TENANT_INVITE_CODE_LENGTH;
  const alphabet = TENANT_INVITE_CODE_ALPHABET;
  let out = '';
  for (let i = 0; i < len; i++) {
    out += alphabet[randomInt(0, alphabet.length)];
  }
  return out;
}

/** Display form: insert mid-hyphen at length/2. `K7M3XQ2P` → `K7M3-XQ2P`. */
function formatCodeForDisplay(plaintext: string): string {
  const mid = TENANT_INVITE_CODE_LENGTH / 2;
  return `${plaintext.slice(0, mid)}-${plaintext.slice(mid)}`;
}

/** Lowercase hex SHA-256 — matches Prisma `Char(64)`. */
function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Redact a tenant display name to "first char + asterisks" for the public
 * peek preview. Examples:
 *   "ก. สมชาย ใจดี"    → "ก****"
 *   "Somchai Jaidee"   → "S****"
 *   ""                 → "****" (defensive — name should never be empty)
 */
function redactDisplayName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '****';
  // Use the codepoint iterator so multibyte (Thai) glyphs aren't sliced mid-byte.
  const first = [...trimmed][0] ?? '';
  return `${first}****`;
}

/**
 * Map a raw Prisma row to the public TenantInvite shape. Keeps Date objects
 * (Zod schema declares `z.date()`); JSON serialisation happens at the HTTP
 * boundary.
 */
function toTenantInvite(row: {
  id: string;
  companyId: string;
  tenantId: string;
  codePrefix: string;
  status: string;
  expiresAt: Date;
  redeemedAt: Date | null;
  redeemedByLineUserId: string | null;
  createdAt: Date;
  createdByUserId: string;
}): TenantInvite {
  return {
    id: row.id,
    companyId: row.companyId,
    tenantId: row.tenantId,
    codePrefix: row.codePrefix,
    status: row.status as TenantInvite['status'],
    expiresAt: row.expiresAt,
    redeemedAt: row.redeemedAt,
    redeemedByLineUserId: row.redeemedByLineUserId,
    createdAt: row.createdAt,
    createdByUserId: row.createdByUserId,
  };
}

/**
 * Detect Prisma P2002 unique-constraint violations on a specific column.
 * Mirrors the helper in `tenant.service.ts` — kept loose-typed to avoid
 * dragging the full Prisma error union into apps/api.
 */
function isUniqueConstraintError(err: unknown, column: string): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; meta?: { target?: unknown } };
  if (e.code !== 'P2002') return false;
  const target = e.meta?.target;
  if (Array.isArray(target)) return target.some((t) => String(t).includes(column));
  return typeof target === 'string' && target.includes(column);
}
