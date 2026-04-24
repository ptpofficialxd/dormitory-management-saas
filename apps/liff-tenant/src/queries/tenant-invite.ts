import {
  type PeekTenantInviteInput,
  type RedeemTenantInviteInput,
  peekTenantInviteInputSchema,
  redeemTenantInviteInputSchema,
} from '@dorm/shared/zod';
import { useMutation } from '@tanstack/react-query';
import { z } from 'zod';
import { type ApiError, apiPost } from '../lib/api.js';
import { writeTenantToken } from '../lib/tenant-token.js';

/**
 * WIRE schemas — over-the-wire JSON has Date as ISO string, so we re-derive
 * the response schemas with `z.coerce.date()` instead of the server's
 * `z.date()`. Keeping them local avoids polluting `@dorm/shared` with
 * client-only date coercion.
 *
 * The structural shape MUST match `tenantInvitePreviewSchema` and
 * `redeemTenantInviteResponseSchema` from @dorm/shared/zod.
 */

const tenantInvitePreviewWireSchema = z.object({
  inviteId: z.string().uuid(),
  tenantDisplayHint: z.string().min(1).max(64),
  unitNumber: z.string().min(1).max(32).nullable(),
  propertyName: z.string().min(1).max(128).nullable(),
  expiresAt: z.coerce.date(),
});
export type TenantInvitePreview = z.infer<typeof tenantInvitePreviewWireSchema>;

const tenantAuthTokenWireSchema = z.object({
  accessToken: z.string().min(16),
  accessTokenExpiresAt: z.number().int(),
});

const redeemTenantInviteWireResponseSchema = z.object({
  tenantId: z.string().uuid(),
  companyId: z.string().uuid(),
  companySlug: z.string().min(1),
  redeemedAt: z.coerce.date(),
  // Optional — server bakes a fresh tenant JWT into the response on first
  // bind for a one-step redirect into /me/* routes (Task #75 UX optim).
  // Absence is non-fatal; useTenantSession exchanges via /me/auth/exchange.
  token: tenantAuthTokenWireSchema.optional(),
});
export type RedeemTenantInviteResponse = z.infer<typeof redeemTenantInviteWireResponseSchema>;

// -------------------------------------------------------------------------
// Hooks
// -------------------------------------------------------------------------

/**
 * usePeekInvite — POST /liff/invites/peek
 *
 * Validates the input through the SAME schema the server uses, then calls
 * the public peek endpoint. The mutation result is the redacted preview so
 * the LIFF UI can render "ผูกบัญชีกับ ก**** ห้อง 305 ที่อาคาร A?".
 *
 * No retry on the mutation — peek is read-only but a 410/404 means the
 * invite is gone and retrying won't help. The only retry-worthy case is
 * a transient NetworkError, which the user can resolve by tapping again.
 */
export function usePeekInvite() {
  return useMutation<TenantInvitePreview, ApiError, PeekTenantInviteInput>({
    mutationKey: ['tenant-invite', 'peek'],
    mutationFn: async (input) => {
      // Server-side parsing happens too, but a client-side parse gives
      // us cleaner error messages (e.g. "code must be 8 chars") before
      // burning a network round-trip.
      const parsed = peekTenantInviteInputSchema.parse(input);
      return apiPost('/liff/invites/peek', parsed, tenantInvitePreviewWireSchema);
    },
  });
}

/**
 * useRedeemInvite — POST /liff/invites/redeem
 *
 * Server verifies `lineIdToken` against LINE's verify endpoint, atomically
 * CAS-flips the invite to redeemed, binds the tenant to `lineUserId`, and
 * (per Task #75) bakes a fresh tenant JWT into the response. We persist
 * that token to sessionStorage on success so the very next /me/* render
 * already has Bearer auth — no /me/auth/exchange round-trip needed for
 * first-time bind.
 *
 * Possible terminal errors (mapped to ApiError.code):
 *   - INVALID_LINE_ID_TOKEN  → idToken bad/expired/aud-mismatch (401)
 *   - BIND_CONFLICT          → lineUserId already bound to another tenant (409)
 *   - TenantInviteRaceLost   → concurrent redeem won (409)
 *   - TenantInviteNotPending → already redeemed/revoked (410)
 *   - TenantInviteExpired    → TTL elapsed (410)
 *   - TenantInviteNotFound   → code not recognised (404)
 *
 * The bind-page maps these to Thai user-facing copy.
 */
export function useRedeemInvite() {
  return useMutation<RedeemTenantInviteResponse, ApiError, RedeemTenantInviteInput>({
    mutationKey: ['tenant-invite', 'redeem'],
    mutationFn: async (input) => {
      const parsed = redeemTenantInviteInputSchema.parse(input);
      return apiPost('/liff/invites/redeem', parsed, redeemTenantInviteWireResponseSchema);
    },
    onSuccess: (data) => {
      // First-time-bind UX optim — server-baked token may be absent on
      // older deploys or test fixtures. Falling through is fine: the next
      // /me/* render goes through useTenantSession which exchanges via
      // /me/auth/exchange.
      if (data.token) {
        writeTenantToken(data.token);
      }
    },
  });
}
