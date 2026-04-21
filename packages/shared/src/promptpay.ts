/**
 * PromptPay EMVCo QR payload generator.
 *
 * Reference: Thailand PromptPay QR spec (EMVCo MPM = Merchant-Presented
 * Mode), compatible with Bangkok Bank / SCB / Kasikorn / Krungthai banking
 * apps.
 *
 * MVP scope (CLAUDE.md §3.9 / Phase 1):
 *   - Static QR (`payload format 11`) — reusable for the same payee; we
 *     regenerate one per invoice but it's not tied to a transaction ID on
 *     the bank side.
 *   - Supports PromptPay IDs as:
 *       • Thai national ID (13 digits)            → AID 02, 13-char value
 *       • Thai mobile phone (10 digits, starts 0) → AID 01, 13-char value
 *                                                    `0066` + 9-digit number
 *       • e-Wallet ID (15 digits)                 → AID 03, 15-char value
 *   - Amount (field 54) — optional; include for invoice QRs, omit for
 *     open-amount / tip-jar QRs.
 *   - Currency (field 53) = `764` THB
 *   - Country (field 58)  = `TH`
 *
 * OUT OF SCOPE for MVP (forbidden by §8):
 *   - Dynamic QR (one-time, payload format 12) — future work.
 *   - Bill Payment (field 30 — Biller ID) — requires merchant onboarding.
 *
 * Field encoding: EMV-TLV — 2-char tag + 2-char length + variable-length
 * value. Multi-byte values don't occur in our payload (ASCII + digits only),
 * so byte-length == char-length.
 *
 * CRC-16/CCITT-FALSE (polynomial 0x1021, init 0xFFFF, no reflection, no
 * final XOR) is computed over `payload + "6304"` and appended as 4 hex
 * digits uppercase — verified against the Bank of Thailand reference QR.
 */

import { COUNTRY_CODE_TH, CURRENCY_NUMERIC_THB } from './constants.js';
import { type MoneyInput, toStorage } from './money.js';

// -----------------------------------------------------------------------
// Helpers.
// -----------------------------------------------------------------------

function tlv(tag: string, value: string): string {
  if (tag.length !== 2) throw new Error(`TLV tag must be 2 chars: ${tag}`);
  const len = value.length.toString().padStart(2, '0');
  if (len.length !== 2) {
    throw new Error(`TLV value too long (max 99 chars): ${value.length}`);
  }
  return `${tag}${len}${value}`;
}

/** Keep only decimal digits. Used to sanitize user-entered PromptPay IDs. */
function digitsOnly(input: string): string {
  return input.replace(/\D/g, '');
}

/**
 * Normalize a PromptPay ID to the 13 or 15-digit AID value required by
 * sub-field 01/02/03 of Merchant-Account-Info (tag 29).
 *
 * - 10-digit mobile starting with `0` → drop leading `0`, prepend `0066`,
 *   result is 13 digits.
 * - 13-digit national ID              → passthrough.
 * - 15-digit e-wallet                 → passthrough.
 *
 * Anything else throws — we prefer a loud error to silently shipping a QR
 * that doesn't work.
 */
export type PromptPayIdKind = 'national_id' | 'phone' | 'ewallet';

export type NormalizedPromptPayId = {
  kind: PromptPayIdKind;
  /** 13-char (national_id, phone) or 15-char (ewallet) digit string. */
  value: string;
  /** Sub-field tag inside tag 29 — `01`=phone, `02`=national_id, `03`=ewallet. */
  subTag: '01' | '02' | '03';
};

export function normalizePromptPayId(raw: string): NormalizedPromptPayId {
  const d = digitsOnly(raw);

  if (d.length === 10 && d.startsWith('0')) {
    return {
      kind: 'phone',
      value: `0066${d.slice(1)}`,
      subTag: '01',
    };
  }

  if (d.length === 13) {
    return {
      kind: 'national_id',
      value: d,
      subTag: '02',
    };
  }

  if (d.length === 15) {
    return {
      kind: 'ewallet',
      value: d,
      subTag: '03',
    };
  }

  throw new Error(
    `Invalid PromptPay ID: expected 10-digit phone (starts with 0), 13-digit national ID, or 15-digit e-wallet; got ${d.length} digits`,
  );
}

// -----------------------------------------------------------------------
// CRC-16/CCITT-FALSE.
// -----------------------------------------------------------------------

/**
 * CRC-16/CCITT-FALSE used by EMVCo. Implemented as a straight table-free
 * loop — payloads are tiny (~60 bytes) so the per-char cost is irrelevant
 * and a table would just add code size.
 *
 * Parameters (canonical "FALSE" variant):
 *   poly=0x1021  init=0xFFFF  refIn=false  refOut=false  xorOut=0x0000
 *
 * Verified output: `CRC("123456789")` → `0x29B1`.
 */
export function crc16Ccitt(input: string): string {
  let crc = 0xffff;
  for (let i = 0; i < input.length; i++) {
    crc ^= input.charCodeAt(i) << 8;
    for (let b = 0; b < 8; b++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

// -----------------------------------------------------------------------
// Public API.
// -----------------------------------------------------------------------

export type PromptPayQrOptions = {
  /** PromptPay ID — national ID, phone, or e-wallet. Will be normalized. */
  readonly promptPayId: string;
  /**
   * Optional amount in THB. If provided, the QR is amount-locked (banking
   * app shows the amount and disables editing). Omit for open-amount.
   * Accepts the same inputs as `money()` — string / number / Decimal.
   */
  readonly amount?: MoneyInput;
};

/**
 * Build the raw EMVCo QR payload string. The caller can pass this string to
 * any QR-code library (e.g. `qrcode`, `qr.js`) to render the image.
 *
 * Static QR (Payload Format Indicator = `01`, Point-of-Initiation = `11`).
 */
export function generatePromptPayPayload(opts: PromptPayQrOptions): string {
  const norm = normalizePromptPayId(opts.promptPayId);

  // Tag 29 — Merchant Account Information (PromptPay):
  //   sub 00: AID = "A000000677010111"
  //   sub 01/02/03: the PromptPay ID value
  const merchantAccount = tlv('00', 'A000000677010111') + tlv(norm.subTag, norm.value);

  const fields: string[] = [
    tlv('00', '01'), // Payload Format Indicator
    tlv('01', '11'), // Point of Initiation Method — 11 = static
    tlv('29', merchantAccount), // Merchant Account Info (PromptPay)
    tlv('53', CURRENCY_NUMERIC_THB), // Transaction Currency (764 = THB)
  ];

  if (opts.amount !== undefined) {
    // EMVCo amount: variable length, no thousands separators, `.` decimal,
    // up to 13 chars per spec. `toStorage` gives 2dp string like "5500.00".
    fields.push(tlv('54', toStorage(opts.amount)));
  }

  fields.push(tlv('58', COUNTRY_CODE_TH)); // Country Code

  // Final CRC (tag 63) — length is always 04 (4 hex digits), and the CRC is
  // computed over the payload INCLUDING the literal "6304" prefix.
  const withoutCrc = `${fields.join('')}6304`;
  const crc = crc16Ccitt(withoutCrc);
  return `${withoutCrc}${crc}`;
}
