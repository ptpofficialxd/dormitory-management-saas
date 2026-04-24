import { z } from 'zod';
import { env } from '../env.js';
import { clearTenantToken } from './tenant-token.js';

/**
 * API client for the LIFF tenant app. Thin wrapper around `fetch` that:
 *
 * 1. Joins the path against `VITE_API_BASE_URL`.
 * 2. Always sends/receives JSON.
 * 3. Optionally injects `Authorization: Bearer <token>` for /me/* routes.
 * 4. Optionally injects `Idempotency-Key` for mutations that require it
 *    (POST /me/payments per CLAUDE.md §3 #10).
 * 5. Parses the GlobalExceptionFilter envelope on non-2xx and throws a
 *    typed `ApiError` with the server's `error` code + `message`.
 * 6. Validates the success body against a Zod schema (caller-supplied) so
 *    a bad server response surfaces as a parse error, not a runtime crash
 *    inside a component.
 *
 * 401 handling: any `UnauthorizedException` from a `/me/*` route clears
 * the stored tenant token. The hook layer (useTenantSession) detects the
 * absence on next render and triggers a fresh /me/auth/exchange.
 *
 * Error contract from the backend (see apps/api GlobalExceptionFilter):
 *
 *   {
 *     statusCode: number,
 *     error: string,         // e.g. 'BIND_CONFLICT', 'INVALID_LINE_ID_TOKEN'
 *     message: string,
 *     path: string,
 *     timestamp: string,
 *   }
 */

/** Stable, machine-readable error codes the LIFF UI branches on. */
export type ApiErrorCode =
  | 'INVALID_LINE_ID_TOKEN'
  | 'BIND_CONFLICT'
  | 'TenantInviteNotFound'
  | 'TenantInviteNotPending'
  | 'TenantInviteExpired'
  | 'TenantInviteRaceLost'
  | 'NotFoundException'
  | 'ConflictException'
  | 'GoneException'
  | 'BadRequestException'
  | 'UnauthorizedException'
  | 'InternalServerError'
  | 'IdempotencyKeyRequired'
  | 'InvalidInvoiceId'
  | 'NetworkError'
  | 'ResponseShapeMismatch'
  | 'Unknown';

export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: ApiErrorCode | string,
    message: string,
    public readonly path?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const errorEnvelopeSchema = z.object({
  statusCode: z.number(),
  error: z.string(),
  message: z.union([z.string(), z.array(z.unknown()), z.record(z.unknown())]),
  path: z.string().optional(),
});

export interface ApiOpts {
  /** Bearer token for /me/* routes. Pulled from sessionStorage by callers. */
  token?: string;
  /** DB-enforced unique per CLAUDE.md §3 #10 (POST /me/payments). */
  idempotencyKey?: string;
}

async function request<T>(
  method: 'GET' | 'POST',
  path: string,
  body: unknown,
  schema: z.ZodType<T>,
  opts: ApiOpts = {},
): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;

  let response: Response;
  try {
    response = await fetch(`${env.VITE_API_BASE_URL}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'omit',
    });
  } catch (err) {
    throw new ApiError(0, 'NetworkError', (err as Error).message ?? 'Network error');
  }

  const rawText = await response.text();
  let parsed: unknown = null;
  if (rawText) {
    try {
      parsed = JSON.parse(rawText);
    } catch {
      throw new ApiError(
        response.status,
        'ResponseShapeMismatch',
        `Server returned non-JSON (status=${response.status})`,
        path,
      );
    }
  }

  if (!response.ok) {
    // 401 on a token-bearing request → drop the stored token so the next
    // useTenantSession render triggers a fresh exchange. We don't auto-
    // retry here — that's the hook's job (it has the LIFF idToken).
    if (response.status === 401 && opts.token) {
      clearTenantToken();
    }
    const envelope = errorEnvelopeSchema.safeParse(parsed);
    if (envelope.success) {
      const msg =
        typeof envelope.data.message === 'string' ? envelope.data.message : 'Request failed';
      throw new ApiError(envelope.data.statusCode, envelope.data.error, msg, envelope.data.path);
    }
    throw new ApiError(
      response.status,
      'Unknown',
      `Request failed (status=${response.status})`,
      path,
    );
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    console.error('[api] response shape mismatch:', result.error.flatten());
    throw new ApiError(
      response.status,
      'ResponseShapeMismatch',
      'Server response did not match the expected shape',
      path,
    );
  }
  return result.data;
}

/**
 * GET `path` and parse the response. Use for /me/invoices, /me/payments, ...
 *
 * @param path  Path joined against `VITE_API_BASE_URL` — must start with `/`.
 *              Append your own query string for filters/cursor.
 * @param schema Wire-side Zod schema (use z.coerce.date() for ISO strings).
 * @param opts  `token` for Bearer auth; query strings live in `path`.
 */
export function apiGet<T>(path: string, schema: z.ZodType<T>, opts?: ApiOpts): Promise<T> {
  return request('GET', path, undefined, schema, opts);
}

/**
 * POST a JSON body to `path` and return the parsed response.
 *
 * @param path  Path joined against `VITE_API_BASE_URL` — must start with `/`.
 * @param body  Plain object; serialised to JSON.
 * @param schema Wire-side Zod schema.
 * @param opts  `token` for Bearer auth; `idempotencyKey` for POST /me/payments.
 */
export function apiPost<T>(
  path: string,
  body: unknown,
  schema: z.ZodType<T>,
  opts?: ApiOpts,
): Promise<T> {
  return request('POST', path, body, schema, opts);
}
