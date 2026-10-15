# Cart availability and checkout conflicts — Issue #173

No schema change, migration, stock reservation on cart reads, or frontend implementation is included.

## Additive cart contract

GET /cart and the existing successful add, update, remove and clear responses retain their fields and add an availability object to each item:

```json
{
  "productListingId": 42,
  "quantity": 4,
  "allocatedQuantity": 1,
  "unallocatedQuantity": 3,
  "availability": {
    "status": "INSUFFICIENT_STOCK",
    "reason": "INSUFFICIENT_STOCK",
    "availableQuantity": 2
  },
  "productListing": {
    "availableStock": 2,
    "effectivePrice": "10"
  }
}
```

The example is a subset of the existing response. Status is AVAILABLE, INSUFFICIENT_STOCK, OUT_OF_STOCK or UNAVAILABLE. Reason is a stable code, or null for AVAILABLE. productListingId remains the stable item/listing identifier; messages and reasons must not be parsed from product titles or error prose.

availableQuantity is nonnegative live capacity for **new reservations**, derived from max(0, currentStock - reservedStock). It is zero when publication, active status or Used lifecycle prevents sale. It excludes all current reservations, including the customer's own existing pending orders. Existing allocations are not added back into stock. The existing productListing.availableStock field retains its original stock-only meaning even when metadata makes a listing unavailable.

Cart quantity remains total saved intent. Stock sufficiency compares **unallocatedQuantity**, not the total visible quantity. availableQuantity is a stock capacity, not permission to reclaim allocated cart intent; submission of a matching saved line is also bounded by unallocatedQuantity.

## Deterministic precedence per cart item

First matching rule wins:

1. Unpublished parent product: UNAVAILABLE / PRODUCT_UNPUBLISHED, availableQuantity 0.
2. Inactive listing: UNAVAILABLE / LISTING_INACTIVE, availableQuantity 0.
3. Used listing whose lifecycle is not AVAILABLE: UNAVAILABLE / USED_OFFER_UNAVAILABLE, availableQuantity 0. SOLD and RETIRED offers stay unavailable even if inconsistent historical stock suggests otherwise.
4. No unallocated quantity: UNAVAILABLE / CART_QUANTITY_ALLOCATED. availableQuantity still reports free live capacity, which can be positive; this line has no fresh cart intent for another order.
5. Zero free stock: OUT_OF_STOCK / OUT_OF_STOCK, availableQuantity 0.
6. Unallocated requested quantity exceeds positive free stock: INSUFFICIENT_STOCK / INSUFFICIENT_STOCK.
7. Otherwise AVAILABLE with reason null.

For example, quantity 2, allocatedQuantity 1 and free stock 1 is AVAILABLE for the one unallocated unit. A fully allocated final-unit cart reports CART_QUANTITY_ALLOCATED rather than incorrectly implying that the existing pending reservation was lost. Resume/recover the existing order rather than submit its allocation as a new order. An explicit later addition is new intent, subject to the existing stock checks.

Availability projection does not change, delete or reduce rows or quantities. Reads do not expire orders or settle provenance. Restock, republication and reactivation are reflected on a subsequent fetch. Explicit removal/clear continue to work regardless of availability and detach visible allocations without cancelling an Order. PATCH retains existing validation: customers can reduce an insufficient line to a positive quantity whose unallocated demand fits free stock; unavailable metadata still requires removal or later reactivation.

## Checkout error contract

POST /orders now reports listing availability conflicts as HTTP 409 using the existing error envelope, with additive structured fields:

```json
{
  "error": {
    "code": "INSUFFICIENT_STOCK",
    "message": "Insufficient available stock for product listing 42 (requested 3)",
    "productListingId": 42,
    "requestedQuantity": 3,
    "availableQuantity": 2,
    "reason": "INSUFFICIENT_STOCK"
  }
}
```

```json
{
  "error": {
    "code": "LISTING_UNAVAILABLE",
    "message": "This listing is no longer available",
    "productListingId": 42,
    "availableQuantity": 0,
    "reason": "PRODUCT_UNPUBLISHED"
  }
}
```

| code | reason | meaning |
| --- | --- | --- |
| LISTING_UNAVAILABLE | PRODUCT_UNPUBLISHED, LISTING_INACTIVE, USED_OFFER_UNAVAILABLE | Metadata blocks a new sale |
| LISTING_UNAVAILABLE | LISTING_NOT_FOUND | Submitted listing no longer exists |
| OUT_OF_STOCK | OUT_OF_STOCK | Free stock is zero |
| INSUFFICIENT_STOCK | INSUFFICIENT_STOCK | Requested positive quantity exceeds free stock |
| LISTING_UNAVAILABLE | INVENTORY_RESERVATION_CONFLICT | Conditional inventory guard failed despite apparent free stock; requires reconciliation |
| CART_QUANTITY_UNAVAILABLE | Existing message; no new reason required | Submitted matching cart line lacks unallocated quantity; error now also includes productListingId |

requestedQuantity is supplied for stock/conditional-reservation conflicts. Metadata and missing-listing conflicts supply availableQuantity 0 without needing a quantity. A multi-line request returns one offending submitted line; it need not enumerate all conflicts or select a particular line when several fail. Malformed requests, duplicate listing IDs and address validation retain their prior HTTP 400 behavior. Authentication, verification, payment security, idempotency and other error envelopes retain their existing contracts. Cart mutation error responses retain their existing format.

Metadata validation occurs under existing listing locks, before the provenance plan; a metadata conflict can therefore precede a provenance conflict. Otherwise the provenance plan retains priority over attempting another stock reservation (including when the previous allocation exhausted stock). A matching idempotency retry still returns its existing order, even if live availability subsequently changed; it never makes another reservation.

## Inventory and provenance safety

Cart GET uses the existing RepeatableRead snapshot for listings, cart rows and visible allocations. ACTIVE, CONSUME_PENDING and RELEASE_PENDING provenance remains allocated until reconciliation. Thus reads can briefly show allocations for committed confirmation or release tasks; they never settle that work or infer release from a local timeout.

Checkout remains authoritative. It retains lazy expiry before the creation transaction, customer advisory locks, ascending listing row locks, server pricing, atomic conditional reservations, and order/provenance persistence in one transaction. A failure rolls back all new reservations and creation/provenance changes, including any earlier valid submitted line. Lazy expiry may independently release eligible older orders before a later checkout fails; this existing behavior is not part of the new-order rollback. All managed reservation coverage checks and Issue #171 return/release guards remain intact.

The new contract is a snapshot, not a guarantee of future reservation. Another customer may take stock before checkout. Inconsistent managed reservation coverage can also produce a checkout-only INVENTORY_RESERVATION_CONFLICT even when the cart's stock-only projection appears AVAILABLE. This remains fail-closed and never fabricates, releases or repairs inventory.

Only submitted lines are validated. The backend continues to allow a direct-order subset and lines absent from the cart. Unrelated blocked saved entries do not cause rejection. The cart-wide UX policy in frontend Issue #62 must be implemented by that frontend, not by changing this direct-order API contract.

## Frontend Issue #62 integration

Use status/reason for translated messaging and availableQuantity for “only N available.” Keep unavailable rows and Remove enabled. Preserve requested quantity until an explicit customer change. Refresh on cart opening, checkout mounting and a checkout 409. Highlight the returned productListingId and route definitive conflicts to cart review rather than blindly retrying the saved payload.

Respect allocatedQuantity/unallocatedQuantity and recover existing pending orders. CART_QUANTITY_ALLOCATED means the visible intent belongs to an existing order; apparent free stock does not authorize duplicating it. Reconciliation is eventually consistent. Do not infer provider outcomes from cart availability.

Frontend #62 can block its cart-wide checkout UI when any item is blocked without requiring the backend to reject unrelated direct-order requests. Availability fields are additive; consumers that previously expected plain-string order availability errors must adopt the structured 409 envelope.

## Verification

Database-backed regressions cover live sold-out/reserved-out/insufficient states, metadata precedence, terminal Used offers, restock/republication/reactivation, row preservation, removal, customer-controlled reduction, mixed-line rollback, direct-order subsets, server pricing, managed/legacy provenance, queued reconciliation and real final-unit contention. Test fixture cleanup respects terminal Used guards during assertions; the existing test-only trigger cleanup runs in a rollback-safe transaction in the guarded test database.

Final local validation (2026-10-15), based on origin/main c9fbd2f (merged PR #172 / Issue #171): **192 focused tests passed, 0 failed, 0 skipped**; **full backend suite: 1,311 passed, 0 failed, 3 skipped (1,314 total)**. The three skips are existing opt-in real Stripe sandbox/webhook tests. The 22 new availability regressions run against the guarded test database and local HTTP server, without real provider calls. Earlier test-only cleanup and lock-wait observation failures were corrected before these successful runs. TypeScript build, Prisma validation and final whitespace checks passed. Scope and common credential-pattern review found only expected source, test and documentation changes; no generated files or dependencies changed. No commit, push, PR, merge, deployment, production SQL or production data modification was performed.
