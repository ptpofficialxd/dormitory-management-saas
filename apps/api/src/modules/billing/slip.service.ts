import { randomUUID } from 'node:crypto';
import { getTenantContext, prisma } from '@dorm/db';
import type {
  Slip,
  SlipMimeType,
  SlipUploadUrlInput,
  SlipUploadUrlResponse,
  SlipViewUrlResponse,
  UploadSlipInput,
} from '@dorm/shared/zod';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { StorageService } from '../storage/storage.service.js';

/**
 * Slip = a single payment-proof image attached to ONE Payment row
 * (`Slip.paymentId @unique`). Lives in R2 private bucket; clients only
 * ever see it via short-lived signed GET URLs (CLAUDE.md §3.9).
 *
 * Upload flow (3 hops, two HTTP round-trips to our API):
 *
 *   1. Client → POST /payments/:paymentId/slip/upload-url
 *      with { mimeType, sizeBytes }
 *      → server mints presigned PUT URL + deterministic r2ObjectKey
 *      → response { url, r2ObjectKey, expiresAt }
 *
 *   2. Client → PUT <url> (raw bytes, direct to R2)
 *      Headers: Content-Type=<mimeType>, Content-Length=<sizeBytes>
 *      (both signed into URL — R2 rejects mismatch with 403)
 *
 *   3. Client → POST /payments/:paymentId/slip
 *      with { r2ObjectKey, mimeType, sizeBytes, sha256 }
 *      → server HEADs R2 to confirm bytes landed + size matches
 *      → server inserts Slip row
 *
 * Why 3 hops vs. one streaming POST through the API:
 *   - Slips are up to 10 MiB. Streaming through NestJS means the file
 *     bytes hit our heap + we proxy them to R2 — wastes RAM + adds a
 *     hop. Direct-to-R2 PUTs keep the API thin.
 *   - The presigned URL bakes in `Content-Length` and `Content-Type`,
 *     so the client cannot tamper with size after URL minting.
 *
 * Security model:
 *   - `r2ObjectKey` is server-generated in step 1 with the deterministic
 *     prefix `companies/{companyId}/slips/{paymentId}/{uuid}.{ext}`.
 *     The register call (step 3) re-validates the prefix matches the
 *     companyId on the Payment row — so even if the client tampers with
 *     the echoed key, they can't reach into another tenant's namespace.
 *   - `sha256` is stored unverified — verifying would mean streaming the
 *     object back from R2 just to hash it. Deferred to Phase 1 fraud-
 *     review; for now it powers the fraud-detection index (same hash
 *     submitted for two payments → flag).
 *   - Magic-byte verification of the actual uploaded bytes (CLAUDE.md
 *     §7) is also Phase 1 — MVP relies on R2 signed-URL Content-Type
 *     enforcement + explicit MIME whitelist at the boundary.
 *
 * Idempotency:
 *   - Slip has `paymentId @unique`, so a second register attempt for
 *     the same payment hits P2002. We don't return-on-replay here
 *     (unlike Payment) — re-uploading a slip means correcting it, and
 *     the manager flow is "reject the payment, tenant uploads new".
 *     409 surfaces that explicitly.
 */
@Injectable()
export class SlipService {
  constructor(private readonly storage: StorageService) {}

  // ---------------------------------------------------------------
  // Upload-URL — step 1 of the 3-hop flow
  // ---------------------------------------------------------------

  /**
   * Mint a short-lived presigned PUT URL the client uploads directly to.
   *
   * Pre-flight checks (cheap, before we touch R2):
   *   - Payment must exist + be visible (RLS) and be in `pending` status.
   *     Confirmed/rejected payments shouldn't take new slips — the slip
   *     gets stale + confuses the audit trail.
   *   - Payment must NOT already have a slip — re-upload requires a
   *     fresh payment per the "reject + re-create" flow.
   */
  async createUploadUrl(
    paymentId: string,
    input: SlipUploadUrlInput,
  ): Promise<SlipUploadUrlResponse> {
    const ctx = getTenantContext();
    if (!ctx?.companyId) {
      throw new InternalServerErrorException('Tenant context missing on slip upload-url');
    }

    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      select: { id: true, companyId: true, status: true, slip: { select: { id: true } } },
    });
    if (!payment) {
      throw new NotFoundException(`Payment ${paymentId} not found`);
    }
    if (payment.status !== 'pending') {
      throw new ConflictException({
        error: 'PaymentNotPending',
        message: `Cannot attach a slip to a ${payment.status} payment`,
      });
    }
    if (payment.slip) {
      throw new ConflictException({
        error: 'SlipAlreadyExists',
        message:
          'A slip is already attached to this payment — reject the payment and create a new one to re-upload',
      });
    }

    const r2ObjectKey = buildSlipKey({
      companyId: payment.companyId,
      paymentId: payment.id,
      mimeType: input.mimeType,
    });

    const signed = await this.storage.generateUploadUrl({
      key: r2ObjectKey,
      contentType: input.mimeType,
      contentLength: input.sizeBytes,
      // No explicit `expiresIn` — defaults to env.R2_SIGNED_URL_TTL (5 min);
      // StorageService also clamps to ≤ 1 hr defensively.
    });

    return {
      url: signed.url,
      r2ObjectKey,
      expiresAt: signed.expiresAt.toISOString(),
    };
  }

  // ---------------------------------------------------------------
  // Register — step 3 of the 3-hop flow
  // ---------------------------------------------------------------

  /**
   * Persist the Slip row AFTER the client has uploaded raw bytes to R2.
   *
   * Validates (in order, fail-fast):
   *   1. Payment exists + visible + still `pending` + no existing slip
   *      (the upload-url checks could have raced — re-check here).
   *   2. `r2ObjectKey` prefix matches `companies/{companyId}/slips/{paymentId}/`
   *      — defends against a tampered echo from the client.
   *   3. R2 HEAD confirms the object actually exists at that key.
   *   4. R2-reported `ContentLength` matches `input.sizeBytes` (the
   *      client could have lied about the size when minting the URL,
   *      but R2 would have rejected the PUT — this is the belt to that
   *      suspenders).
   *
   * On P2002 (`Slip.paymentId @unique`): 409 — race-window protection.
   */
  async register(paymentId: string, input: UploadSlipInput): Promise<Slip> {
    const ctx = getTenantContext();
    if (!ctx?.companyId) {
      throw new InternalServerErrorException('Tenant context missing on slip register');
    }

    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      select: { id: true, companyId: true, status: true, slip: { select: { id: true } } },
    });
    if (!payment) {
      throw new NotFoundException(`Payment ${paymentId} not found`);
    }
    if (payment.status !== 'pending') {
      throw new ConflictException({
        error: 'PaymentNotPending',
        message: `Cannot attach a slip to a ${payment.status} payment`,
      });
    }
    if (payment.slip) {
      throw new ConflictException({
        error: 'SlipAlreadyExists',
        message:
          'A slip is already attached to this payment — reject the payment and create a new one to re-upload',
      });
    }

    // r2ObjectKey prefix guard — the client echoed it back from
    // upload-url, but a tampered key targeting another tenant's
    // namespace must NOT be accepted.
    const expectedPrefix = `companies/${payment.companyId}/slips/${payment.id}/`;
    if (!input.r2ObjectKey.startsWith(expectedPrefix)) {
      throw new BadRequestException({
        error: 'InvalidR2ObjectKey',
        message: 'r2ObjectKey does not match the expected prefix for this payment',
      });
    }

    // HEAD R2 — confirms the bytes actually landed AND lets us cross-
    // check size. We deliberately don't try to verify SHA-256 here
    // (would require streaming the object back).
    const head = await this.storage.headObject(input.r2ObjectKey);
    if (!head) {
      throw new BadRequestException({
        error: 'SlipNotUploaded',
        message: 'No object found at the given r2ObjectKey — upload may have failed',
      });
    }
    if (head.contentLength !== undefined && head.contentLength !== input.sizeBytes) {
      throw new BadRequestException({
        error: 'SlipSizeMismatch',
        message: `R2 reports ${head.contentLength} bytes; client claimed ${input.sizeBytes}`,
      });
    }

    try {
      const row = await prisma.slip.create({
        data: {
          companyId: payment.companyId,
          paymentId: payment.id,
          r2ObjectKey: input.r2ObjectKey,
          mimeType: input.mimeType,
          sizeBytes: input.sizeBytes,
          sha256: input.sha256,
        },
      });
      return row as unknown as Slip;
    } catch (err) {
      // Race-window: a parallel register call beat us to it. Surface
      // 409 so the client knows there's already a slip and can reload.
      if (isUniqueConstraintError(err, 'payment_id')) {
        throw new ConflictException({
          error: 'SlipAlreadyExists',
          message: 'A slip was registered for this payment by a concurrent request',
        });
      }
      throw err;
    }
  }

  // ---------------------------------------------------------------
  // View URL — short-lived signed GET for admin/LIFF preview
  // ---------------------------------------------------------------

  async getViewUrl(slipId: string): Promise<SlipViewUrlResponse> {
    const slip = await prisma.slip.findUnique({
      where: { id: slipId },
      select: { id: true, r2ObjectKey: true },
    });
    if (!slip) {
      throw new NotFoundException(`Slip ${slipId} not found`);
    }

    const signed = await this.storage.generateDownloadUrl({ key: slip.r2ObjectKey });
    return {
      url: signed.url,
      expiresAt: signed.expiresAt.toISOString(),
    };
  }

  /**
   * Tenant-scoped variant for the LIFF `/me/slips/:id/view-url` route.
   * Joins through the Payment row to enforce ownership: a slip is "owned"
   * by tenant T iff the payment it's attached to has `tenantId = T`.
   *
   * 404 (NEVER 403) on cross-tenant probes — same posture as the other
   * `*ForTenant` helpers. RLS already filters by companyId; this filter
   * handles same-company cross-tenant access.
   */
  async getViewUrlForTenant(slipId: string, tenantId: string): Promise<SlipViewUrlResponse> {
    const slip = await prisma.slip.findFirst({
      where: { id: slipId, payment: { tenantId } },
      select: { id: true, r2ObjectKey: true },
    });
    if (!slip) {
      throw new NotFoundException(`Slip ${slipId} not found`);
    }

    const signed = await this.storage.generateDownloadUrl({ key: slip.r2ObjectKey });
    return {
      url: signed.url,
      expiresAt: signed.expiresAt.toISOString(),
    };
  }

  // ---------------------------------------------------------------
  // Read paths
  // ---------------------------------------------------------------

  async getById(id: string): Promise<Slip> {
    const row = await prisma.slip.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`Slip ${id} not found`);
    return row as unknown as Slip;
  }

  /** Returns the (at-most-one) slip for a payment, or 404 if none. */
  async getByPaymentId(paymentId: string): Promise<Slip> {
    const row = await prisma.slip.findUnique({ where: { paymentId } });
    if (!row) throw new NotFoundException(`No slip found for payment ${paymentId}`);
    return row as unknown as Slip;
  }
}

/**
 * Map a slip MIME type to the canonical filename extension we use in the
 * R2 object key. Keeps the key human-debuggable (`...x.jpg` not `...x.bin`)
 * and lets a future CDN content-type sniffer work without the mime db.
 */
function extensionForMimeType(mime: SlipMimeType): string {
  switch (mime) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    case 'application/pdf':
      return 'pdf';
  }
}

/**
 * Build the R2 object key for a slip. Schema:
 *   `companies/{companyId}/slips/{paymentId}/{uuid}.{ext}`
 * The `{uuid}` segment guards against a future "re-upload after reject"
 * flow colliding on key — every key is unique even if paymentId repeats.
 */
function buildSlipKey(args: {
  companyId: string;
  paymentId: string;
  mimeType: SlipMimeType;
}): string {
  const ext = extensionForMimeType(args.mimeType);
  return `companies/${args.companyId}/slips/${args.paymentId}/${randomUUID()}.${ext}`;
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
