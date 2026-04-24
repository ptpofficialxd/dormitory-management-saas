import { SetMetadata } from '@nestjs/common';

/**
 * Metadata key checked by `JwtGuard`. When present, the guard verifies the
 * bearer token via `JwtService.verifyTenantToken()` (LIFF audience, `typ:'liff'`)
 * instead of the default admin verifier.
 *
 * Apply to controllers that handle `/me/*` LIFF traffic. The matching
 * `@CurrentTenant()` decorator extracts the resulting `TenantJwtClaims`
 * from `request.user`.
 *
 * Example:
 *   @TenantAuth()
 *   @Controller('/me/invoices')
 *   export class TenantInvoiceController {
 *     @Get()
 *     list(@CurrentTenant() tenant: TenantJwtClaims) { ... }
 *   }
 *
 * Why a metadata flag (vs. a separate Nest module / guard hierarchy)?
 * Keeps the guard pipeline single-pass — every request flows through the
 * same `JwtGuard`, just with a branch on the route's intent. Avoids the
 * ordering pitfalls that come with `@UseGuards()`-based stacking.
 */
export const IS_TENANT_AUTH_KEY = 'isTenantAuth';
export const TenantAuth = (): MethodDecorator & ClassDecorator =>
  SetMetadata(IS_TENANT_AUTH_KEY, true);
