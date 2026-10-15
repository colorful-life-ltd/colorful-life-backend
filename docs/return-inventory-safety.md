# Return eligibility and phantom stock prevention — Issue #171

Returns remain ADMIN-operated. A return does not issue a refund, change payment status, release checkout inventory, or introduce a delivered-only rule. No schema migration is required.

## Eligibility and exact evidence

Admission and completion call the same check inside their transaction. Eligible statuses are CONFIRMED, DISPATCHED, COMPLETED and RETURNED, with no cancellation timestamp. PENDING (including paid-but-unconfirmed), CANCELLED and EXPIRED orders are ineligible. A managed HELD or RELEASED reservation is incompatible with a return; CONSUMED supports a confirmed sale. Historical resolution metadata alone is not treated as proof of deduction.

For the relevant listing, negative WEBSITE_SALE movements must have the exact writer-generated note `Order {orderId} sale` and total precisely the purchased quantity for that order/listing. Every matching sale must be negative; duplicate/excess, incomplete, wrong-order, wrong-listing or conflicting evidence fails closed. No substring matching, inference from payment status, or fabricated evidence is used. Any exact ORDER_CANCELLATION_RETURN with note `Order {orderId} cancellation return` is contradictory, even if the order status was subsequently edited.

Return counters must agree with active and completed return records, and purchased quantity bounds remain enforced. Prior ORDER_RETURN evidence uses the exact `Completed order return {returnId}` note: one movement of the inspected restock quantity on the correct listing for each completed positive-restock return, none for an active or zero-restock return. Ambiguous/missing historical bookkeeping or conflicting movements blocks further admission/completion; this patch never rewrites that history. Completed return quantities include non-restockable units, so damaged items do not create additional return capacity.

Completion revalidates persisted quantity, restock bounds, AS_NEW condition and existing Used-offer restrictions. A Used offer stays SOLD, with zero restock. Legitimate partial returns remain supported within the originally deducted quantity, including returns following a separately processed refund.

## Transactions and cancellation

Every return lifecycle mutation takes the Order row `FOR NO KEY UPDATE` first, before current-state reads. For an existing return, scoped OrderItem then OrderReturn row locks follow. Admission locks its scoped item before the quantity claim. ProductListing mutation follows those locks. The Order lock conflicts with existing confirmation/cancellation/expiry locks and serializes independent backend processes; no process-local mutex or provider I/O is involved.

The existing atomic return reservation claim, completion claim and final status update remain in the same transaction as stock and movement writes. A failed or duplicate completion cannot commit a second movement. REQUESTED cancellation releases its quantity reservation exactly once and changes no stock.

Customer and seller order cancellation reject active or completed returns, including historical records with missing counters. They also reject nonzero return counters. CANCELLED/REJECTED returns with cleared counters do not block ordinary cancellation. This prevents both race directions: cancellation first makes return admission ineligible; return first blocks full-order restoration. Even a completed zero-restock return blocks ordinary order cancellation rather than guessing inventory ownership.

Reservation expiry, including lazy checkout expiry, retains inventory when historical return activity conflicts with release. The common managed-release function also applies this guard, covering worker/provider-resolution entry points. Scheduled release is a no-op/retained hold, not a forced resolution; all provider finality and payment safety checks remain intact.

## API compatibility and operations

Existing request bodies and success responses are unchanged. Ineligible admission/completion returns HTTP 409 with `{error:{code:"ORDER_RETURN_INELIGIBLE",message:...}}`; customer/seller cancellation blocked by returns returns HTTP 409 with code ORDER_RETURN_CONFLICT. Existing authentication, ADMIN checks, ownership, 400 validation and 404 resource handling remain.

InventoryMovement has no structured order/return foreign key. This patch relies on exact existing service-generated notes and scoped listing/quantity checks. It does not claim protection against privileged direct SQL rewriting/deleting financial history or writers that bypass the shared Order lock. Deploy all return/cancellation writers together; old instances can bypass the safeguards. Retain non-owner least-privilege runtime roles and preserve audit data. Do not manufacture movements, reset counters or alter order status merely to bypass a blocked historical return; investigate authoritative evidence separately.

## Verification

Positive return fixtures now perform genuine order confirmation and stock deduction. Regressions use isolated PostgreSQL fixtures and local HTTP requests. Concurrency tests queue independent transactions behind an Order lock and observe the database's recursive wait graph before releasing it; no locking is mocked and no wall-clock delay determines the winner. Coverage includes admission and completion eligibility, exact evidence conflicts, partial/concurrent returns, both cancellation queue orders, seller cancellation, REQUESTED cancellation, managed/legacy/lazy expiry holds, ADMIN boundaries, Used offers and malformed persisted inspection data.

No real provider operation, automatic refund, historical cleanup, production migration or activation is part of this change. Final validation results are recorded in the implementation handover; independent review is required before commit or PR.

Final local validation: **143 focused return/cancellation/Used-offer tests passed**, **221 relevant inventory/order/payment/refund/fulfilment regressions passed**, and **full backend suite: 1,280 passed, 3 intentional external sandbox skips, 0 failed**. Forty new PostgreSQL security regressions were added. TypeScript build, Prisma validation and `git diff --check` passed. Earlier fixture-dependent assertions and lock-wait test-helper failures were corrected before final validation; no unresolved or pre-existing failures were observed in the final runs. All financial providers remained mocked. Only the guarded test database was used. No schema changes or migrations were introduced.

## Pre-deployment historical reservation audit (read-only)

Run this SELECT through the normal read-only operational review process before deployment. It has **not** been executed against production. The predicate matches the release guard, including nonzero counters without return rows. Each affected order is counted once, and all its item quantities are counted because the entire reservation is retained. These are nominal held order quantities, not an attribution of aggregate ProductListing.reservedStock (historical inconsistencies may exist).

```sql
WITH affected AS (
  SELECT o.id
  FROM "Order" o
  WHERE o.status = 'PENDING'
    AND EXISTS (
      SELECT 1
      FROM "OrderItem" oi
      WHERE oi."orderId" = o.id
        AND (
          oi."returnedQuantity" <> 0
          OR oi."reservedReturnQuantity" <> 0
          OR EXISTS (
            SELECT 1 FROM "OrderReturn" r
            WHERE r."orderItemId" = oi.id
              AND r.status NOT IN ('CANCELLED', 'REJECTED')
          )
        )
    )
)
SELECT (SELECT count(*) FROM affected) AS affected_pending_orders,
       COALESCE(sum(oi.quantity), 0) AS nominal_reserved_units,
       count(DISTINCT oi."productListingId") AS affected_listings
FROM "OrderItem" oi
JOIN affected a ON a.id = oi."orderId";
```

Blocked PENDING expiry and managed release emit structured `ORDER_RESERVATION_RELEASE_BLOCKED` warnings containing only order ID, entry point and a fixed reason. Suppression is shared across those entry points within each process using a FIFO cache of at most 1,000 order IDs. A retained order is suppressed for up to one hour; repeated attempts do not refresh its position or expiry. Before recording a new affected order at capacity, the oldest retained entry is evicted. Previously unseen orders always emit a warning. An evicted order can warn again before the hour expires, so heavy churn can increase repeated warnings; the cache bounds memory, not total warning volume. Workers and restarts have independent suppression. Warnings describe an observed blocked attempt and may survive a later transaction rollback; they do not claim a committed state change. Use the audit query for complete counts, as logs suppress repeated observations and workers may not encounter every affected order.

Restoration reads load only movements on the inspected listing. A separate existence probe retains rejection of exact return-note evidence on any other listing. Cancellation reversal evidence remains order-wide, since even a wrong-listing reversal contradicts the order's history. No historical note format, movement cardinality or quantity rule changed.

Final operational hardening validation (2026-10-15): **54 focused tests passed**, including eight added regressions for warning suppression, non-PENDING silence, wrong-listing restoration conflicts and legitimate historical evidence. **Full backend suite: 1,288 passed, 0 failed, 3 skipped (1,291 total)**. TypeScript build, Prisma validation and final `git diff --check` passed. Database tests ran through the guarded test-database runner; sandbox network isolation required an approved rerun with test-database access. The production audit query was not executed. No commit, push, PR, merge or deployment was performed.

FIFO suppression follow-up validation (2026-10-15): **55 focused tests passed, 0 failed** (warning-cache unit regression, return-inventory safety integration and expiry tests). Coverage checks more than 1,000 distinct order IDs, visibility at saturation, oldest-entry eviction, retained-order suppression, the 1,000-entry memory bound and concurrent callers; existing integration tests continue to verify blocked stock release. TypeScript build, Prisma validation and `git diff --check` passed. The full suite was not rerun for this isolated logging change; its preceding result remains 1,288 passed, 0 failed, 3 skipped. No database writes or dependencies were added to warning suppression.
