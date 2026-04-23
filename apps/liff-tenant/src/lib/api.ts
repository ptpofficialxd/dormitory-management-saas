import { z } from 'zod';
import { env } from '../env.js';

/**
 * API client for the LIFF tenant app. Thin wrapper around `fetch` that:
 *
 * 1. Joins the path against `VITE_API_BASE_URL`.
 * 2. Always sends/receives JSON.
 * 3. Parses the GlobalExceptionFilter envelope on non-2xx and throws a
 *    typed `ApiError` with the server's `error` code + `message`.
 * 4. Validates the success body against a Zod schema (caller-supplied) so
 *    a bad server response surfaces as a parse error, not a runtime crash
 *    inside a component.
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
  | 'UnauthorizedException'
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

const errorEnvelopeSchema = z.object({
  statusCode: z.number(),
  error: z.string(),
  message: z.union([z.string(), z.array(z.unknown()), z.record(z.unknown())]),
  path: z.string().optional(),
});

/**
 * POST a JSON body to `path` and return the parsed response.
 *
 * @param path  Path joined against `VITE_API_BASE_URL` — must start with `/`.
 * @param body  Plain object; serialised to JSON.
 * @param schema Zod schema for the success body (use the client-side wire
 *               variants from `queries/tenant-invite.ts` — they `coerce.date()`
 *               since dates arrive as ISO strings over the wire).
 */
export async function apiPost<T>(path: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${env.VITE_API_BASE_URL}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      credentials: 'omit',
    });
  } catch (err) {
    // Network failure (DNS / TCP / CORS preflight rejection).
    throw new ApiError(0, 'NetworkError', (err as Error).message ?? 'Network error');
  }

  // Always read the body once — even on success — because some browsers
  // hold the connection open if the body is left undrained.
  const rawText = await response.text();
  let parsed: unknown = null;
  if (rawText) {
    try {
      parsed = JSON.parse(rawText);
    } catch {
      // Non-JSON response (probably a 502 HTML page from the proxy).
      throw new ApiError(
        response.status,
        'ResponseShapeMismatch',
        `Server returned non-JSON (status=${response.status})`,
        path,
      );
    }
  }

  if (!response.ok) {
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
