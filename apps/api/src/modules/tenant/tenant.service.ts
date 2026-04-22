import { type Prisma, getTenantContext, prisma } from '@dorm/db';
import type {
  CreateTenantInput,
  ListTenantsQuery,
  Tenant,
  UpdateTenantInput,
} from '@dorm/shared/zod';
import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { PiiCryptoService } from '../../common/crypto/pii-crypto.service.js';
import { type CursorPage, buildCursorPage, decodeCursor } from '../../common/util/cursor.util.js';

/**
 * Tenant (LIFF user) lifecycle.
 *
 * Two security layers stack here:
 *   1. RLS scopes every row to the active tenant context (per-table).
 *   2. PII fields (`nationalId`, `phone`) are pgcrypto-encrypted at rest per
 *      CLAUDE.md §3.8. The service encrypts on write, decrypts on read; raw
 *      ciphertext NEVER crosses the API boundary.
 *
 * Listing semantics: tenants come back with PII fields ALREADY DECRYPTED. For
 * a 40-room dorm at 20-per-page this is cheap (one $queryRaw per row, run in
 * parallel). If we ever scale past a few thousand rows, switch to selective
 * field omission on list + decrypt-on-detail only.
 *
 * DELETE is intentionally absent — Tenant cascades into Contract / Invoice /
 * Payment. Use `PATCH { status: "moved_out" }` to retire a tenant; the row
 * stays for audit and historical billing reference.
 */
@Injectable()
export class TenantService {
  constructor(private readonly crypto: PiiCryptoService) {}

  /**
   * Cursor-paginated list with optional `status` filter. AND-combines with
   * the cursor keyset clause so the two never trip over each other.
   */
  async list(query: ListTenantsQuery): Promise<CursorPage<Tenant>> {
    const { cursor, limit, status } = query;
    const decoded = cursor ? decodeCursor(cursor) : null;

    const baseWhere: Prisma.TenantWhereInput = {};
    if (status) baseWhere.status = status;

    const where: Prisma.TenantWhereInput = decoded
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

    const rows = await prisma.tenant.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    // Decrypt PII in parallel. Order is preserved: Promise.all maps the input
    // array index-for-index, so cursor pagination metadata stays consistent.
    const decrypted = await Promise.all(rows.map((r) => this.decryptRow(r)));
    return buildCursorPage(decrypted as unknown as Tenant[], limit);
  }

  async getById(id: string): Promise<Tenant> {
    const row = await prisma.tenant.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`Tenant ${id} not found`);
    return (await this.decryptRow(row)) as unknown as Tenant;
  }

  /**
   * Create a tenant. PII (nationalId/phone) is encrypted BEFORE the INSERT
   * so plaintext never touches the row. The unique `(companyId, lineUserId)`
   * index maps a P2002 → 409 — the same LINE user can only be a tenant once
   * per dorm (a person who lives in two of our managed buildings gets two
   * separate tenant rows, one per company).
   */
  async create(input: CreateTenantInput): Promise<Tenant> {
    const ctx = getTenantContext();
    if (!ctx?.companyId) {
      throw new InternalServerErrorException('Tenant context missing on create');
    }

    const [encNationalId, encPhone] = await Promise.all([
      this.crypto.encrypt(input.nationalId ?? null),
      this.crypto.encrypt(input.phone ?? null),
    ]);

    try {
      const row = await prisma.tenant.create({
        data: {
          companyId: ctx.companyId,
          // Nullable since #41 — admin can pre-create a tenant before the
          // human binds their LINE account via the invite-code flow.
          lineUserId: input.lineUserId ?? null,
          displayName: input.displayName,
          pictureUrl: input.pictureUrl ?? null,
          nationalId: encNationalId,
          phone: encPhone,
        },
      });
      return (await this.decryptRow(row)) as unknown as Tenant;
    } catch (err) {
      if (isUniqueConstraintError(err, 'lineUserId')) {
        throw new ConflictException({
          error: 'TenantLineUserTaken',
          message: `LINE user ${input.lineUserId ?? ''} is already a tenant in this company`,
        });
      }
      throw err;
    }
  }

  /**
   * Partial update. PII fields are encrypted ONLY when the caller explicitly
   * sends them — `undefined` = no-op, so we don't gratuitously re-encrypt
   * unchanged values (which would change the ciphertext on every PATCH and
   * pollute audit diffs).
   */
  async update(id: string, input: UpdateTenantInput): Promise<Tenant> {
    await this.getById(id);

    // Encrypt only the PII fields the caller is changing. The Zod schema
    // (`.optional()`) doesn't allow `null` for these, so we don't need to
    // distinguish "clear" from "no-op" — only "set" vs "no-op".
    const encNationalId =
      input.nationalId !== undefined ? await this.crypto.encrypt(input.nationalId) : undefined;
    const encPhone = input.phone !== undefined ? await this.crypto.encrypt(input.phone) : undefined;

    try {
      const row = await prisma.tenant.update({
        where: { id },
        data: {
          lineUserId: input.lineUserId,
          displayName: input.displayName,
          pictureUrl: input.pictureUrl,
          status: input.status,
          ...(encNationalId !== undefined ? { nationalId: encNationalId } : {}),
          ...(encPhone !== undefined ? { phone: encPhone } : {}),
        },
      });
      return (await this.decryptRow(row)) as unknown as Tenant;
    } catch (err) {
      if (isUniqueConstraintError(err, 'lineUserId')) {
        throw new ConflictException({
          error: 'TenantLineUserTaken',
          message: `LINE user ${input.lineUserId ?? ''} is already a tenant in this company`,
        });
      }
      throw err;
    }
  }

  /**
   * Decrypt a raw DB row's PII fields, returning a row whose `nationalId`
   * and `phone` are plaintext (or null). The shape stays Prisma-friendly so
   * the caller can cast straight to `Tenant`.
   */
  private async decryptRow<T extends { nationalId: string | null; phone: string | null }>(
    row: T,
  ): Promise<T> {
    const [nationalId, phone] = await Promise.all([
      this.crypto.decrypt(row.nationalId),
      this.crypto.decrypt(row.phone),
    ]);
    return { ...row, nationalId, phone };
  }
}

/**
 * Detect Prisma P2002 unique-constraint violations on a specific column.
 * Kept loose-typed so we don't drag the full Prisma error union into apps.
 */
function isUniqueConstraintError(err: unknown, column: string): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; meta?: { target?: unknown } };
  if (e.code !== 'P2002') return false;
  const target = e.meta?.target;
  if (Array.isArray(target)) return target.some((t) => String(t).includes(column));
  return typeof target === 'string' && target.includes(column);
}
