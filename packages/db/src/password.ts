import { type Algorithm, hash, verify } from '@node-rs/argon2';

/**
 * Argon2id parameters — OWASP Password Storage Cheat Sheet (2024 recommendation).
 *   memoryCost: 19 MiB   (19 * 1024 = 19456 KiB)
 *   timeCost:   2        iterations
 *   parallelism: 1       thread
 *   outputLen:  32 bytes
 *
 * These numbers are tuned so hashing takes ~50–100ms on a modern laptop
 * (acceptable for login, prohibitive for brute force). Revisit annually.
 *
 * `algorithm: 2` = `Algorithm.Argon2id`. Hard-coded as a numeric literal
 * because `@node-rs/argon2` exports `Algorithm` as a `const enum`, which
 * `isolatedModules` (TS2748) forbids dereferencing at call sites. The
 * numeric mapping (Argon2d=0, Argon2i=1, Argon2id=2) is part of the
 * package's documented ABI and hasn't changed since v1.0.
 */
const ARGON2_CONFIG = {
  algorithm: 2 as Algorithm,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} as const;

/**
 * Hash a plaintext password. Returns an encoded string suitable for storage
 * in `user.password_hash` (VARCHAR 255). Includes salt + params inline.
 *
 * Portability: `@node-rs/argon2` is a N-API module and loads cleanly on both
 * Node 20 LTS and Bun 1.1 (ADR-0006 portability rule). No `Bun.password` here.
 */
export async function hashPassword(plain: string): Promise<string> {
  if (typeof plain !== 'string' || plain.length < 8) {
    throw new Error('Password must be a string of at least 8 characters.');
  }
  if (plain.length > 256) {
    // argon2 handles arbitrary length, but a hard cap defeats DoS via huge inputs.
    throw new Error('Password must be at most 256 characters.');
  }
  return hash(plain, ARGON2_CONFIG);
}

/**
 * Verify a plaintext password against a stored hash. Returns `true` on match,
 * `false` otherwise. Timing-safe (argon2 verify is constant-time by construction).
 */
export async function verifyPassword(plain: string, storedHash: string): Promise<boolean> {
  if (!plain || !storedHash) return false;
  try {
    return await verify(storedHash, plain);
  } catch {
    // Malformed hash → treat as non-match, don't leak error details.
    return false;
  }
}
