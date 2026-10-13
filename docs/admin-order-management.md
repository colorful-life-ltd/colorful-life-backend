# Admin order contract — Issue #151 / Admin #39

All endpoints require `Authorization: Bearer <access token>`. Authentication reads the current database role; a stale ADMIN JWT does not grant access. No verified-email requirement is added to admin routes.

## Verified existing capabilities

Customer `GET /orders` and `GET /orders/:orderId` remain customer scoped, including for admins. Another customer's detail returns 404. Checkout creates inventory reservations; confirmation converts reservations to sales. Cancellation locks the order and releases pending reservations or restores eligible confirmed stock. Consumed Used offers remain terminal. Stripe initiation persists a durable payment placeholder under the order lock before provider I/O. Stripe verified webhooks and recovery reacquire that lock before updating payment and confirming inventory. Dispatch already implements admin authorization and an atomic CONFIRMED → DISPATCHED transition.

## Read requests

- `GET /admin/orders?page=1&pageSize=20`: ADMIN only; page defaults to 1, range 1–10000; pageSize defaults to 20, range 1–50. Only decimal integer query values are accepted. Repeated parameters and unknown parameters return 400. Orders sort by `createdAt DESC, id DESC`. Count and page use a RepeatableRead transaction.
- `GET /admin/orders/:orderId`: ADMIN only; positive decimal integer ID up to 2147483647; no query parameters. Missing order returns 404.

List returns HTTP 200:

```ts
type PaymentStatus = "PENDING" | "PROCESSING" | "SUCCEEDED" | "FAILED" | "CANCELED";
type OrderStatus = "PENDING" | "CONFIRMED" | "DISPATCHED" | "COMPLETED" | "CANCELLED" | "EXPIRED" | "RETURNED";
type Summary = {
  id: number;
  userId: number;
  user: { id: number; firstName: string | null; lastName: string | null; email: string };
  status: OrderStatus;
  totalAmount: string;
  createdAt: string;
  shippingCarrier: string | null;
  trackingNumber: string | null;
  dispatchedAt: string | null;
  payment: { status: PaymentStatus; currency: string; paidAt: string | null } | null;
  paymentStatus: PaymentStatus | null;
  currency: string;
};
type ListResponse = {
  items: Summary[];
  pagination: { page: number; pageSize: number; totalItems: number; totalPages: number };
};
```

No payment means `payment: null`, `paymentStatus: null`, `currency: "GBP"`. GBP is the existing order-pricing currency across checkout and manual payment; where a payment exists, its stored currency is returned verbatim. Do not infer payment success from order status.

Detail returns HTTP 200 with every Summary field plus:

```ts
type DetailFields = {
  updatedAt: string;
  completedAt: string | null;
  actualShippingCost: string | null;
  reservationExpiresAt: string | null;
  cancelledAt: string | null;
  cancelledBy: "CUSTOMER" | "SELLER" | null;
  cancellationReason: string | null;
  deliveryRecipientName: string;
  deliveryLine1: string;
  deliveryLine2: string | null;
  deliveryCity: string;
  deliveryCounty: string | null;
  deliveryPostcode: string;
  deliveryCountryCode: string;
  deliveryPhone: string | null;
  orderItems: Array<{
    id: number;
    quantity: number;
    unitPrice: string;
    lineTotal: string;
    conditionSnapshot: "NEW" | "USED_LIKE_NEW" | null;
    damageDescriptionSnapshot: string | null;
    conditionPhotoSnapshot: unknown | null; // Existing JSON snapshot
    productListing: {
      id: number;
      condition: "NEW" | "USED_LIKE_NEW";
      legoProduct: { id: number; setNumber: string; title: string };
    };
  }>;
};
```

Items sort by ID ascending. Money uses Prisma decimal JSON strings; dates use ISO strings. Shipping uses the order's saved delivery snapshot rather than the user's current address. No separate tax/shipping charge breakdown exists in the current order model; `actualShippingCost` is the seller's dispatch cost, not a customer surcharge. Shipment progress is represented by order status and the carrier/tracking/dispatch fields, plus (Issue #165) `preparingAt`, `fulfilmentStage`, `fulfilment`, `shipments` and `fulfilmentEvents` as described in [order-fulfilment.md](order-fulfilment.md). Passwords, provider references, keys, billing addresses and refund records are excluded.

Read errors follow existing conventions: 401 `{error:{code:"AUTH_REQUIRED"|"SESSION_INVALID",message:string}}`; 403 `{error:{code:"FORBIDDEN",message:"Forbidden: ADMIN only"}}`; invalid list query 400 `{error:<Zod formatted error>}`; invalid detail ID 400 `{error:"Invalid order id"}`; detail query 400 `{error:"Unexpected query parameters"}`; missing detail 404 `{error:"Order not found"}`; internal error 500 `{error:{code:"INTERNAL_SERVER_ERROR",message:"Internal server error"}}`.

## Seller cancellation

`POST /orders/:orderId/seller-cancel`, ADMIN only, JSON `{reason}`. Existing allowed reasons remain `OUT_OF_STOCK`, `PRICING_ERROR`, `PRODUCT_UNAVAILABLE`, `FULFILMENT_ISSUE`, `OTHER`. Successful response remains HTTP 200 with the existing updated Order record.

Eligibility requires PENDING or CONFIRMED, no prior cancellation, and **no payment record**. Payment states PENDING, PROCESSING, FAILED and CANCELED all block cancellation in this phase. FAILED can still be retried; even CANCELED records cannot be cleared without accounting for existing provider operations and delayed evidence. No terminal-provider cancellation or refund workflow is introduced.

- Paid status SUCCEEDED or non-null paidAt: HTTP 409 `{error:{code:"ORDER_ALREADY_PAID",message:"Paid orders cannot be seller-cancelled"}}`.
- Other existing payment: HTTP 409 `{error:{code:"ORDER_PAYMENT_UNRESOLVED",message:"Orders with an existing payment attempt cannot be seller-cancelled"}}`.
- Invalid transition or repeat: existing HTTP 400 `{error:string}`.
- Missing order: existing HTTP 404 `{error:string}`.
- Invalid reason/body: existing HTTP 400 `{error:<Zod formatted error>}`.
- Authentication and authorization: existing 401/403 conventions.

Eligibility is checked inside the transaction **after acquiring SELECT … FOR UPDATE on the order row**. The lock is held through status change and inventory updates. If initiation wins, its durable payment blocks seller cancellation even while provider I/O is pending, fails, or times out. If cancellation wins, Stripe, PayPal and manual initiation reject the cancelled order before creating a payment or contacting a provider. Stripe initiation, webhooks and recovery serialize on the same order-row lock. Issue #153 extends that lock to PayPal initiation response persistence, capture preparation/completion and webhook reconciliation; an existing payment always blocks seller cancellation regardless of stale local failure notifications. Unknown notifications cannot manufacture a payment. Duplicate successful notifications do not reconvert inventory. Repeated cancellation cannot restore stock twice. Missing reservations cause the whole cancellation transaction to roll back.

## Dispatch integration

Keep `POST /orders/:orderId/dispatch` with JSON `{actualShippingCost:number,shippingCarrier:string,trackingNumber?:string}`. Cost is required and nonnegative; carrier is required and trimmed/nonblank; tracking is optional and trimmed; both are at most 100 characters. ADMIN only. Successful response and existing errors are unchanged. Only CONFIRMED (including Preparing) transitions to DISPATCHED; duplicate dispatch cannot overwrite metadata or modify inventory. Since Issue #165 the order's payment must be verified (409 `ORDER_PAYMENT_NOT_VERIFIED`), and each dispatch records a Shipment and an audit event. The Preparing step, trusted-carrier dispatch and customer tracking are documented in [order-fulfilment.md](order-fulfilment.md).

## Admin #39 integration and limitations

Use the new admin read URLs; customer URLs intentionally remain ownership scoped. Render `user` for customer identity, `delivery*` for fulfilment, `orderItems` for product/price snapshots, and `paymentStatus`/`currency` for payment display. Use `pagination` to navigate. Treat no-payment PENDING/CONFIRMED orders as potential cancellation candidates and handle backend 409 conflicts after refresh; eligibility may change between read and mutation. Dispatch only confirmed orders.

This phase deliberately disallows cancellation for any previously attempted payment; enabling cancellation after terminal provider resolution needs a separate lifecycle design. **Unresolved payment attempts can retain stock indefinitely. Production rollout requires a safe payment-resolution and reservation-release process; never delete payment records or release inventory solely because a local timeout elapsed.** Issue #154 extends the no-payment-record eligibility boundary to customer cancellation and reservation expiry; see [payment-safe cancellation and expiry](payment-safe-cancellation-expiry.md). Stripe webhook/recovery processing records reconciliation exceptions for late successful payments on cancelled or expired orders. Issue #154 also adds cancelled-order late-success diagnostics to PayPal capture/webhook processing alongside existing expiry exceptions; [Issue #153](paypal-payment-safety.md) adds PayPal concurrency, ownership and terminal-state protections. PayPal records payment success without automatically confirming the order; ADMIN confirmation remains separate. PayPal diagnostics distinguish a retained reservation past its deadline from an actually CANCELLED/EXPIRED order. These APIs do not repair historical inconsistencies. Offset pagination is deterministic per request, but new inserts can shift later pages between requests. Product names remain current catalogue data; prices, conditions and shipping addresses use the available order snapshots. Admin read/cancellation APIs require no schema changes; #153's approved durable PayPal webhook recovery adds a nullable receipt-evidence field and pending index. No refunds, returns or deployment are included.

## Changed files

- `src/app.ts` — mount admin orders router.
- `src/routes/adminOrders.ts` — authentication, ADMIN checks and read handlers.
- `src/domain/orders/adminOrderValidator.ts` — pagination and ID validation.
- `src/domain/orders/orderReadService.ts` — safe admin projections and paginated reads; existing customer reads preserved.
- `src/domain/orders/orderCancellationService.ts` — locked seller payment eligibility check.
- `src/domain/orders/orderCancellationErrors.ts` — payment eligibility domain error.
- `src/controllers/orders.ts` — seller cancellation 409 mapping.
- `src/utils/apiErrorResponse.ts` — stable cancellation error codes.
- `src/domain/payments/paymentService.ts` — manual initiation rejects cancelled orders.
- `src/domain/payments/paymentErrors.ts` — manual cancelled-order error.
- `src/controllers/payments.ts` — manual cancelled-order 409 mapping.
- `src/domain/payments/paypalOrderService.ts` — PayPal initiation rejects cancelled orders.
- `src/__tests__/orderRead.integration.test.ts` — admin list/detail, pagination, role/ownership, safe projection, currency and shipment coverage.
- `src/__tests__/orderCancellation.integration.test.ts` — seven focused seller cancellation/payment/inventory/concurrency tests.
- `docs/admin-order-management.md` — contract and integration handoff.

## Validation

- `npm run build`: passed.
- `npm run test:db:check`: passed; dedicated `colorful_life_test` target verified.
- Focused cancellation/read/dispatch/payment/Stripe recovery regression: 111 passed, no failures.
- `RUN_STRIPE_SANDBOX_TESTS=false RUN_STRIPE_WEBHOOK_E2E_TESTS=false RUN_STRIPE_REFUND_WEBHOOK_E2E_TESTS=false npm test`: 928 passed, 3 explicitly disabled sandbox tests skipped, no failures (931 total).
- Final admin/customer read regression including stored-currency and shipment assertions: 8 passed, no failures.
- `git diff --check`: passed.

The test runner applied no new migrations. Provider calls in the added tests use local fakes; no live Stripe charge or refund calls were made. No commit, push, PR, production service or deployment was performed.
