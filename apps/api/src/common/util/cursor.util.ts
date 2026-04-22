import { BadRequestException } from '@nestjs/common';

/**
 * Opaque cursor encoding for keyset (cursor) pagination.
 *
 * We paginate by `(createdAt DESC, id DESC)` — `createdAt` is the primary sort
 * key, `id` breaks ties when two rows share the same timestamp (UUID v7 isn't
 * monotonic across processes, so collisions are rare but possible).
 *
 * Cursors are returned to the client as opaque base64url strings. Clients MUST
 * NOT try to parse them — server may change the encoding without breaking the
 * contract as long as round-trip semantics are preserved.
 *
 * Format: base64url(JSON({ createdAt: ISO-string, id: UUID }))
 *   - JSON keeps the encoding self-describing (debuggable in DevTools)
 *   - base64url (RFC 4648 §5) avoids `+`/`/` which would need URL-encoding
 *   - We deliberately do NOT sign cursors — they reveal only the boundary row's
 *     `id` + timestamp, both of which the client already saw in the prior page.
 */

export type CursorPayload = {
  /** ISO 8601 UTC string of the boundary row's `createdAt`. */
  readonly createdAt: string;
  /** UUID of the boundary row. */
  readonly id: string;
};

/** Encode a `(createdAt, id)` pair into an opaque base64url cursor. */
export function encodeCursor(payload: CursorPayload): string {
  const json = JSON.stringify(payload);
  return Buffer.from(json, 'utf8').toString('base64url');
}

/**
 * Decode + validate a cursor string. Throws `BadRequestException` (mapped to
 * 400 by the global filter) on malformed input rather than trusting client
 * data into a Prisma `where` clause.
 */
export function decodeCursor(raw: string): CursorPayload {
  let json: string;
  try {
    json = Buffer.from(raw, 'base64url').toString('utf8');
  } catch {
    throw new BadRequestException({
      error: 'InvalidCursor',
      message: 'Cursor is not valid base64url',
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new BadRequestException({
      error: 'InvalidCursor',
      message: 'Cursor payload is not valid JSON',
    });
  }

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof (parsed as Record<string, unknown>).createdAt !== 'string' ||
    typeof (parsed as Record<string, unknown>).id !== 'string'
  ) {
    throw new BadRequestException({
      error: 'InvalidCursor',
      message: 'Cursor must contain createdAt + id strings',
    });
  }

  const { createdAt, id } = parsed as CursorPayload;
  if (Number.isNaN(Date.parse(createdAt))) {
    throw new BadRequestException({
      error: 'InvalidCursor',
      message: 'Cursor.createdAt is not a valid ISO date',
    });
  }
  return { createdAt, id };
}

/**
 * Standard list response shape: `{ items, nextCursor }`. `nextCursor` is null
 * when there are no more pages — clients should treat that as the terminal
 * condition rather than relying on `items.length < limit` (which is racy when
 * a row is inserted between calls).
 */
export type CursorPage<T> = {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
};

/**
 * Build a `CursorPage<T>` from a Prisma findMany result.
 *
 * The caller MUST query with `take = limit + 1` so we can detect "is there a
 * next page" without an extra COUNT(*) round-trip. If the result has more than
 * `limit` items we trim the overflow + emit a cursor pointing at the LAST
 * RETURNED row (not the overflow row — clients use `cursor` as "give me rows
 * AFTER this one", and we want the next page to start at the trimmed boundary).
 */
export function buildCursorPage<T extends { id: string; createdAt: Date }>(
  rows: readonly T[],
  limit: number,
): CursorPage<T> {
  if (rows.length <= limit) {
    return { items: rows, nextCursor: null };
  }
  const items = rows.slice(0, limit);
  // biome-ignore lint/style/noNonNullAssertion: items.length === limit ≥ 1 so last() is defined
  const boundary = items[items.length - 1]!;
  return {
    items,
    nextCursor: encodeCursor({
      createdAt: boundary.createdAt.toISOString(),
      id: boundary.id,
    }),
  };
}
