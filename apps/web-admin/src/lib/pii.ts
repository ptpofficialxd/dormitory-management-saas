/**
 * PII display masking helpers — admin UI side.
 *
 * The API returns DECRYPTED values (the service decrypts on read). We mask
 * at the React render boundary so casual screen-shares / shoulder-surfing
 * don't leak full PII. Reveal-on-click still has access to the full value
 * because the data is already in memory client-side once fetched.
 *
 * IMPORTANT: this is an in-browser display convenience, NOT a security
 * boundary — anyone with DevTools can see the raw fetch response. The
 * real defence is:
 *   - pgcrypto encryption at-rest (CLAUDE.md §3 #8)
 *   - RLS scoping (only admins of this company see this row)
 *   - audit log on mutations (already done) + reveal (Phase 2 polish)
 *
 * Phase 2 wishlist: route reveal through an audit-logged endpoint
 * (`GET /tenants/:id?revealPii=true` writes an audit_log entry per
 * access) so PDPA / forensics can answer "who looked at this PII when".
 */

/**
 * Mask a Thai mobile number to "081-***-5678".
 *
 * Accepts the canonical 10-digit form (`0812345678`) or already-formatted
 * (`081-234-5678`). Anything else passes through unchanged so we don't
 * accidentally hide debugging info.
 */
export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return '—';
  const digits = phone.replace(/\D/g, '');
  if (digits.length !== 10) return phone;
  return `${digits.slice(0, 3)}-***-${digits.slice(7)}`;
}

/**
 * Mask a Thai national ID to "X-XXXX-XXXXX-12-3" — keep the last 3
 * digits (the "12-3" tail of the canonical format) so admins can
 * disambiguate two tenants with similar names without revealing the
 * full ID.
 *
 * Format reference: 1-2345-67890-12-3 (13 digits, dashes optional).
 * Tail = digits[10..12] formatted as `XX-X`.
 */
export function maskNationalId(nationalId: string | null | undefined): string {
  if (!nationalId) return '—';
  const digits = nationalId.replace(/\D/g, '');
  if (digits.length !== 13) return nationalId;
  return `X-XXXX-XXXXX-${digits.slice(10, 12)}-${digits.slice(12, 13)}`;
}

/**
 * Format a phone number for display (with dashes) once revealed. We don't
 * mutate the value at storage — the wire form is the canonical 10-digit
 * sanitised form. This is purely cosmetic on the unmasked render.
 */
export function formatPhone(phone: string | null | undefined): string {
  if (!phone) return '—';
  const digits = phone.replace(/\D/g, '');
  if (digits.length !== 10) return phone;
  return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
}

/** Format a Thai national ID for display once revealed: 1-2345-67890-12-3. */
export function formatNationalId(nationalId: string | null | undefined): string {
  if (!nationalId) return '—';
  const digits = nationalId.replace(/\D/g, '');
  if (digits.length !== 13) return nationalId;
  return `${digits.slice(0, 1)}-${digits.slice(1, 5)}-${digits.slice(5, 10)}-${digits.slice(10, 12)}-${digits.slice(12)}`;
}
