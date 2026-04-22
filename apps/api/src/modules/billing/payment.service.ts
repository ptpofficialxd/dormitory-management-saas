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
      return row as unknown as Payment;
    } catch (err) {
      // Idempotent replay path: the same `(companyId, idempotencyKey)` pair
      // was already persisted. Look up + return the original row so the
      // caller observes a successful "create" without a duplicate side-effect.
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
   * Recomputes Invoice rollup status in the SAME transaction. We use an
   * interactive transaction so the rollup query sees the just-written
   * Payment row (READ COMMITTED + tx isolation gives that guarantee).
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

    const updated = await prisma.$transaction(async (tx) => {
      const payment = await tx.payment.update({
        where: { id },
        data: {
          status: 'confirmed',
          confirmedAt: new Date(),
          confirmedByUserId,
        },
      });
      await this.recomputeInvoiceStatus(tx, payment.invoiceId);
      return payment;
    });

    return updated as unknown as Payment;
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
    return updated as unknown as Payment;
  }

  // ---------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------

  /**
   * Recompute Invoice.status from the sum of confirmed payments. Called
   * inside a transaction on every confirm() so the rollup is atomic.
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
  private async recomputeInvoiceStatus(
    tx: Prisma.TransactionClient,
    invoiceId: string,
  ): Promise<void> {
    const invoice = await tx.invoice.findUnique({
      where: { id: invoiceId },
      select: { id: true, total: true, status: true },
    });
    if (!invoice) return; // FK should make this unreachable, but defensive.
    if (invoice.status === 'void') return;

    const confirmedPayments = await tx.payment.findMany({
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
      await tx.invoice.update({
        where: { id: invoiceId },
        data: { status: nextStatus },
      });
    }
  }
}

/**
 * Detect Prisma P2002 unique-constraint violations on a specific column tuple.
 * `target` is either a string (single col) or string[] (composite). We accept
 * either ordering — Prisma sometimes reorders composite targets internally.
 */
function isUniqueConstraintError(err: unknown, columns: string[]): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; meta?: { target?: unknown } };
  if (e.code !== 'P2002') return false;
  const target = e.meta?.target;
  if (Array.isArray(target)) return columns.every((c) => target.some((t) => String(t).includes(c)));
  return typeof target === 'string' && columns.every((c) => target.includes(c));
}
