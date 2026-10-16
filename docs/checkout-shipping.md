# Authoritative checkout shipping (Issue #182)

This contract requires frontend Issue #68. There is no implicit shipping default and
no activation flag that permits newly created orders to omit shipping. This is an
intentional breaking change to POST /orders, not permission to deploy it alone.

## Catalogue

GET /orders/shipping-options is public, read-only, and returns:

```json
{
  "currency": "GBP",
  "methods": [
    { "code": "STANDARD", "method": "Standard Delivery", "chargePence": 399, "minWorkingDays": 3, "maxWorkingDays": 5, "estimatesFrom": "DISPATCH" },
    { "code": "EXPRESS", "method": "Express Delivery", "chargePence": 799, "minWorkingDays": 1, "maxWorkingDays": 3, "estimatesFrom": "DISPATCH" }
  ]
}
```

These are estimated working-day ranges after dispatch, not guaranteed arrival dates
or durations after order creation. The catalogue prices new orders only. The frontend
must ask the customer to choose explicitly; it must not invent a default or persist
client secrets. Any local estimate is provisional until the order is reserved.

## Creation

POST /orders requires authentication and verified email, the existing optional
Idempotency-Key header, and:

```json
{
  "shippingMethod": "STANDARD",
  "items": [{ "productListingId": 123, "quantity": 2 }],
  "deliveryAddress": {
    "recipientName": "Synthetic Buyer", "line1": "1 Fictional Road",
    "city": "Testville", "postcode": "T1", "countryCode": "GB"
  }
}
```

Items and address retain existing validation/ownership semantics. deliveryAddress
remains optional (billing fallback). shippingMethod is required, case sensitive and
must be STANDARD or EXPRESS. Missing/invalid methods and unknown top-level fields,
including amounts, totals or invoice snapshot overrides, return HTTP 400 with the
existing Zod field-error format. No order, payment or reservation is created for
these validation failures. There is no client-authoritative financial input.

The backend resolves the offer inside the order transaction, uses Decimal arithmetic,
and persists the existing confirmationDeliverySnapshot with method label, integer
chargePence, min/maxWorkingDays and estimatesFrom. The fixed labels identify the two
methods; do not rename a historical snapshot or infer its price from today's catalogue.
No duplicate columns, migration or Prisma model/client changes are required.

The creation fingerprint includes validated shippingMethod. Identical key/payload
returns the original order; changing method returns existing HTTP 409
ORDER_IDEMPOTENCY_MISMATCH. Persist the entire request with the key on the frontend.
Existing requests from before this contract cannot be replayed by fabricating a
shipping selection: retrieve the existing owned order instead. Do not automatically
create a replacement order after a validation/idempotency error.

## Financial responses

Creation, customer list/detail and admin list/detail expose an additive financials
object. Existing totalAmount and item/address/paymentWindow fields remain intact:

```json
{
  "financials": {
    "currency": "GBP",
    "merchandiseSubtotal": "25.00",
    "shipping": {
      "code": "STANDARD", "method": "Standard Delivery", "chargePence": 399,
      "minWorkingDays": 3, "maxWorkingDays": 5, "estimatesFrom": "DISPATCH"
    },
    "totalAmount": "28.99"
  }
}
```

Decimal money strings are pounds; fields named Pence are integer pence. totalAmount
is the authoritative order amount, NOT evidence of payment. Use paymentWindow.state
PAID / verified payment status for financial success and the existing fulfilment
status for order confirmation. Never enable a payment action from shipping data.

shipping is null when no valid, financially consistent persisted delivery snapshot
exists. Null means UNKNOWN, not FREE. Merchandise subtotal still sums stored line
amounts. A valid non-catalogue historical label has code null but retains its actual
persisted price/estimates. A valid older offer is never repriced. Reads do not mutate
orders, payment records, stock, jobs or snapshots and add no per-order database query.
Customer responses do not include actualShippingCost. Admin detail keeps that field
as the merchant's separate expense. Carrier, tracking and return shipping cost are
unaffected. An order's addresses remain separate from the delivery service.

## Financial safety and invoice handoff

Sum of persisted merchandise lines + persisted customer charge = Order.totalAmount
= Payment.amount = verified Stripe amount. Shipping is added only at creation;
Stripe creation/reuse/retry/recovery/webhooks continue their existing ownership,
amount/currency/admission checks. Do not adjust amounts on existing PaymentIntents.
Managed resolution, inventory conversion/release and cancellation are unchanged.
Refund amounts remain administrator specified with existing reserved/refunded
capacity checks; there is no automatic delivery-refund allocation.

The delivery snapshot exists before payment. The verified-success transition freezes
it into the Issue #180 purchase source. Existing validation reconciles all amounts;
invoice numbering, issue dates, PDF cache/hash, retry/UNKNOWN handling and early-
dispatch invoice delivery remain unchanged. The exact statement remains:

> Colorful Life Ltd is not VAT registered. No VAT has been charged. This document is a commercial invoice, not a VAT invoice.

Historical null snapshots are not backfilled and old immutable blocked jobs are not
repaired by this feature. Requeue cannot replace their frozen source. Handle any
historical accounting exception through a separately approved process.

## Coordinated rollout / rollback

1. Validate backend and frontend #68 together in isolation, including signed mocked
   webhook-to-captured-invoice acceptance. Keep production email controls unchanged.
2. Prepare frontend #68 to consume this catalogue and send an explicit method; deploy
   the matching frontend/backend as one controlled checkout release. Pause new order
   creation at the traffic layer during the cutover, while keeping webhooks,
   reconciliation and existing-order payment/status services available. The shipping
   backend must be serving before accepting the new frontend's checkout requests.
3. Reopen checkout only after checking the deployed contract end to end. Old tabs
   receive 400 for missing method and must reload; never default or silently retry
   them into newly priced orders. Do not deploy the new frontend against the old
   backend, which would strip the method and charge merchandise only.
4. There is no shipping migration. Existing Issue #180's 64-migration baseline must
   already be applied; retain its migration-first readiness checks.
5. If the release fails, pause new checkout. Keep this backend contract and payment
   processors in place; fix forward or use a separately reviewed compatible rollback.
   Rolling back to merchandise-only order creation while checkout is open violates
   the shipping/invoice contract. Do not reprice existing orders, delete payment jobs,
   downgrade invoice migrations or turn on email sending as part of this release.

Shipping completion alone does not authorize production invoices/email: approved
company/accounting/retention/recipient configuration, monitored Reply-To, SES access,
authentication/monitoring and email-client acceptance remain separate blockers.
No production deployment, live provider operation or real customer email is part
of implementation/testing.
