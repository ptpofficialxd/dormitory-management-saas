import 'server-only';
import type { z } from 'zod';
import { env } from './env';

/**
 * Server-side API client for the admin web. Mirrors the LIFF tenant client
 * pattern (`apps/liff-tenant/src/lib/api.ts`) but lives on the server so the
 * JWT cookie never reaches the browser.
 *
 * Usage:
 *   - Call from Server Components, Server Actions, or Route Handlers.
 *   - Pass `token` from `cookies().get('auth_token')` (do NOT read cookies
 *     in here directly so this stays unit-testable without a request scope).
 *
 * Error contract from the backend (GlobalExceptionFilter envelope):
 *   { statusCode, error, message, path, timestamp }
 */

export type ApiErrorCode =
  | 'INVALID_CREDENTIALS'
  | 'UnauthorizedException'
  | 'ForbiddenException'
  | 'NotFoundException'
  | 'ConflictException'
  | 'BadRequestException'
  | 'InternalServerError'
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

interface ApiOptions {
  /** Bearer token from the `auth_token` cookie. Omit for public endpoints. */
  token?: string;
  /** Override the default 10s timeout (ms). */
  timeoutMs?: number;
  /** Idempotency key for mutations — DB-enforced unique per CLAUDE.md §3 #10. */
  idempotencyKey?: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;

async function request<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body: unknown,
  schema: z.ZodType<T>,
  opts: ApiOptions = {},
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  const headers: Record<string, string> = {
    accept: 'application/json',
  };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;

  let response: Response;
  try {
    response = await fetch(`${env.API_URL}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      // Server-to-server — no cookies forwarded, no caching by default.
      cache: 'no-store',
    });
  } catch (err) {
    clearTimeout(timer);
    const isAbort = (err as Error).name === 'AbortError';
    throw new ApiError(
      0,
      'NetworkError',
      isAbort
        ? `Request timed out after ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`
        : (err as Error).message,
      path,
    );
  }
  clearTimeout(timer);

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
    const envelope = parsed as {
      statusCode?: number;
      error?: string;
      message?: unknown;
      path?: string;
    } | null;
    if (envelope && typeof envelope.statusCode === 'number' && typeof envelope.error === 'string') {
      const msg = typeof envelope.message === 'string' ? envelope.message : 'Request failed';
      throw new ApiError(envelope.statusCode, envelope.error, msg, envelope.path);
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

export const api = {
  get: <T>(path: string, schema: z.ZodType<T>, opts?: ApiOptions) =>
    request('GET', path, undefined, schema, opts),
  post: <T>(path: string, body: unknown, schema: z.ZodType<T>, opts?: ApiOptions) =>
    request('POST', path, body, schema, opts),
  patch: <T>(path: string, body: unknown, schema: z.ZodType<T>, opts?: ApiOptions) =>
    request('PATCH', path, body, schema, opts),
  delete: <T>(path: string, schema: z.ZodType<T>, opts?: ApiOptions) =>
    request('DELETE', path, undefined, schema, opts),
};
