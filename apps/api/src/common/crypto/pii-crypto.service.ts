import { prisma } from '@dorm/db';
import { Injectable } from '@nestjs/common';
import { env } from '../../config/env.js';

/**
 * PII encryption helper using Postgres `pgcrypto` (PGP symmetric).
 *
 * Why pgcrypto and not Node `crypto`?
 *   - Encrypt/decrypt happens on the same Postgres connection that already
 *     has RLS context applied (the proxy in `@dorm/db` routes `$queryRaw`
 *     through the active tenant tx). One round-trip, one connection, no
 *     plaintext leaving the DB until it reaches application memory.
 *   - The key never lives in any DB row — it lives only in
 *     `env.PII_ENCRYPTION_KEY`. Backups of the database without the key are
 *     useless.
 *   - Schema fields (`national_id`, `phone`) are sized as `VARCHAR(512)` to
 *     accommodate base64-encoded PGP ciphertext for short plaintexts (Thai
 *     national ID = 13 digits, mobile = 10 digits → ~150–200 base64 chars
 *     after PGP framing).
 *
 * Key rotation is OUT OF SCOPE for MVP — re-keying requires re-encrypting
 * every row in a one-shot migration:
 *   `UPDATE … SET col = encode(pgp_sym_encrypt(pgp_sym_decrypt(decode(col,'base64'), $old), $new), 'base64')`
 *
 * Test note: this service depends on `pgcrypto` being installed in the DB
 * (see `packages/db/prisma/migrations/.../add-pgcrypto.sql`). Unit tests mock
 * `prisma.$queryRaw` so they don't need a live DB; e2e tests exercise the
 * actual round-trip.
 */
@Injectable()
export class PiiCryptoService {
  private readonly key: string = env.PII_ENCRYPTION_KEY;

  /**
   * Encrypt a single plaintext string. Returns base64-encoded PGP ciphertext.
   * Pass-through for `null`/`undefined` so callers can chain through optional
   * fields without explicit null-checks.
   */
  async encrypt(plaintext: string | null | undefined): Promise<string | null> {
    if (plaintext === null || plaintext === undefined) return null;
    const rows = await prisma.$queryRaw<Array<{ ciphertext: string }>>`
      SELECT encode(pgp_sym_encrypt(${plaintext}, ${this.key}), 'base64') AS ciphertext
    `;
    const row = rows[0];
    if (!row?.ciphertext) {
      throw new Error('pgp_sym_encrypt returned an empty result');
    }
    return row.ciphertext;
  }

  /**
   * Decrypt a single base64-encoded ciphertext. Pass-through for `null`/
   * `undefined` so callers can decrypt optional rows uniformly.
   *
   * Throws if the ciphertext is malformed or the key is wrong — the Postgres
   * error bubbles up. The global exception filter maps it to a 500 (we don't
   * want to leak crypto details in the response envelope).
   */
  async decrypt(ciphertext: string | null | undefined): Promise<string | null> {
    if (ciphertext === null || ciphertext === undefined) return null;
    const rows = await prisma.$queryRaw<Array<{ plaintext: string | null }>>`
      SELECT pgp_sym_decrypt(decode(${ciphertext}, 'base64'), ${this.key})::text AS plaintext
    `;
    const row = rows[0];
    if (!row) {
      throw new Error('pgp_sym_decrypt returned an empty result');
    }
    return row.plaintext;
  }
}
