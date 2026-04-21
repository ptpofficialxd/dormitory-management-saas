# ADR-0005 — Money as `Decimal(10,2)`, never `Float`

- **Status:** Accepted
- **Date:** 2026-04-21

## Context

This is a FinTech-adjacent product. Every invoice, every meter reading converted
to a charge, every PromptPay payment, every deposit refund is money in **Thai Baht
(THB), to the satang (2 decimal places)**. The single worst failure mode for a
billing SaaS is arithmetic drift — sending a tenant a bill that's off by 0.01 THB
because of IEEE-754 rounding and then being unable to reconcile against a real
bank slip.

JavaScript `number` is IEEE-754 double. `0.1 + 0.2 !== 0.3`. This must not reach
production.

## Decision

**All currency columns are `Decimal(10,2)` in Postgres, modeled in Prisma as
`@db.Decimal(10,2)`, and manipulated via `Prisma.Decimal` (decimal.js) in
application code.**

- Schema: `amount Decimal @db.Decimal(10,2)`
- Transport: serialized as **string** in JSON (`"1234.50"`), never a JS `number`.
- Zod contract: `z.string().regex(/^\d+(\.\d{1,2})?$/).transform((s) => new Decimal(s))`.
- Arithmetic: use `Prisma.Decimal` methods (`.plus`, `.minus`, `.times`, `.div`)
  exclusively — never `+`, `-`, `*`, `/` on money.
- Rounding: banker's rounding (`ROUND_HALF_EVEN`) at the end of a calculation only.
- Display: `new Intl.NumberFormat('th-TH', { style: 'currency', currency: 'THB' })`.

`Decimal(10,2)` gives us up to `99,999,999.99 THB` per row, which covers any
single-unit invoice we'd ever plausibly issue. Aggregate totals (dashboards) use
`Decimal(14,2)`.

## Rationale

- **Correctness:** no floating-point drift in invoice subtotals, tax calculations,
  or deposit refunds.
- **Auditability:** decimal strings round-trip through JSON, DB, and PDFs without
  precision loss.
- **PDPA/financial hygiene:** every money mutation is append-only audit-logged
  (per CLAUDE.md §3.7) with the exact decimal value.
- **Tool support:** Prisma natively maps `Decimal` to `decimal.js`; NestJS class
  interceptors can stringify on response.

## Alternatives considered

- **Integer satang (`bigint` storing cents)** — also correct, and popular with
  Stripe/etc. Rejected for MVP because: (1) all source documents (invoices, bank
  slips, PromptPay QR payloads) are in decimal THB, so we'd be converting at every
  boundary; (2) Thai accounting spreadsheets the dorm owner will cross-check
  against are in decimal format; (3) display code paths are simpler. Revisit if
  we hit a perf issue (we won't at MVP scale).
- **JS `number` + `toFixed(2)`** — the usual "works in testing, breaks in prod"
  footgun. Absolutely rejected.
- **`Float` in Postgres** — same problem, SQL-side. Rejected.

## Consequences

- `zod` schemas must validate money fields as regex-checked strings, not numbers.
- Frontend forms use `string` state for money inputs. No `<input type="number">`
  for money — use `inputMode="decimal"` with a mask.
- CI has a lint rule that flags `number` types named `amount | price | total |
  fee | rent | deposit | balance` in any `.ts` file under `packages/billing` and
  `apps/api/src/**/billing/**`.
- Tests assert equality via `.equals()`, not `===`.
- `JSON.stringify` on a `Decimal` returns `"1234.50"` (quoted string). Frontend
  parses it back to `Decimal` only for math; raw display uses the string as-is.
- Aggregations (`SUM(amount)`) return `Decimal` — never destructure into a JS
  number without `.toFixed(2)` + `new Decimal(...)` first.
