import { getTenantContext, prisma, withTenant } from '@dorm/db';
import type {
  CompanyLineChannel,
  CompanyLineChannelPublic,
  UpsertCompanyLineChannelInput,
} from '@dorm/shared/zod';
import { Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { PiiCryptoService } from '../../common/crypto/pii-crypto.service.js';

/**
 * CompanyLineChannel lifecycle.
 *
 * Two distinct caller paths:
 *
 *   1. Admin path (RLS-scoped). `getForCurrentCompany()` and `upsert()` run
 *      inside the normal `withTenant({ companyId })` boundary set by
 *      `TenantContextInterceptor`, so RLS auto-filters by `companyId`.
 *
 *   2. Webhook bootstrap path (bypass RLS). `findByChannelIdUnscoped()` is
 *      called BEFORE we know which company owns the request — LINE's POST
 *      to `/webhooks/line/:channelId` carries no tenant hint. We open a
 *      `withTenant({ companyId: '', bypassRls: true })` boundary just for
 *      the lookup, then the webhook controller switches into the resolved
 *      tenant scope for the actual event processing.
 *
 * Secrets are pgcrypto-encrypted at rest (same pattern as `tenant.phone` /
 * `tenant.nationalId`). The service decrypts on read for internal callers
 * (webhook signature verify) and projects to the public-safe view for
 * admin responses.
 */
@Injectable()
export class CompanyLineChannelService {
  constructor(private readonly crypto: PiiCryptoService) {}

  // ---------------------------------------------------------------------
  // Admin (RLS-scoped) reads/writes
  // ---------------------------------------------------------------------

  /**
   * Fetch the channel for the active tenant context — admin settings page.
   * Returns the PUBLIC view (no secrets). Throws 404 if not configured yet.
   */
  async getForCurrentCompany(): Promise<CompanyLineChannelPublic> {
    const ctx = getTenantContext();
    if (!ctx?.companyId) {
      throw new InternalServerErrorException('Tenant context missing on getForCurrentCompany');
    }

    const row = await prisma.companyLineChannel.findUnique({
      where: { companyId: ctx.companyId },
    });
    if (!row) {
      throw new NotFoundException({
        error: 'CompanyLineChannelNotConfigured',
        message: 'No LINE channel is configured for this company yet',
      });
    }
    return toPublicView(row);
  }

  /**
   * Upsert (create-or-replace) — single endpoint for the admin settings
   * form. UPSERT semantics suit the rotation flow: when LINE issues new
   * credentials, the admin re-pastes everything in one shot.
   *
   * Secrets are encrypted BEFORE the INSERT/UPDATE so plaintext never
   * touches the row. We always re-encrypt on every upsert call — the
   * caller is providing fresh values they expect to take effect.
   */
  async upsert(input: UpsertCompanyLineChannelInput): Promise<CompanyLineChannelPublic> {
    const ctx = getTenantContext();
    if (!ctx?.companyId) {
      throw new InternalServerErrorException('Tenant context missing on upsert');
    }

    const [encSecret, encToken] = await Promise.all([
      this.crypto.encrypt(input.channelSecret),
      this.crypto.encrypt(input.channelAccessToken),
    ]);
    if (!encSecret || !encToken) {
      // PiiCryptoService only returns null for null/undefined input, neither
      // of which we just passed in — defensive guard for the type narrowing.
      throw new InternalServerErrorException('Failed to encrypt LINE credentials');
    }

    const row = await prisma.companyLineChannel.upsert({
      where: { companyId: ctx.companyId },
      create: {
        companyId: ctx.companyId,
        channelId: input.channelId,
        channelSecret: encSecret,
        channelAccessToken: encToken,
        basicId: input.basicId ?? null,
        displayName: input.displayName ?? null,
      },
      update: {
        channelId: input.channelId,
        channelSecret: encSecret,
        channelAccessToken: encToken,
        basicId: input.basicId ?? null,
        displayName: input.displayName ?? null,
      },
    });

    return toPublicView(row);
  }

  // ---------------------------------------------------------------------
  // Webhook bootstrap (BYPASS RLS — used by LINE webhook controller)
  // ---------------------------------------------------------------------

  /**
   * Resolve a channelId → company config WITHOUT a pre-existing tenant
   * context. Opens its OWN `withTenant({ bypassRls: true })` boundary
   * because LINE servers don't carry our JWT and there is no other way
   * to know which `companyId` to scope to before this lookup.
   *
   * Returns the DECRYPTED channel (including secret + access token) so
   * the webhook controller can:
   *   - HMAC-verify the request body with `channelSecret`
   *   - Push/reply via Messaging API with `channelAccessToken`
   *
   * The bypass scope is intentionally minimal: only this single SELECT.
   * The webhook controller MUST switch to `withTenant({ companyId })`
   * for any subsequent work (event persistence, tenant binding, etc.)
   * so RLS resumes enforcing isolation.
   *
   * Returns `null` (NOT throws) when no row matches — the controller
   * decides whether to log + 404 or quietly ack a misrouted request.
   */
  async findByChannelIdUnscoped(channelId: string): Promise<CompanyLineChannel | null> {
    const row = await withTenant({ companyId: '', bypassRls: true }, () =>
      prisma.companyLineChannel.findUnique({ where: { channelId } }),
    );
    if (!row) return null;

    const [channelSecret, channelAccessToken] = await Promise.all([
      this.crypto.decrypt(row.channelSecret),
      this.crypto.decrypt(row.channelAccessToken),
    ]);
    if (!channelSecret || !channelAccessToken) {
      // A row exists but its ciphertext failed to decrypt — most likely
      // the PII_ENCRYPTION_KEY was rotated and migrations weren't run.
      // Fail loud rather than serve a half-broken channel.
      throw new InternalServerErrorException(
        `LINE channel ${channelId} is configured but its credentials failed to decrypt`,
      );
    }

    return {
      ...row,
      channelSecret,
      channelAccessToken,
    } as unknown as CompanyLineChannel;
  }
}

/**
 * Project a raw DB row to the browser-safe view. NEVER returns the
 * secret or access-token plaintext. Booleans tell the UI whether the
 * field is configured so it can render "Configured" badges or
 * "Set me up" CTAs without leaking the value.
 */
function toPublicView(row: {
  id: string;
  companyId: string;
  channelId: string;
  channelSecret: string | null;
  channelAccessToken: string | null;
  basicId: string | null;
  displayName: string | null;
  createdAt: Date;
  updatedAt: Date;
}): CompanyLineChannelPublic {
  return {
    id: row.id,
    companyId: row.companyId,
    channelId: row.channelId,
    basicId: row.basicId,
    displayName: row.displayName,
    hasChannelSecret: row.channelSecret !== null && row.channelSecret.length > 0,
    hasChannelAccessToken: row.channelAccessToken !== null && row.channelAccessToken.length > 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
