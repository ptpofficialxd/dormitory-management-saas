import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable, Logger } from '@nestjs/common';
import { env } from '../../config/env.js';

/**
 * Upper bounds on per-call TTL overrides. Keeps callers from accidentally
 * minting week-long URLs that leak through logs / screenshots. 1 hour is
 * plenty for a tenant to complete a slip upload on flaky mobile; anything
 * longer is a smell.
 */
const MAX_SIGNED_URL_TTL_SECONDS = 3600;

/**
 * Hard TTL cap for ID-card images per CLAUDE.md §9. Callers that upload or
 * fetch identity documents MUST pass `expiresIn ≤ ID_CARD_MAX_TTL_SECONDS`;
 * the service does not (and cannot) infer "is this an ID card" from the key
 * alone, so enforcement lives in the caller (e.g. TenantService).
 */
export const ID_CARD_MAX_TTL_SECONDS = 300;

export interface SignedUrl {
  /** The presigned URL. Treat as a secret — contains a signature. */
  url: string;
  /** Absolute wall-clock expiry. Useful for returning to the client UI. */
  expiresAt: Date;
}

export interface HeadObjectResult {
  contentType: string | undefined;
  contentLength: number | undefined;
  etag: string | undefined;
}

/**
 * Thin wrapper around the S3 SDK pointed at Cloudflare R2.
 *
 * Why S3 SDK and not a dedicated R2 client:
 *   R2 is strict-S3-compatible for the operations we need (PUT / GET / HEAD /
 *   DELETE + presigning), and the official `@aws-sdk/client-s3` ships the
 *   SigV4 presigner we'd otherwise hand-roll. `region: 'auto'` is the R2
 *   convention — SigV4 needs *some* region in the canonical string, and R2
 *   rejects anything else.
 *
 * Why NOT a public bucket + CDN for slip/ID card/meter photo:
 *   Slips and ID cards contain PII + financial info. Public URLs defeat
 *   access control entirely. Signed URLs with ≤5 min TTL (CLAUDE.md §9)
 *   give us auditable, time-boxed access — a leaked URL is useless in an
 *   hour. `R2_PUBLIC_URL` is reserved for non-sensitive assets (company
 *   logos) that may surface later.
 *
 * Key naming is the caller's responsibility. Conventions enforced elsewhere:
 *   - Slip:         `companies/{companyId}/slips/{paymentId}/{uuid}.{ext}`
 *   - Reading photo `companies/{companyId}/readings/{readingId}/{uuid}.jpg`
 *   - ID card:      `companies/{companyId}/tenants/{tenantId}/id-card/{uuid}`
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly defaultTtl: number;

  constructor() {
    this.client = new S3Client({
      region: 'auto',
      endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      },
      // R2 requires path-style ("endpoint/bucket/key") addressing; virtual-
      // hosted-style ("bucket.endpoint/key") returns DNS errors.
      forcePathStyle: true,
    });
    this.bucket = env.R2_BUCKET;
    this.defaultTtl = env.R2_SIGNED_URL_TTL;
  }

  /**
   * Mint a short-lived PUT URL the client can upload directly to — removes
   * a proxy hop through our API for multi-MB files and keeps slip bytes off
   * the NestJS heap entirely.
   *
   * `contentType` and `contentLength` are signed into the URL, so the
   * client MUST send matching headers or R2 rejects with 403. This is the
   * mechanism we use to enforce the 10 MiB slip size cap without trusting
   * the client: caller supplies `contentLength` from the validated Zod
   * input, the browser can't tamper with it after signing.
   */
  async generateUploadUrl(params: {
    key: string;
    contentType: string;
    contentLength?: number;
    expiresIn?: number;
  }): Promise<SignedUrl> {
    const expiresIn = this.clampTtl(params.expiresIn ?? this.defaultTtl);
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: params.key,
      ContentType: params.contentType,
      ContentLength: params.contentLength,
    });
    const url = await getSignedUrl(this.client, command, { expiresIn });
    return {
      url,
      expiresAt: new Date(Date.now() + expiresIn * 1000),
    };
  }

  /**
   * Mint a short-lived GET URL for private assets (slip view, ID card
   * preview). Default TTL comes from `R2_SIGNED_URL_TTL` (5 min). For ID
   * card specifically, caller MUST pass `expiresIn ≤ ID_CARD_MAX_TTL_SECONDS`.
   */
  async generateDownloadUrl(params: { key: string; expiresIn?: number }): Promise<SignedUrl> {
    const expiresIn = this.clampTtl(params.expiresIn ?? this.defaultTtl);
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: params.key,
    });
    const url = await getSignedUrl(this.client, command, { expiresIn });
    return {
      url,
      expiresAt: new Date(Date.now() + expiresIn * 1000),
    };
  }

  /**
   * HEAD check — used after client upload to verify the object actually
   * exists and matches declared size/type before we persist a Slip row.
   * Returns `null` on 404 so callers can 404-handle without catching.
   */
  async headObject(key: string): Promise<HeadObjectResult | null> {
    try {
      const resp = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return {
        contentType: resp.ContentType,
        contentLength: resp.ContentLength,
        etag: resp.ETag,
      };
    } catch (err: unknown) {
      if (this.isNotFoundError(err)) return null;
      throw err;
    }
  }

  /**
   * Hard delete. Used for:
   *   - Tenant move-out (delete ID card + contract photos per PDPA DSR)
   *   - Slip rejection cleanup (orphan slip bytes after manager rejects)
   * R2 is eventually consistent for reads-after-delete; callers should not
   * immediately re-HEAD expecting 404.
   */
  async deleteObject(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  private clampTtl(requested: number): number {
    if (requested < 30) {
      this.logger.warn(`Signed URL TTL ${requested}s is too short; clamping to 30s`);
      return 30;
    }
    if (requested > MAX_SIGNED_URL_TTL_SECONDS) {
      this.logger.warn(
        `Signed URL TTL ${requested}s exceeds cap; clamping to ${MAX_SIGNED_URL_TTL_SECONDS}s`,
      );
      return MAX_SIGNED_URL_TTL_SECONDS;
    }
    return requested;
  }

  private isNotFoundError(err: unknown): boolean {
    if (typeof err !== 'object' || err === null) return false;
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    return e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404;
  }
}
