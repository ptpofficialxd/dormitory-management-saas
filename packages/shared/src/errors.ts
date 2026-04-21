/**
 * Typed domain errors — used by the API + services to produce stable error
 * codes that the web-admin and LIFF apps can map to user-facing messages.
 *
 * Design:
 *   - Every domain error extends `DomainError` and carries a stable `code`
 *     (machine-readable) + `message` (human-readable, English).
 *   - `cause` preserves the original throw for debugging — `toJSON()` omits
 *     it on the wire so we don't leak stack traces to clients.
 *   - No runtime dep on NestJS / HTTP — apps wrap these into HTTP responses
 *     via an interceptor.
 */

/** Stable machine-readable error codes. Extend as new domains land. */
export type DomainErrorCode =
  | 'validation_failed'
  | 'tenant_isolation'
  | 'idempotency_conflict'
  | 'not_found'
  | 'unauthorized'
  | 'forbidden'
  | 'payment_already_confirmed'
  | 'slip_already_uploaded'
  | 'contract_overlap'
  | 'meter_reading_out_of_sequence'
  | 'rate_limited'
  | 'external_service'
  | 'internal';

export class DomainError extends Error {
  public readonly code: DomainErrorCode;
  public readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    code: DomainErrorCode,
    message: string,
    details?: Record<string, unknown>,
    cause?: unknown,
  ) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.details = details;
    if (cause !== undefined) {
      // Node 16+ supports `Error.cause` natively — attach via options pattern.
      (this as Error & { cause?: unknown }).cause = cause;
    }
  }

  /** Safe JSON view — omits `cause` to avoid leaking stack traces. */
  toJSON(): { code: DomainErrorCode; message: string; details?: Record<string, unknown> } {
    return {
      code: this.code,
      message: this.message,
      ...(this.details ? { details: { ...this.details } } : {}),
    };
  }
}

// ---- Convenience subclasses — prefer these over constructing DomainError ----

export class ValidationError extends DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('validation_failed', message, details);
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends DomainError {
  constructor(resource: string, id?: string) {
    super('not_found', `${resource} not found${id ? `: ${id}` : ''}`);
    this.name = 'NotFoundError';
  }
}

export class ForbiddenError extends DomainError {
  constructor(message = 'Forbidden') {
    super('forbidden', message);
    this.name = 'ForbiddenError';
  }
}

export class UnauthorizedError extends DomainError {
  constructor(message = 'Unauthorized') {
    super('unauthorized', message);
    this.name = 'UnauthorizedError';
  }
}

export class TenantIsolationError extends DomainError {
  constructor(message = 'Cross-tenant access denied') {
    super('tenant_isolation', message);
    this.name = 'TenantIsolationError';
  }
}

export class IdempotencyConflictError extends DomainError {
  constructor(key: string) {
    super('idempotency_conflict', `Idempotency key already used: ${key}`, { key });
    this.name = 'IdempotencyConflictError';
  }
}

export class RateLimitedError extends DomainError {
  constructor(retryAfterSec: number) {
    super('rate_limited', `Rate limited. Retry after ${retryAfterSec}s.`, { retryAfterSec });
    this.name = 'RateLimitedError';
  }
}

/**
 * Type-guard — useful in HTTP exception filters that want to distinguish
 * domain errors from unexpected throws.
 */
export function isDomainError(err: unknown): err is DomainError {
  return err instanceof DomainError;
}
