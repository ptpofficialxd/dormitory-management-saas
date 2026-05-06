import {
  type UpsertCompanyLineChannelInput,
  companyLineChannelPublicSchema,
  upsertCompanyLineChannelInputSchema,
} from '@dorm/shared/zod';
import { z } from 'zod';

/**
 * Wire schemas for the per-company LINE OA channel config (Task #109).
 *
 * GET /c/:slug/line-channel returns CompanyLineChannelPublic which
 * intentionally omits the plaintext secret + access token (only exposes
 * `hasChannelSecret` / `hasChannelAccessToken` booleans). The form uses
 * those booleans to render "✓ ตั้งไว้แล้ว" status next to each secret
 * field; the actual values are only ever sent FROM the client TO the
 * server, never the other direction.
 *
 * Date coercion: createdAt + updatedAt are z.date() in shared, so we
 * extend with z.coerce.date() — same pattern as queries/announcements.ts.
 */

export const companyLineChannelPublicWireSchema = companyLineChannelPublicSchema.extend({
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type CompanyLineChannelPublicWire = z.infer<typeof companyLineChannelPublicWireSchema>;

// Re-export the input schema/type so the form + action don't dual-import.
export { upsertCompanyLineChannelInputSchema };
export type { UpsertCompanyLineChannelInput };
