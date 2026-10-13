# Order fulfilment, Phase 1 — Issue #165 (#161)

Admin dispatch and customer tracking. No carrier API, polling, background jobs or automatic Delivered status.

## State model

Payment and fulfilment stay separate. `Payment.status` (and #156 `PaymentResolution`) describe money; `Order.status` remains the single order lifecycle. Fulfilment adds no new `OrderStatus`: **Preparing is a sub-stage of `CONFIRMED`** recorded by `Order.preparingAt`, so cancellation, payment resolution, refund and return rules keyed on `Order.status` are unchanged.

Customer-facing `fulfilment.stage`:

| Order | Stage |
| --- | --- |
| `CONFIRMED`, `preparingAt` null | `CONFIRMED` |
| `CONFIRMED`, `preparingAt` set | `PREPARING` |
| `DISPATCHED` / `COMPLETED` / `RETURNED` with `dispatchedAt` | `DISPATCHED` |
| anything else (`PENDING`, `EXPIRED`, `CANCELLED`, never-dispatched rows) | `null` |

Transitions (all ADMIN, all audited):

| From | To | Endpoint |
| --- | --- | --- |
| CONFIRMED | PREPARING | `POST /admin/orders/:orderId/fulfilment/preparing` |
| PREPARING | DISPATCHED | `POST /admin/orders/:orderId/fulfilment/dispatch` or existing `POST /orders/:orderId/dispatch` |
| CONFIRMED | DISPATCHED | same (Preparing is optional, keeping the existing dispatch flow valid) |

Anything else is rejected without side effects. There is no transition back from PREPARING or DISPATCHED, and Delivered is out of scope.

## Payment eligibility

Checked inside the transaction after `SELECT … FOR UPDATE` on the Order row (shared with payment initiation, webhooks and recovery) and on the Payment row (shared with refund capacity reservation). Both Preparing and Dispatch require:

- a Payment with `status = SUCCEEDED` and `paidAt` set (pending, processing, failed, cancelled or missing payments are rejected; expired/cancelled orders fail the state check);
- no refund in flight (`reservedRefundAmount = 0`) and not fully refunded;
- for orders managed by payment resolution (#156: non-historical `PaymentResolution`), `state = PAID` and no quarantine. Historical resolution rows (all pre-#156 orders, `REVIEW_REQUIRED`) defer to the verified payment record, matching `managedResolution()`; otherwise no legacy paid order could ever be dispatched.

Rejection: HTTP 409 `{error:{code:"ORDER_PAYMENT_NOT_VERIFIED",message}}` (message names `NO_PAYMENT`, `PAYMENT_NOT_SUCCEEDED`, `PAYMENT_UNRESOLVED`, `REFUND_IN_PROGRESS` or `FULLY_REFUNDED`). The existing dispatch endpoint applies the same check.

## Admin API

Both endpoints sit under the existing `/admin/orders` router (authentication with the current database role, ADMIN only: 401/403 as documented in [admin-order-management.md](admin-order-management.md)). Success returns HTTP 200 with the admin order detail (below).

`POST /admin/orders/:orderId/fulfilment/preparing` — body `{}` (no fields accepted). Repeating it on a Preparing order is a no-op returning 200 (no new audit event).

`POST /admin/orders/:orderId/fulfilment/dispatch`

```json
{ "carrier": "ROYAL_MAIL", "trackingNumber": "AB 123 456 789 GB", "actualShippingCost": 3.5 }
```

- `carrier`: `ROYAL_MAIL` | `EVRI` | `DPD` | `OTHER`. `carrierName` (1–100 chars) is required for `OTHER` and rejected otherwise.
- `trackingNumber`: required; spaces/hyphens removed and uppercased, then validated: Royal Mail `^[A-Z]{2}\d{9}GB$`, Evri 16 alphanumerics, DPD 14 digits, OTHER 6–40 alphanumerics.
- `actualShippingCost`: required, 0–100000 (seller cost, admin-only).
- Unknown fields (including any URL or timestamp) are rejected. The dispatch time is database time.
- Repeating the same carrier/tracking number on a dispatched order is an idempotent 200 (no new shipment, audit event or email). Different details: 409 `ORDER_ALREADY_DISPATCHED`; shipment data is never overwritten.

Errors: 400 invalid id `{error:"Invalid order id"}` or Zod-formatted body; 404 `{error:"Order not found"}`; 409 `FULFILMENT_TRANSITION_INVALID`, `ORDER_PAYMENT_NOT_VERIFIED`, `ORDER_ALREADY_DISPATCHED`; 500 `INTERNAL_SERVER_ERROR`.

Response (abridged):

```json
{
  "id": 41, "status": "DISPATCHED", "fulfilmentStage": "DISPATCHED",
  "preparingAt": "2026-10-13T10:00:00.000Z", "dispatchedAt": "2026-10-13T11:00:00.000Z",
  "shippingCarrier": "Royal Mail", "trackingNumber": "AB123456789GB", "actualShippingCost": "3.5",
  "fulfilment": { "stage": "DISPATCHED", "...": "same as the customer view" },
  "shipments": [{ "id": 7, "sequence": 1, "carrier": "ROYAL_MAIL", "carrierName": "Royal Mail",
    "trackingNumber": "AB123456789GB", "dispatchedAt": "2026-10-13T11:00:00.000Z", "createdByUserId": 3, "createdAt": "…" }],
  "fulfilmentEvents": [
    { "id": 1, "action": "PREPARING_STARTED", "fromStage": "CONFIRMED", "toStage": "PREPARING", "shipmentId": null,
      "source": "ADMIN_FULFILMENT_API", "createdAt": "…", "performedByUser": { "id": 3, "email": "admin@example.com" } },
    { "id": 2, "action": "DISPATCHED", "fromStage": "PREPARING", "toStage": "DISPATCHED", "shipmentId": 7,
      "source": "ADMIN_FULFILMENT_API", "createdAt": "…", "performedByUser": { "id": 3, "email": "admin@example.com" } }
  ]
}
```

`GET /admin/orders/:orderId` returns the same shape; `GET /admin/orders` items add `preparingAt` and `fulfilmentStage`.

The existing `POST /orders/:orderId/dispatch` keeps its body and success response. It now also requires a verified payment (409 above), records the Shipment and a `LEGACY_DISPATCH_API` audit event, accepts Preparing orders, and limits `shippingCarrier`/`trackingNumber` to 100 characters. Its free-text carrier is mapped to a trusted carrier only on an exact alias (`royal mail`, `evri`/`hermes`, `dpd`/`dpd uk`); otherwise the shipment has `carrier: null` and no tracking link. A repeat still returns 400.

## Customer API

`GET /orders` and `GET /orders/:orderId` remain ownership scoped (another customer's order is 404, including for admins). Each order adds:

```json
"fulfilment": {
  "stage": "DISPATCHED",
  "preparingAt": "2026-10-13T10:00:00.000Z",
  "dispatchedAt": "2026-10-13T11:00:00.000Z",
  "shipments": [{
    "sequence": 1, "carrier": "ROYAL_MAIL", "carrierName": "Royal Mail", "trackingNumber": "AB123456789GB",
    "dispatchedAt": "2026-10-13T11:00:00.000Z",
    "trackingUrl": "https://www.royalmail.com/track-your-item#/tracking-results/AB123456789GB",
    "trackingUrlIncludesNumber": true
  }]
}
```

Tracking links come only from server-side carrier templates with a validated, URL-encoded number; stored or submitted URLs never exist. Royal Mail deep-links to the result. Evri and DPD link to their official tracking pages (`trackingUrlIncludesNumber: false`) because no deep-link format was verified; the customer enters the displayed number there. `OTHER`, unmapped legacy carriers and invalid stored numbers return `trackingUrl: null`. Shipment creators, audit events and shipping cost are never exposed to customers.

## Data model and historical compatibility

Migration `20261017120000_add_order_fulfilment` is additive:

- `Order.preparingAt` (nullable): every existing order starts not-Preparing.
- `Shipment` (`orderId`, `sequence`, trusted `carrier` or null, `carrierName`, `trackingNumber`, `dispatchedAt`, `createdByUserId`), unique `(orderId, sequence)`, `sequence >= 1`. Phase 1 creates only sequence 1; multiple parcels later add sequences without schema change. `Order.shippingCarrier`/`trackingNumber`/`dispatchedAt` stay as the first-shipment summary used by existing admin reads and the dispatch email.
- `OrderFulfilmentEvent`: append-only audit (action, from/to stage, shipment, ADMIN, source, database time).

No rows are backfilled and no status changes. Orders dispatched before this migration have no Shipment or audit rows; reads present them from the Order fields (stage `DISPATCHED` only when status is DISPATCHED/COMPLETED/RETURNED **and** `dispatchedAt` is set). Their tracking link appears only if the stored carrier name maps exactly to a trusted carrier and the stored number is valid for it. No order is ever presented as Preparing, Dispatched or Delivered without the corresponding recorded data.

## Phase 2 follow-ups

- Carrier tracking APIs (Royal Mail and others) with In Transit / Delivered from verified carrier evidence; extend `FulfilmentStage` and audit actions.
- Verify or obtain official deep-link formats for Evri and DPD; confirm the Royal Mail template remains supported.
- Multiple parcels: allow sequences > 1, partial dispatch rules and per-parcel notifications.
- Admin corrections (wrong tracking number) as an audited amendment rather than overwrite.
- Optionally backfill Shipment rows for historical dispatches after data review.
