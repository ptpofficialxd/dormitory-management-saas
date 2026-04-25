import { type Prisma, getTenantContext, prisma } from '@dorm/db';
import { sub as moneySub, sum as moneySum, toStorage } from '@dorm/shared/money';
import type { CreatePaymentInput, ListPaymentsQuery, Payment } from '@dorm/shared/zod';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { type CursorPage, buildCursorPage, decodeCursor } from '../../common/util/cursor.util.js';
import { NotificationService } from '../notification/notification.service.js';

/**
 * Payment = a single attempted payment against an Invoice. The state machine
 * is `pending → confirmed | rejected` — once confirmed/rejected, no further
 * transitions (corrections happen via a NEW payment + voiding the old one in
 * a future Phase). The service owns the math, the idempotency contract, and
 * the on-confirm Invoice status rollup.
 *
 * Idempotency contract (CLAUDE.md §3.10):
 *   - Every `create` MUST carry an `Idempotency-Key` header (controller
 *     extracts + passes here).
 *   - DB constraint `(companyId, idempotencyKey)` — a re-played POST returns
 *     the EXISTING payment (same id, same status) with HTTP 200, NEVER a
 *     fresh row. We rely on Prisma P2002 → lookup → return as the canonical
 *     idempotent path (avoids a TOCTOU window between "does it exist?" and
 *     "create").
 *
 * Invoice status rollup (on confirm / reject):
 *   - `paid_total = sum(confirmed payments where invoiceId = X)`
 *   - if `paid_total >= invoice.total` → invoice.status = 'paid'
 *   - else if `paid_total > 0`         → invoice.status = 'partially_paid'
 *   - else                              → invoice.status stays 'issued'
 *   - Done in the SAME transaction as the payment status flip so the rollup
 *     can never disagree with the source-of-truth payment rows.
 *
 * State machine guards:
 *   - Cannot `create` against draft / void invoices (only issued / partially_paid).
 *   - Cannot `confirm` if invoice is void (sanity check; usually pre-empted by
 *     the invoice-status read inside the same tx).
 *   - Cannot `confirm` or `reject` an already-decided payment with a different
 *     verb — confirm-on-confirmed is idempotent, reject-on-rejected is
 *     idempotent, but confirm-on-rejected (or vice-versa) → 409.
 *
 * Cross-tenant guard:
 *   - `invoiceId` on POST → must be visible (RLS-per-table). Caller-supplied
 *     `tenantId` is NOT trusted; service pulls it from the Invoice row.
 */
@Injectable()
export class PaymentService {
  constructor(private readonly notification: NotificationService) {}

  // ---------------------------------------------------------------
  // Read paths
  // ---------------------------------------------------------------

  /** Cursor-paginated list with optional `status` / `invoiceId` / `tenantId` filters. */
  async list(query: ListPaymentsQuery): Promise<CursorPage<Payment>> {
    const { cursor, limit, status, invoiceId, tenantId } = query;
    const decoded = cursor ? decodeCursor(cursor) : null;

    const baseWhere: Prisma.PaymentWhereInput = {};
    if (status) baseWhere.status = status;
    if (invoiceId) baseWhere.invoiceId = invoiceId;
    if (tenantId) baseWhere.tenantId = tenantId;

    const where: Prisma.PaymentWhereInput = decoded
      ? {
          AND: [
            baseWhere,
            {
              OR: [
                { createdAt: { lt: new Date(decoded.createdAt) } },
                { createdAt: new Date(decoded.createdAt), id: { lt: decoded.id } },
              ],
            },
          ],
        }
      : baseWhere;

    const rows = await prisma.payment.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    return buildCursorPage(rows as unknown as Payment[], limit);
  }

  async getById(id: string): Promise<Payment> {
    const row = await prisma.payment.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`Payment ${id} not found`);
    return row as unknown as Payment;
  }

  /**
   * Tenant-scoped variant for the LIFF `/me/payments/:id` route. Returns
   * 404 (NEVER 403) on cross-tenant probes — same posture as
   * `InvoiceService.getByIdForTenant`.
   *
   * Also reused by slip endpoints as a one-line ownership guard:
   *   await paymentService.getByIdForTenant(paymentId, tenant.sub);
   *   // safe to proceed — payment exists AND belongs to caller
   */
  async getByIdForTenant(id: string, tenantId: string): Promise<Payment> {
    const row = await prisma.payment.findFirst({ where: { id, tenantId } });
    if (!row) throw new NotFoundException(`Payment ${id} not found`);
    return row as unknown as Payment;
  }

  /**
   * Tenant-initiated payment creation (LIFF). Pre-checks that the target
   * invoice belongs to the caller — without this, a tenant could POST
   * `{ invoiceId: <other-tenant-in-same-company> }` and create a Payment
   * row attributed to the wrong tenant (the underlying `create` derives
   * `tenantId` from the invoice, not the caller, so the row WOULD be
   * mis-attributed).
   *
   * On match → delegates to `create()` which handles idempotency, status
   * gates, etc. Tenant origin is logged via the standard AuditLog
   * interceptor (no extra plumbing here).
   */
  async createForTenant(
    input: CreatePaymentInput,
    idempotencyKey: string,
    tenantId: string,
  ): Promise<Payment> {
    const invoice = await prisma.invoice.findFirst({
      where: { id: input.invoiceId, tenantId },
      select: { id: true },
    });
    if (!invoice) {
      // Match the "InvalidInvoiceId" wire shape that admin create() throws,
      // not a 404 — keeps the LIFF error UX consistent (one error code per
      // "you can't pay this").
      throw new BadRequestException({
        error: 'InvalidInvoiceId',
        message: `Invoice ${input.invoiceId} does not exist or is not accessible`,
      });
    }
    return this.create(input, idempotencyKey);
  }

  // ---------------------------------------------------------------
  // Write paths
  // ---------------------------------------------------------------

  /**
   * Create a new payment in `pending`. Idempotent on the
   * `(companyId, idempotencyKey)` tuple — a re-played call returns the prior
   * row instead of inserting a new one.
   *
   * `idempotencyKey` MUST come from the `Idempotency-Key` HTTP header — the
   * controller is responsible for extracting + validating its presence.
   *
   * `tenantId` is sourced from the Invoice (NOT trusted from the caller) so
   * an admin-driven cash-payment record can't be misattributed to a foreign
   * tenant.
   *
   * Idempotency implementation:
   *   1. Pre-check via `findFirst` — covers ALL replay cases (POSTs in
   *      separate requests). The replayed POST always finds the prior row
   *      and short-circuits; INSERT is never attempted.
   *   2. SAVEPOINT around `create()` — defends against the rare TRUE race:
   *      two concurrent POSTs with the same key. Without the savepoint, a
   *      P2002 unique violation puts the OUTER request tx into Postgres
   *      state 25P02 (`current transaction is aborted, commands ignored`),
   *      which would then fail the catch-block's `findFirst` lookup AND
   *      the audit-log interceptor's insert (cascading to a 500 even
   *      though the row exists).
   *
   * Why pre-check (vs. catch-only)? The original "INSERT then catch P2002"
   * pattern works on databases that allow continued queries after a
   * constraint violation. Postgres aborts the tx instead — so the catch
   * path is unreachable without explicit recovery (SAVEPOINT or new tx).
   */
  async create(input: CreatePaymentInput, idempotencyKey: string): Promise<Payment> {
    const ctx = getTenantContext();
    if (!ctx?.companyId) {
      throw new InternalServerErrorException('Tenant context missing on create');
    }

    const invoice = await prisma.invoice.findUnique({
      where: { id: input.invoiceId },
      select: { id: true, tenantId: true, status: true, total: true },
    });
    if (!invoice) {
      throw new BadRequestException({
        error: 'InvalidInvoiceId',
        message: `Invoice ${input.invoiceId} does not exist or is not accessible`,
      });
    }

    // Block payments against non-billable invoice states. `paid` is allowed
    // because over-payment can happen (tenant pays twice via slip + cash) —
    // the surplus stays as a `confirmed` payment row and reconciliation is
    // a separate flow.
    if (invoice.status === 'draft') {
      throw new ConflictException({
        error: 'InvoiceNotIssued',
        message: 'Cannot pay a draft invoice — issue it first',
      });
    }
    if (invoice.status === 'void') {
      throw new ConflictException({
        error: 'InvoiceVoid',
        message: 'Cannot pay a voided invoice',
      });
    }

    // Reject zero / negative amounts at the boundary. Zod `moneySchema`
    // already enforces decimal shape but doesn't ban zero — we do, because
    // a zero-amount Payment row pollutes the rollup math.
    if (Number.parseFloat(input.amount) <= 0) {
      throw new BadRequestException({
        error: 'InvalidAmount',
        message: 'Payment amount must be greater than zero',
      });
    }

    // Step 1 — fast-path pre-check. Inside the request tx, RLS scopes the
    // lookup to this tenant; `idempotencyKey` is unique within companyId.
    const replay = await prisma.payment.findFirst({
      where: { idempotencyKey },
    });
    if (replay) return replay as unknown as Payment;

    // Step 2 — guarded INSERT. SAVEPOINT lets us recover the outer tx if a
    // concurrent request committed the same key between Step 1 and here.
    await prisma.$executeRawUnsafe('SAVEPOINT idempotent_payment_create');
    try {
      const row = await prisma.payment.create({
        data: {
          companyId: ctx.companyId,
          invoiceId: invoice.id,
          tenantId: invoice.tenantId,
          amount: input.amount,
          method: input.method,
          status: 'pending',
          paidAt: input.paidAt ? new Date(input.paidAt) : null,
          idempotencyKey,
        },
      });
      await prisma.$executeRawUnsafe('RELEASE SAVEPOINT idempotent_payment_create');
      return row as unknown as Payment;
    } catch (err) {
      // Roll the failed INSERT back to the savepoint — clears the 25P02
      // abort flag so the outer request tx can keep going (audit-log
      // interceptor still needs to insert, and the response must commit).
      await prisma.$executeRawUnsafe('ROLLBACK TO SAVEPOINT idempotent_payment_create');
      if (isUniqueConstraintError(err, ['company_id', 'idempotency_key'])) {
        const existing = await prisma.payment.findFirst({
          where: { idempotencyKey },
        });
        if (existing) return existing as unknown as Payment;
      }
      throw err;
    }
  }

  /**
   * Confirm a payment. Idempotent on already-confirmed (returns the row
   * unchanged); refuses on `rejected` (must POST a new payment with a fresh
   * idempotency key — no re-deciding old rows).
   *
   * Recomputes Invoice rollup status in the SAME transaction as the update.
   * Atomicity comes from the OUTER `withTenant()` tx opened by
   * `TenantContextInterceptor` at the request boundary — every `prisma.*`
   * call inside the request routes through that single interactive tx via
   * ALS (see `packages/db/src/client.ts`). We deliberately do NOT open a
   * nested `prisma.$transaction()` here:
   *   • `prisma` inside `withTenant()` resolves to a `TransactionClient`,
   *     which does NOT expose `$transaction` (Prisma constraint).
   *   • Calling it would throw `prisma.$transaction is not a function`,
   *     bubbling up as a 500 to the caller.
   * Direct script callers (outside any request) MUST wrap their own
   * `withTenant()` boundary — that's the contract.
   */
  async confirm(id: string, confirmedByUserId: string, _note?: string): Promise<Payment> {
    const existing = await this.getById(id);
    if (existing.status === 'confirmed') {
      // Idempotent — caller might be retrying after a flaky network hop.
      return existing;
    }
    if (existing.status === 'rejected') {
      throw new ConflictException({
        error: 'PaymentAlreadyRejected',
        message: 'Cannot confirm a rejected payment — create a new one',
      });
    }

    // `_note` is captured by the AuditLogInterceptor from the request body —
    // there is no on-Payment column for it. We accept it here so the call
    // signature is self-documenting; the parameter is intentionally unused.
    void _note;

    const payment = await prisma.payment.update({
      where: { id },
      data: {
        status: 'confirmed',
        confirmedAt: new Date(),
        confirmedByUserId,
      },
    });
    await this.recomputeInvoiceStatus(payment.invoiceId);

    // Fire-and-forget LINE push (Task #84). After DB commit so we don't
    // push for a payment that rolled back. Producer swallows errors;
    // worker soft-skips when tenant has no lineUserId. The 2 read queries
    // are unavoidable: invoice for period + tenantId, company for slug.
    await this.enqueuePaymentNotification(payment, 'approved');

    return payment as unknown as Payment;
  }

  /**
   * Reject a payment. Idempotent on already-rejected; refuses on `confirmed`
   * (rejecting a confirmed payment would silently de-credit an invoice — use
   * a refund flow in Phase 1+).
   *
   * No invoice rollup needed: a rejected payment's amount was never part of
   * `paid_total` to begin with (we sum WHERE status = 'confirmed').
   */
  async reject(id: string, rejectionReason: string): Promise<Payment> {
    const existing = await this.getById(id);
    if (existing.status === 'rejected') {
      // Idempotent — same reasoning as confirm().
      return existing;
    }
    if (existing.status === 'confirmed') {
      throw new ConflictException({
        error: 'PaymentAlreadyConfirmed',
        message: 'Cannot reject a confirmed payment — use a refund flow instead',
      });
    }

    const updated = await prisma.payment.update({
      where: { id },
      data: {
        status: 'rejected',
        rejectionReason,
      },
    });

    // Fire-and-forget LINE push (Task #84). Tenant gets the rejection
    // reason verbatim so they know what to fix on the next slip upload.
    await this.enqueuePaymentNotification(updated, 'rejected', rejectionReason);

    return updated as unknown as Payment;
  }

  // ---------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------

  /**
   * Recompute Invoice.status from the sum of confirmed payments. Called
   * after a confirm() update — atomicity is provided by the OUTER
   * `withTenant()` tx (TenantContextInterceptor) since every `prisma.*`
   * call here routes through that single interactive tx via ALS.
   *
   * Rules:
   *   - `paid_total >= invoice.total` → 'paid'
   *   - `0 < paid_total < invoice.total` → 'partially_paid'
   *   - `paid_total == 0` → leave whatever non-paid status was already there
   *     (typically 'issued' or 'overdue'; we don't downgrade to draft).
   *
   * `void` invoices are skipped — they shouldn't have payments hitting them
   * in the first place (create() blocks it), but if a race made it through
   * we don't want to flip a void invoice back to paid.
   */
  private async recomputeInvoiceStatus(invoiceId: string): Promise<void> {
    const invoice = await prisma.invoice.findUnique({
      where: { id: invoiceId },
      select: { id: true, total: true, status: true },
    });
    if (!invoice) return; // FK should make this unreachable, but defensive.
    if (invoice.status === 'void') return;

    const confirmedPayments = await prisma.payment.findMany({
      where: { invoiceId, status: 'confirmed' },
      select: { amount: true },
    });
    const paidTotal = toStorage(moneySum(confirmedPayments.map((p) => p.amount.toString())));
    const total = invoice.total.toString();

    // `paid_total >= total` → paid; positive remainder → partially_paid.
    // `moneySub(total, paidTotal)` gives the OUTSTANDING balance — `<= 0`
    // means fully paid (with the equality covering exact-amount payments).
    const outstanding = Number.parseFloat(toStorage(moneySub(total, paidTotal)));
    let nextStatus: 'paid' | 'partially_paid' | null = null;
    if (outstanding <= 0) nextStatus = 'paid';
    else if (Number.parseFloat(paidTotal) > 0) nextStatus = 'partially_paid';

    if (nextStatus && nextStatus !== invoice.status) {
      await prisma.invoice.update({
        where: { id: invoiceId },
        data: { status: nextStatus },
      });
    }
  }

  /**
   * Enqueue the LINE push that follows a payment status change (Task #84).
   *
   * Two reads are unavoidable:
   *   - invoice → `period` + `tenantId` (tenant for the recipient resolve;
   *     period for the template body)
   *   - company → `slug` (LIFF deep-link path component)
   *
   * Run them in parallel — both are PK lookups under RLS, ~1ms each.
   *
   * Soft-fails silently when either lookup misses (FK guards make this
   * unreachable in normal flow; defensive against race-with-delete). The
   * NotificationService itself swallows producer-side queue errors.
   *
   * `kind` is narrowed at the call site (confirm passes 'approved', reject
   * passes 'rejected') so we can keep the helper signature small.
   */
  private async enqueuePaymentNotification(
    payment: { invoiceId: string },
    kind: 'approved' | 'rejected',
    reason?: string,
  ): Promise<void> {
    const ctx = getTenantContext();
    if (!ctx?.companyId) return; // shouldn't happen — defensive

    const [invoice, company] = await Promise.all([
      prisma.invoice.findUnique({
        where: { id: payment.invoiceId },
        select: { period: true, tenantId: true },
      }),
      prisma.company.findUnique({
        where: { id: ctx.companyId },
        select: { slug: true },
      }),
    ]);

    if (!invoice || !company) return; // FK guards usually prevent this

    const base = {
      companyId: ctx.companyId,
      companySlug: company.slug,
      tenantId: invoice.tenantId,
      invoiceId: payment.invoiceId,
      period: invoice.period,
    };

    if (kind === 'approved') {
      await this.notification.enqueuePaymentApproved(base);
    } else {
      await this.notification.enqueuePaymentRejected({
        ...base,
        // Caller of `reject()` always supplies a reason (Zod-required at
        // controller boundary), so this fallback should be unreachable —
        // kept defensive so a future refactor doesn't blow up the tenant
        // template with a literal "undefined".
        reason: reason ?? 'ไม่ระบุเหตุผล',
      });
    }
  }
}

/**
 * Detect Prisma P2002 unique-constraint violations on a specific column tuple.
 * `target` is either a string (single col) or string[] (composite). We accept
 * either ordering — Prisma sometimes reorders composite targets internally.
 *
 * Defensive fallback: if `meta.target` is missing, `null`, or the literal
 * sentinel `"(not available)"` (Prisma can't introspect the constraint name
 * — happens with composite unique indexes under RLS), we still return `true`
 * for any P2002. The caller is responsible for confirming the match via a
 * follow-up `findFirst` lookup; if no row comes back, it must rethrow.
 *
 * Why permissive? On `Payment.create()` the only realistic P2002 sources are:
 *   1. `(company_id, idempotency_key)` composite — IDEMPOTENCY ✓
 *   2. `id` PK collision (UUID v4 — astronomically unlikely)
 * So treating an opaque P2002 as an idempotency hit is safe in practice and
 * lets the lookup decide.
 */
function isUniqueConstraintError(err: unknown, columns: string[]): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; meta?: { target?: unknown } };
  if (e.code !== 'P2002') return false;
  const target = e.meta?.target;
  // Opaque target → defer to caller's lookup.
  if (target == null || target === '(not available)') return true;
  if (Array.isArray(target)) return columns.every((c) => target.some((t) => String(t).includes(c)));
  return typeof target === 'string' && columns.every((c) => target.includes(c));
}
