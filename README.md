# Colorful Life Backend

Backend API for **Colorful Life**, a production-oriented e-commerce platform built for selling LEGO sets and related products.

The project focuses on the parts of e-commerce where correctness matters most: inventory consistency, order lifecycle management, payment reconciliation, concurrency, idempotency, and refund accounting.

The backend currently supports the core customer journey from product discovery through payment, fulfilment, cancellation, return, and refund.

> **Status:** Backend V1 core complete. Customer storefront and production deployment are in progress.

---

## Tech Stack

- **Node.js 22**
- **TypeScript**
- **Express**
- **PostgreSQL**
- **Prisma ORM**
- **Zod**
- **JWT authentication**
- **Stripe**
- **PayPal**
- **Node.js Test Runner**

Planned production infrastructure:

```text
Route 53
   ↓
Application Load Balancer
   ↓
ECS Fargate
   ↓
RDS PostgreSQL
```

---

## Core Features

### Product Catalogue

- Product and listing management
- LEGO set number matching
- Product search
- Filtering
- Pagination
- Product Images shared by all condition offers
- Inventory-aware catalogue data

Public `GET /products` returns `{ items, pagination }` with one product card per
LegoProduct. A card's top-level `id` is the product identity; its shared
`catalogueArtworkUrl`, `catalogueArtworkPublicId`, `productImages`, and
`isFeatureProduct` describe that LegoProduct. The `offers` array contains the
separately purchasable ProductListings, and each `offers[].id` is the offer
identity. Offer `availableStock` is calculated as
`Math.max(0, currentStock - reservedStock)`; reserved stock is not exposed.
Presentation fields are not duplicated inside offers. Used offer details and
`usedConditionPhotos` remain scoped to their exact ProductListing. The
product-level `GET /products/by-product/:productId` route returns the same
shape, and returns 404 only when the product is missing or unpublished. The existing
`GET /products/:id` route remains a listing-level lookup by ProductListing ID;
its `legoProduct` object contains shared presentation. Cart and order requests
also use ProductListing IDs (`offers[].id`), never the top-level product ID.
Availability reflects inventory at read time; order creation still checks and
reserves stock atomically.

Presentation ownership follows the domain model: Catalogue Artwork, Product
Images, and Feature Product state belong to LegoProduct and survive offer stock
or lifecycle changes. `ProductImage.legoProductId` links each image directly to
the product. `UsedConditionPhoto.listingId` intentionally links evidence to one
physical Used offer, and order items snapshot condition, damage description, and
condition-photo metadata when purchased.

`LegoProduct.isRetired` is manually managed Admin metadata shared by every NEW
and USED_LIKE_NEW offer for that set. Admin `POST /products` accepts an optional
JSON boolean `isRetired` (omission uses the database default `false`); Admin
`PATCH /products/:id` accepts either `true` or `false` to edit the shared product
through a listing ID. Omitting the field during an edit preserves its value.
Strings, numbers, and `null` are rejected. Retirement has no automatic effect on
inventory, availability, pricing, feature selection, or Used offer lifecycle.

`GET /admin/products`, `GET /products`, and
`GET /products/by-product/:productId` expose `isRetired` on each product.
Listing detail (`GET /products/:id`) and product create/update responses expose
it as `legoProduct.isRetired`. Admin should provide one shared product toggle,
independent of offer condition and `UsedOfferLifecycle.RETIRED`.

Admin product editing uses `PATCH /admin/products/:productId`, where the path
ID is the LegoProduct ID returned by `GET /admin/products`. The request is a
partial JSON object containing one or more of `setNumber`, `title`,
`description`, `theme`, `ageRecommendation`, `pieceCount`, `isRetired`,
`isPublished`, and `categoryId`. A successful response is the updated LegoProduct with its
`category` and ordered `productImages`. Missing products return 404, invalid or
missing categories return 400, duplicate set numbers return 409, and empty or
unsupported updates return 400. This route updates no ProductListing or
inventory fields. The existing `PATCH /products/:id` remains listing-ID based
for compatibility.

### Product publication and sitemap (Issue #163)

`LegoProduct.isPublished` controls public visibility independently of stock:

| State | Public list, detail and sitemap | Purchasable |
| --- | --- | --- |
| Published, in stock | Yes, `availability: "IN_STOCK"` | Yes |
| Published, sold out | Yes, `availability: "OUT_OF_STOCK"`, `offers: []` | No |
| Unpublished | No (`GET /products/by-product/:id` and `GET /products/:listingId` return 404) | No |

- `GET /products` and `GET /products/by-product/:productId` return every
  published product and add `isPublished` and a product-level `availability`.
  `offers` still contains only sellable offers, so existing clients never see a
  deactivated, sold or out-of-stock offer. `minPrice`/`maxPrice` filters match
  only products with a sellable offer in range; `availability` ignores them.
- Cart additions and `POST /orders` reject offers of unpublished products with
  the existing inactive-listing errors (cart 409, order creation 400). Existing
  cart lines, historical orders and payments are not modified.
- Admin publishes or unpublishes with `PATCH /admin/products/:productId`
  `{ "isPublished": boolean }`. `POST /products` accepts an optional
  `isPublished` (default `true`, keeping the current Add product flow public).
  `GET /admin/products` and `GET /admin/product-listings` expose the flag.
- Storefront policy (owner-confirmed): products are published by default;
  published products stay visible regardless of stock, zero-stock products show
  `OUT_OF_STOCK` and cannot be bought, and only explicitly unpublished products
  are hidden from public APIs and the sitemap.
- Legacy migration policy: an existing product is published when at least one
  of its *active* offers is purchasable now (NEW, or AVAILABLE Used, with
  `currentStock > 0`; reservations are ignored as transient) or has stock or
  sales history (any `InventoryMovement` or `OrderItem`), so products that sold
  out before the migration stay public as `OUT_OF_STOCK`. Products with no
  offers or whose offers never held stock (drafts), and products whose offers
  are all deactivated (private), stay unpublished until an Admin publishes them.
- Admin product-availability summaries count a product as `activeProducts` only
  when it is published and has a sellable offer.

Canonical product URLs are `/products/:productId` on the storefront, keyed by
LegoProduct ID and unaffected by offers or stock.

`GET /sitemap.xml` returns a sitemaps.org `urlset` with the storefront home page
and every published product, sold out or not. URLs are absolute and built only
from `PUBLIC_SITE_URL` (a bare http(s) origin, for example
`https://example.co.uk`); the API or request host is never used. When it is
unset, the endpoint returns 503 `SITEMAP_UNAVAILABLE`. Category pages are not
listed yet: their `/categories/:slug` slugs are derived by the storefront from
curated configuration, so they are not a backend contract. Account, checkout,
order, verification, reset and Admin routes are never listed.

Product `lastmod` is the later of the product's `updatedAt` (metadata and
publication changes) and its newest Product Image; offer price and stock changes
do not change it. Above 50,000 URLs (the protocol limit), `/sitemap.xml`
becomes a `sitemapindex` of `/sitemap-1.xml`, `/sitemap-2.xml`, … pages,
ordered by product ID. Entries are bounded in length, so each file stays far
below the 50 MiB limit (enforced defensively). Responses are
`application/xml; charset=utf-8` with `Cache-Control: public, max-age=3600`.

Public-domain routing: the sitemap must be reachable on the canonical storefront
host. Route both `/sitemap.xml` and `/sitemap-*.xml` (pattern
`^/sitemap-[1-9][0-9]*\.xml$`) on that host to this backend (reverse proxy or
hosting rewrite) ahead of the SPA fallback, then add
`Sitemap: https://<production-domain>/sitemap.xml` to the storefront's
`public/robots.txt`. The `/sitemap-*.xml` rule is required even while the
catalogue fits in one file: once it passes 50,000 URLs, `/sitemap.xml` becomes a
`sitemapindex` whose `<loc>` entries are `https://<production-domain>/sitemap-N.xml`
on the storefront host, never the API host. Without that rule the SPA would
answer those child URLs with HTML and crawlers would drop them. When the
catalogue fits in one file, `/sitemap-N.xml` returns 404. Serving `/sitemap.xml`
only from the API host (authorised by the storefront robots.txt `Sitemap:`
line) works for the single-file form only, because the index's child URLs
always point at the storefront host.

### Admin Presentation Listing Feed

`GET /admin/product-listings` requires a Bearer token for an ADMIN account
(401 for missing/invalid authentication, 403 for a non-Admin). It returns one
record per ProductListing, including zero-stock, fully reserved, inactive, and
historical Used listings. Each row keeps its ProductListing identity and nests
shared presentation under `legoProduct`; sibling rows therefore return the same
artwork, image set, and Feature Product state. Products without listings have no
record in this feed. This read-only endpoint does not apply public catalogue
sellability filters.
`GET /products` keeps its route, query, pagination, and sellability behavior;
its response exposes presentation once at the LegoProduct root. The LegoProduct
search contract of `GET /admin/products` remains unchanged.

Query parameters follow Admin lookup pagination: `page` defaults to 1 and must
be an integer from 1 to 10,000; `pageSize` defaults to 20 and must be an integer
from 1 to 50. Invalid or unknown parameters return 400. Listings are ordered by
`id` ascending. Pages beyond the end return empty `items` with accurate totals.
Each request reads its count and page from the same database snapshot; separate
page requests may reflect intervening writes.

The exact response shape is:

```ts
{
  items: Array<{
    id: number; // ProductListing ID for offer/inventory operations
    condition: "NEW" | "USED_LIKE_NEW";
    active: boolean;
    usedLifecycle: "AVAILABLE" | "SOLD" | "RETIRED" | null;
    currentStock: number;
    availableStock: number; // Math.max(0, currentStock - reservedStock)
    legoProduct: {
      id: number;
      setNumber: string;
      title: string;
      isFeatureProduct: boolean;
      catalogueArtworkUrl: string | null;
      catalogueArtworkPublicId: string | null;
      productImages: Array<{
        id: number; url: string; publicId: string; altText: string | null; sortOrder: number;
      }>;
      category: { id: number; name: string } | null;
    };
  }>;
  pagination: { page: number; pageSize: number; totalItems: number; totalPages: number };
}
```

Categories come directly from the backend Category relation, including newly
created categories such as Juniors. `availableStock` describes inventory only;
it does not imply that an inactive or historical listing is sellable. Feature
and artwork values belong to LegoProduct. Admin Presentation Management uses
`items[].legoProduct.id` for presentation actions and `items[].id` for
offer/inventory actions.

`GET /admin/categories/:id/product-availability` returns category-wide
`totalProducts`, `activeProducts`, and `inactiveProducts`. Counts are over
distinct LegoProduct rows, including products without listings. A product is
active when it is published and has at least one listing accepted by the
storefront sellability predicate (published sold-out products are listed by
`GET /products` but count as inactive here); retired-set status does not
exclude an otherwise sellable product. This summary is independent of the
paginated listing feed.

### Category Artwork

Category opening artwork remains in `imageUrl` and `imagePublicId`. The
catalogue category-list/index thumbnail is stored independently in
`thumbnailUrl` and `thumbnailPublicId`. `GET /categories` and category objects
in public product responses expose `thumbnailUrl`; public responses omit
`thumbnailPublicId`. Admin category responses include both thumbnail fields.

All category artwork operations require an ADMIN Bearer token. Existing
`PUT /admin/categories/:id/artwork` accepts multipart field `file` and uploads
or replaces opening artwork. Existing `DELETE /admin/categories/:id/artwork`
removes opening artwork. `PUT /admin/categories/:id/thumbnail-artwork` accepts
multipart field `file` and uploads or replaces the catalogue thumbnail;
`DELETE /admin/categories/:id/thumbnail-artwork` removes that thumbnail. Both
upload routes accept JPEG, PNG, or WebP images up to 8 MiB. Replacing or
removing either image affects only its own URL, public ID, and stored asset.

New thumbnail columns are nullable. Existing categories retain their current
opening artwork and may have a null `thumbnailUrl`. Legacy static storefront
thumbnail assets remain in use until the separate storefront migration; this
backend change does not copy or migrate those assets.

### Admin Product Presentation Endpoints

All endpoints below require an ADMIN Bearer token. Product identity is explicit
in the route; clients must use LegoProduct IDs for presentation operations.

- `GET /products/by-product/:productId/images` returns `{ productImages }`.
- `POST /products/by-product/:productId/images` uploads multipart field `file`
  and optional `altText`; it returns `{ image }`.
- `PATCH /products/by-product/:productId/images/order` accepts
  `{ imageIds: number[] }` and returns `{ productImages }`.
- `PATCH /products/by-product/:productId/images/:imageId` accepts
  `{ altText: string | null }` and returns `{ image }`.
- `DELETE /products/by-product/:productId/images/:imageId` removes one product
  image and returns 204.
- `PUT /products/by-product/:productId/catalogue-artwork` uploads multipart
  field `file` and returns `{ catalogueArtwork: { url, publicId } }`.
- `DELETE /products/by-product/:productId/catalogue-artwork` removes the shared
  artwork and returns 204.
- `PATCH /products/by-product/:productId/feature` selects that LegoProduct as
  the one featured product for its category and returns `{ id, isFeatureProduct }`.
  If its category changes while selection waits for locks, it returns 409;
  reload the product and retry the selection.

Product image limits and content validation are unchanged. A migration preflight
preserves unambiguous legacy artwork and image rows, including image IDs, sort
order, and alt text. It aborts transactionally when sibling artwork differs,
multiple sibling listings own Product Images, image public IDs or sort orders
collide, artwork storage IDs are shared between products, or Feature state
conflicts within a category or a featured product has no category. Existing
Cloudinary public IDs remain unchanged; future uploads use the LegoProduct ID
prefix. Operators must resolve each reported LegoProduct ID explicitly before
retrying migration.

Before deploying this ownership migration, stop and drain all old Backend
instances/workers and other database clients using these tables. The migration
takes `ACCESS EXCLUSIVE NOWAIT` locks on `LegoProduct`, `ProductListing`, and
`ListingImage` before reading any legacy state and holds them through commit.
An active reader/writer makes lock acquisition fail immediately; roll back and
resolve the failed Prisma migration according to the controlled deployment
procedure before retrying. No source data is changed on preflight/lock failure.
Do not resume old application instances after contraction; deploy the new
Backend and coordinated clients before accepting traffic.

Feature uniqueness is enforced by a product/category partial unique index and
a CHECK requiring a category for featured products. Application selections and
automatic first-Feature creation still serialize with category advisory locks.
Direct writes are constrained by the database without a row trigger acquiring
advisory locks after row locks. Category moves into an already-featured category
must first clear the moving product's Feature state (or are rejected atomically).

### Client contract migration for Issue #118

**Admin:** send LegoProduct IDs to Product Image and Catalogue Artwork routes
and Feature selection. Read shared Feature, artwork, and Product Images from
`items[].legoProduct`; retain `items[].id` for offer and inventory actions.

**Storefront:** read `productImages`, `catalogueArtworkUrl`,
`catalogueArtworkPublicId`, and `isFeatureProduct` once from the product card
root. Offer price, stock, condition, lifecycle, and damage description remain
inside `offers[]`. Used Condition Photos remain inside the exact Used offer.

### Customer Accounts

- Registration and authentication
- JWT-based authorization
- Customer profile management
- Email verification
- Password reset
- Email address changes
- UK address lookup
- Multiple customer addresses
- Default shipping and billing addresses
- Account deletion and personal-data erasure

### Orders

- Customer order creation
- Server-authoritative pricing
- Order lifecycle management
- Inventory reservation
- Reservation expiry
- Overselling protection
- Customer order history
- Seller cancellation
- Customer cancellation rules
- Dispatch tracking
- Manual order completion

### Inventory

- Physical stock tracking
- Reserved stock tracking
- Atomic inventory reservation
- Inventory movements
- Website-sale deductions
- Cancellation restoration
- Condition adjustment
- Stock write-off

### Payments

Supported payment providers:

- Stripe
- PayPal
- Manual payments

Payment processing includes:

- Provider-specific payment creation
- Server-derived payment amounts
- Stable idempotency
- Duplicate-payment protection
- Provider reconciliation
- Signed webhook handling
- Payment failure/cancellation handling
- Late-payment protection for expired orders

### Returns & Refunds

- Return management
- Partial refunds
- Stripe refunds
- PayPal refunds
- Manual refunds
- Refund-capacity reservation
- Concurrent refund protection
- Provider reconciliation
- Idempotent webhook processing
- Over-refund protection

### Fulfilment

- Order dispatch
- Shipping carrier
- Tracking number
- Actual shipping cost
- Dispatch notifications
- Order completion

---

## Commerce Lifecycle

A normal customer order follows this lifecycle:

```text
Product Catalogue
       ↓
Create Order
       ↓
PENDING
       ↓
Reserve Inventory
       ↓
Stripe / PayPal
       ↓
Provider Payment
       ↓
Webhook Reconciliation
       ↓
CONFIRMED
       ↓
DISPATCHED
       ↓
COMPLETED
```

The browser is never treated as the authority for payment or inventory state.

---

## Inventory Reservation

Inventory is separated into two concepts:

```text
currentStock
```

represents physical stock, while:

```text
reservedStock
```

represents stock committed to pending customer orders.

Available stock is therefore derived from:

```text
availableStock = currentStock - reservedStock
```

When an order is created, inventory is reserved atomically without immediately reducing physical stock.

Pending reservations expire after a defined reservation window.

When payment is successfully reconciled and the order is confirmed:

```text
reservedStock ↓
currentStock  ↓
```

and the corresponding inventory movement is recorded.

If an unpaid pending order expires or is cancelled, its reservation is released without changing physical stock.

This separation allows the backend to protect inventory during checkout without treating an unpaid order as a completed sale.

---

## Overselling Protection

Inventory reservation is performed atomically.

Concurrent customers cannot successfully reserve the same final unit of stock.

The backend does not rely on a frontend stock check because a value displayed in the browser may already be stale by the time an order is submitted.

The database therefore remains the authority for inventory availability.

---

## Payment Architecture

Payment providers are represented internally rather than selected by arbitrary client input.

```text
Payment
├── MANUAL
├── STRIPE
└── PAYPAL
```

The backend derives authoritative payment information from the persisted order.

The client cannot determine:

- authoritative order amount
- payment amount
- currency
- refund provider
- final payment state

A typical provider payment flow is:

```text
Customer
   ↓
Backend
   ↓
Validate Order
   ↓
Derive Amount from Order
   ↓
Create / Reuse Provider Payment
   ↓
Stripe / PayPal
   ↓
Provider Webhook
   ↓
Signature / Event Validation
   ↓
Reconciliation
   ↓
Local Payment State
```

Provider network requests are intentionally performed **outside database transactions**.

---

## Customer checkout API (Issue #144)

All three checkout endpoints require an authenticated, email-verified customer.

### `POST /orders`

The existing validated payload is `{ items: [{ productListingId, quantity }], deliveryAddress?: { recipientName, line1, line2?, city, county?, postcode, countryCode, phone? } }`. Prices and billing snapshots remain server-authoritative.

Send `Idempotency-Key: <client-generated-key>` before the first creation attempt and retain it until the result is known. Keys accept 1–128 printable ASCII characters without spaces. The header is optional for backward compatibility; requests without it have no retry guarantee.

The same customer, key and validated request return the same persisted order with its original pricing and address snapshots, including after an ambiguous HTTP result or process restart. Both first creation and replay return **201** using the existing response shape. A replay returns the order's current lifecycle state. Item ordering and JSON field ordering do not affect identity; changing quantity, listing or delivery intent does. Saved address or server price changes do not change an existing request's identity.

Errors use `{ "error": { "code": "...", "message": "..." } }`:

- **400 `INVALID_IDEMPOTENCY_KEY`**: invalid key format.
- **409 `ORDER_IDEMPOTENCY_MISMATCH`**: key already used by this customer for a different request. Use the original payload to recover, or a new key for a new intentional order.
- **403 `EMAIL_VERIFICATION_REQUIRED`**: verify the account before creating an order.

Existing payload, address, listing and stock validation errors remain unchanged. Failed transactions do not consume the key. A committed order retains the key even after payment, expiry or cancellation; retries never create another order or extend its reservation.

The order stores a unique `(userId, creationIdempotencyKey)` and SHA-256 canonical request hash. A transaction-scoped PostgreSQL advisory lock serializes matching requests across processes. Identity, order/items and stock reservations commit atomically. These internal identity fields are omitted from the creation API response. This is separate from Stripe's existing `order-<id>-stripe` provider idempotency key.

### `GET /orders/:orderId`

An owner can recover checkout using the existing safe order/item fields plus:

- `payment: null` before a payment exists; otherwise exactly `{ status, paidAt }`. `paidAt` is an ISO timestamp or null.
- `reservationExpiresAt`: ISO timestamp or null (cleared when the reservation is consumed or released).
- Billing snapshot fields: `billingRecipientName`, `billingLine1`, `billingLine2`, `billingCity`, `billingCounty`, `billingPostcode`, `billingCountryCode`, `billingPhone`.
- Delivery snapshot fields: `deliveryRecipientName`, `deliveryLine1`, `deliveryLine2`, `deliveryCity`, `deliveryCounty`, `deliveryPostcode`, `deliveryCountryCode`, `deliveryPhone`.

Optional snapshot values are null. Provider references, client secrets, raw payments, refund accounting and webhook details are excluded. Another customer's order and a missing order both return **404**. `GET /orders` retains its existing list projection.

### `POST /orders/:orderId/payments/stripe`

Only a `PENDING` order whose reservation deadline has not elapsed can start/reuse normal checkout. Existing legacy PENDING records with a null deadline retain their previous eligibility. Already successful payments cannot restart or create another charge. The successful response remains **201 `{ clientSecret }`**; Stripe network calls remain outside database transactions and provider idempotency is unchanged.

Stable conflict errors use the same error envelope:

- **409 `ORDER_EXPIRED`**: status EXPIRED or elapsed reservation deadline.
- **409 `ORDER_NOT_PAYABLE`**: CONFIRMED, DISPATCHED, COMPLETED, CANCELLED or RETURNED.
- **409 `PAYMENT_ALREADY_COMPLETED`**: successful payment, another payment provider, or success reconciled while initiation was in flight.

Missing/other-owner orders remain **404** and provider unavailability remains **503**. Re-read the order after a conflict or ambiguous initiation response.

### `POST /orders/:orderId/payments/stripe/reconcile` (Issue #146)

Explicit fallback for a missed Stripe webhook. Requires authentication, verified email and ownership of the order, just like customer checkout reads. No request body or query parameters are required; any browser-supplied intent ID, success status or amount is ignored. The backend selects the existing local Stripe Payment and retrieves its persisted `providerReference` server-side. It never creates, confirms, cancels or refunds a provider payment.

**200** returns exactly the safe `GET /orders/:orderId` Order projection, including `status`, `payment: { status, paidAt }`, reservation expiry, items and address snapshots. It does not expose the retrieved intent, provider references, client secrets or reconciliation internals. HTTP 200 means recovery inspected the provider state; it does **not** by itself mean payment/order confirmation succeeded. The storefront must inspect both payment and order status.

For a valid Stripe `succeeded` result, recovery validates the local payment/order identity, unchanged persisted reference, exact returned intent ID, required `metadata.orderId`, payment amount against order total, exact GBP amount/currency, and `amount_received` equal to the expected amount. It then uses the same transaction/domain transition as webhook reconciliation: Payment SUCCEEDED/paidAt, PENDING → CONFIRMED and exactly-once reservation conversion/inventory movement. `paidAt` follows the existing convention: time the backend first records success, preserved on subsequent reconciliation.

All non-success statuses (`processing`, `requires_payment_method`, `requires_action`, `requires_confirmation`, `requires_capture`, `canceled`) leave local payment/order state unchanged. A stale non-success response cannot overwrite a webhook success. Re-read the returned local state; never start another charge merely because recovery remains pending.

Errors:

- **400**: invalid order ID.
- **401**: existing `AUTH_REQUIRED` / `SESSION_INVALID` authentication errors.
- **403 `EMAIL_VERIFICATION_REQUIRED`**: account verification required.
- **404**: same response for missing and other-customer orders.
- **409 `STRIPE_RECOVERY_UNAVAILABLE`**: no local payment, non-Stripe payment, or missing/pending provider reference. Recovery will not guess an intent or create one to repair a placeholder.
- **409 `STRIPE_RECOVERY_MISMATCH`**: provider/local correlation or financial validation failed, including a changed payment identity while retrieval was in flight. No recovery business changes commit.
- **503**: Stripe unavailable or not configured; no recovery business changes commit.
- **500 `INTERNAL_SERVER_ERROR`**: internal/inventory conversion failure; the recovery transaction rolls back and the same request can safely retry after the underlying problem is resolved.

Stripe retrieval runs outside the database transaction. Recovery then locks the order, reloads the exact local payment and validates current identity before applying shared reconciliation. Webhook/recovery/repeated recovery use the same lock, monotonic success rules and confirmation implementation. Successful retrieval evidence is retained in the existing `PaymentWebhookEvent` store with distinct `eventType: payment_intent.recovered` and namespaced identity `recovery:<local-payment-id>:<intent-id>:succeeded`; this is a recovery audit record, not a claimed Stripe webhook delivery. The record and business changes commit atomically. Repeated recovery retains one audit record and cannot deduct inventory again.

Terminal-state rules remain unchanged. EXPIRED/CANCELLED/RETURNED orders retain their status; captured success is recorded with the existing refund/reconciliation exception in the evidence store. CONFIRMED/DISPATCHED/COMPLETED orders are not reset or converted again. No automatic refund is introduced.

An elapsed deadline alone does not release an order's reservation: recovery can confirm a still-reserved PENDING order if it commits before expiry. If expiry commits first—even while recovery retrieves Stripe—the order remains EXPIRED and success follows the existing late-payment exception path. This issue does not redesign expiry or guarantee automatic discovery before expiry.

The verified webhook remains the primary path. Normal GETs remain local reads. The storefront may subsequently wire its explicit “Recheck order status” action to this POST and inspect the returned Order; bounded retries/polling of GET alone cannot discover a completely missed webhook. Frontend integration is separate.

### Authoritative confirmation and recovery

**Stripe browser/client success is not authoritative.** Clients must re-read `GET /orders/:orderId` and require successful payment plus a confirmed/fulfilment order state before displaying normal confirmation. A `SUCCEEDED` payment attached to an EXPIRED or CANCELLED order is a late-payment exception, not normal fulfilment. Pending/processing responses require continued backend polling/recovery.

A verified, correctly correlated Stripe success with matching amount and GBP currency atomically sets payment SUCCEEDED/paidAt and confirms a still-PENDING order through the existing reservation conversion logic. The automated inventory movement is attributed to the order customer. Receipt deduplication, order-row locks and a conditional initiation update preserve exactly-once inventory conversion and monotonic payment success. Inventory failure rolls back the receipt and payment transition so webhook redelivery or reconciliation with the same event can retry; it cannot silently commit success without confirmation.

Expiry, cancellation and confirmation serialize on the same order row. If expiry/cancellation commits first, late success records payment evidence and a refund/reconciliation exception without resurrecting the order. If success commits first, expiry becomes a no-op. A deadline alone does not release stock: while the order remains PENDING with its reservation, authoritative reconciliation can win before the expiry transaction. Existing refund infrastructure handles late-payment exceptions; this change does not automatically issue a refund.

---

## Idempotency

Payment and refund operations use stable idempotency identities.

This protects the system from situations such as:

- customer retries
- network timeouts
- duplicated HTTP requests
- provider retries
- webhook redelivery
- concurrent requests

A retry should converge on the existing logical payment or refund rather than create additional financial operations.

---

## Webhook Reconciliation

Provider webhooks are treated as external financial evidence.

Webhook events are recorded using `PaymentWebhookEvent` and deduplicated by provider event identity.

The Stripe webhook endpoint verifies the raw request body using the Stripe signature and webhook signing secret before reconciliation.

Webhook processing is designed to be idempotent:

```text
Provider event
      ↓
Verify
      ↓
Deduplicate
      ↓
Correlate
      ↓
Validate amount / currency / identity
      ↓
Reconcile local state
```

Repeated delivery must not double-apply payment or refund accounting.

---

## Late Payment Protection

An important edge case occurs when a customer begins payment but the local inventory reservation expires before the payment provider reports final success.

Colorful Life deliberately does **not** resurrect the expired order.

```text
Reservation expires
       ↓
Order = EXPIRED
       ↓
Inventory released
       ↓
Provider later reports successful payment
       ↓
Payment is recognised
       ↓
Order remains EXPIRED
       ↓
Refund / reconciliation required
```

The backend does not:

- reactivate the expired order
- silently reserve inventory again
- fulfil an order whose inventory commitment has already expired

This prevents a late provider response from creating an oversold order.

---

## Refund Accounting

Refunds distinguish between money already confirmed as refunded and refund capacity currently held by an in-progress provider operation.

```text
Payment.refundedAmount
```

represents provider-confirmed refunded money.

```text
Payment.reservedRefundAmount
```

represents refund capacity reserved by non-final refund attempts.

The core invariant is:

```text
refundedAmount + reservedRefundAmount <= paymentAmount
```

A refund therefore follows approximately:

```text
Admin requests refund
       ↓
Read original Payment provider
       ↓
Check refundable capacity
       ↓
Atomically reserve capacity
       ↓
Commit DB transaction
       ↓
Call Stripe / PayPal
       ↓
Provider response / webhook
       ↓
Final reconciliation
```

The client does not choose whether a refund goes through Stripe or PayPal.

The backend uses the provider stored on the original payment.

This prevents concurrent or repeated refund requests from exceeding the amount originally paid.

---

## Stripe Integration

Stripe support includes:

- PaymentIntent creation and reuse
- Server-authoritative GBP amounts
- Stable idempotency
- PaymentIntent correlation
- Payment webhook reconciliation
- Stripe refund creation
- Refund reconciliation
- Signed webhook verification
- Duplicate webhook handling
- Late-payment handling

Handled payment events include:

```text
payment_intent.succeeded
payment_intent.payment_failed
payment_intent.canceled
```

Refund reconciliation handles:

```text
refund.created
refund.updated
refund.failed
```

Stripe secrets and webhook signing secrets remain backend-only.

The frontend will use only Stripe's publishable credentials and transient payment data required for checkout.

---

## PayPal Integration

PayPal support includes:

- PayPal Order creation
- Payment capture
- Payment reconciliation
- Webhook handling
- Refund creation
- Refund-capacity protection
- Idempotency
- Provider identity tracking

Additional real PayPal Sandbox webhook verification is planned after the backend is available through its public HTTPS sandbox endpoint.

---

## Authentication & Security

Security-related behaviour includes:

- Password hashing
- JWT authentication
- Role-based authorization
- Verified-email requirements for protected customer actions
- Password reset
- Controlled email changes
- Customer ownership checks
- Server-side request validation
- Server-authoritative prices and payment amounts
- Payment-provider webhook verification
- Idempotent provider operations
- Personal-data erasure

Sensitive credentials are supplied through environment variables and must never be committed to the repository.

### Renewable login sessions

`POST /auth/login` returns the existing access `token` plus `accessTokenExpiresAt`, an opaque `refreshToken`, and `refreshExpiresAt`. Access tokens continue to use `JWT_EXPIRES_IN` (default `1h`). Renewable sessions have a fixed absolute lifetime configured by `REFRESH_SESSION_TTL_DAYS` (default `30`, allowed range `1`–`365` days); refresh does not extend that deadline.

Refresh credentials are random opaque values. The backend stores only their SHA-256 hashes. `POST /auth/refresh` accepts `{ "refreshToken": "..." }` without requiring an access token and returns a new `token`, `accessTokenExpiresAt`, rotated `refreshToken`, and the original `refreshExpiresAt`. The submitted refresh credential becomes invalid after successful rotation. Invalid, expired, revoked, or deleted-user sessions return HTTP 401 with the structured `SESSION_INVALID` error; unexpected database/service failures return HTTP 500 with `INTERNAL_SERVER_ERROR`.

`POST /auth/logout` accepts `{ "refreshToken": "..." }`, revokes that renewable session, and returns HTTP 204. It is safe to repeat for a validly formatted credential. Clients should discard both access and refresh credentials on logout and replace both credentials after every successful refresh. They should schedule an access-expiry warning using `accessTokenExpiresAt` (for example, expiry minus 60 seconds), and must not retry an old refresh credential after rotation. The fixed refresh expiry is the point at which the user must authenticate again.

---

## API Structure

The API is organised around business domains including:

```text
Authentication
Users
Addresses
Products
Orders
Payments
Returns
Refunds
Purchases
Inventory
Business Expenses
```

Routes delegate business rules to domain/service layers rather than placing financial or inventory logic directly inside HTTP controllers.

### Purchase Analytics

Admin-only `GET /purchase-analytics` returns company-wide gross purchased
quantity, purchase-document spend, and spend grouped by supplier. Spend uses
each persisted `PurchaseDocument.finalTotalPaid` once; quantity uses each
`PurchaseItem.quantity` once, regardless of receipt or supplier-return state.
Supplier names are trimmed and grouped case-insensitively. Null or blank names
share the `unknown` key and display as `Unknown supplier`; named suppliers use
a deterministic `supplier-<sha256>` key based on the normalized name.

Admin-only `GET /purchase-analytics/suppliers/:supplierKey/monthly` groups
document spend by the parent purchase's `sourceOrderDate`, in descending
`YYYY-MM` order. Documents without a source order date are excluded from the
month buckets and included in `undatedTotalAmount`. Month grouping uses the
persisted date value directly, without conversion through a timezone. The
analytics endpoints are company-wide and do not inherit the importer scope of
purchase history or review endpoints.

Admin-only `GET /purchases/manual-supplier-options` returns the canonical
supplier names for manual purchase entry as `canonicalSuppliers`, with the
custom-entry UI label returned separately as `customSupplierOption: "Others"`.
`Others` is not a merchant name to persist. Admin should submit the actual
custom name in `merchantName`; `POST /purchases/manual` trims surrounding
whitespace, stores whitespace-only values as `null`, and continues to accept
custom names outside the canonical options. Imported purchase suppliers remain
unrestricted.

Purchase import stages every parsed `PurchaseItem` and does not create or
receive catalogue inventory. Each item has an `inventoryDisposition` of
`INVENTORY` (the default, including for historical unmatched rows) or
`NON_INVENTORY`. A null `productListingId` still means only that no listing is
linked; it does not mean the line is excluded. Admin can deliberately exclude
or restore an unreceived review group with
`PATCH /purchases/:id/review/groups/:itemId/disposition`, sending
`{ "revision": "<current-review-revision>", "inventoryDisposition": "NON_INVENTORY" }`
or `INVENTORY`. Excluded groups appear as `state: "EXCLUDED"`, stop counting as
unresolved purchase work, and cannot be received. Restoring `INVENTORY` clears
any listing link and returns the group to `UNRESOLVED` for explicit matching.
Received groups cannot change disposition. Exclusion does not remove or rewrite
the purchase lines, document totals, or allocated costs. Purchase analytics
continues to count the actual document spend, while its purchased-unit total
counts only `INVENTORY` items.

---

## Testing

The backend has extensive automated coverage across domain logic, HTTP behaviour, persistence, concurrency, payments, refunds, and provider reconciliation.

Current normal regression result:

```text
tests:      619
suites:     83
passed:     616
failed:     0
skipped:    3
```

The three normally skipped tests are explicit opt-in Stripe Sandbox integration tests.

Normal test execution therefore does not make real Stripe network requests.

### Real Stripe Sandbox Verification

The Stripe integration has additionally been tested against the real Stripe Sandbox.

Verified flows include:

```text
Backend
   ↓
Real Stripe Sandbox PaymentIntent
   ↓
Payment confirmation
   ↓
Real Stripe webhook
   ↓
Production webhook endpoint
   ↓
Signature verification
   ↓
Payment reconciliation
```

and:

```text
Backend
   ↓
Real Stripe Sandbox Refund
   ↓
Real Stripe refund event
   ↓
Production webhook endpoint
   ↓
Signature verification
   ↓
Refund reconciliation
```

These opt-in tests verify the external provider boundary without making real-provider calls part of the normal regression suite.

---

## Local Development

### Requirements

- Node.js 22
- PostgreSQL
- npm

Install dependencies:

```bash
npm install
```

Generate the Prisma client:

```bash
npx prisma generate
```

Apply available database migrations:

```bash
npx prisma migrate deploy
```

Build:

```bash
npm run build
```

Start the compiled application:

```bash
npm start
```

---

## Running Tests

Development uses `DATABASE_URL` (normally database `colorful_life`). Automated
tests require a separate `TEST_DATABASE_URL` targeting **exactly
`colorful_life_test`**. Put both URLs in your ignored `.env`, or supply them as
environment variables; see `.env.example`. Credentials must not be committed.
There is no automatic fallback from a missing test URL to the development URL.

Create an empty `colorful_life_test` database on your local PostgreSQL server,
preferably owned by a dedicated test role with no access to development or
production data. For example, using PostgreSQL client tools:

```bash
createdb --host <local-postgres-host> --port 5432 --username <database-admin> \
  --owner <test-role> colorful_life_test
```

In WSL, use the reachable Windows PostgreSQL host address if PostgreSQL runs on
Windows; `localhost` may not resolve to that server. Obtain the host from your
existing local setup. The role must already exist and be allowed to own the test
database. Enter credentials through the PostgreSQL prompt or your local secret
configuration, not a committed command. Do not copy development data into tests.

Run the connection-free safety checks before preparing the database:

```bash
npm run test:safety
npm run test:db:check
```

`test:db:check` builds and validates configuration, reports only the test database
name, and verifies the application selects that URL without connecting to a
database. Normal application startup continues to use `DATABASE_URL` unchanged.

Prepare the schema and run tests:

```bash
npm run test:db:prepare
npm test
# Or run selected compiled integration files:
npm test -- dist/__tests__/cataloguePresentation.integration.test.js
```

Both preparation and `npm test` build first and apply the committed Prisma
migrations using `prisma migrate deploy` against the validated test target.
Applying migrations is repeatable; there is no reset, seed, or development-data
dependency. Tests create and clean up their own fixtures. Test files run serially
to avoid interference between catalogue queries and category-wide feature
selection. Do not run multiple suites against the same test database concurrently.

The shared guard runs before Prisma client construction and before migration or
test subprocesses start. It requires both URLs, rejects production mode, requires
the exact test database name, and rejects matching normal/test database names
even when credentials or host aliases differ. Test URL query parameters are
restricted to `schema=public` and one `sslmode` (`disable`, `require`, `verify-ca`,
or `verify-full`); connection redirection options are rejected. Unsafe or missing
configuration exits nonzero before database activity. Node test workers and direct
`.test.js` execution also use this guard; setting `NODE_ENV=test` alone is
insufficient. Use the npm commands to ensure current builds and migrations.

Real Stripe Sandbox tests are opt-in and require the corresponding environment flag and test credentials.

They must never be enabled against live Stripe credentials.

---

## Environment Configuration

The application uses environment variables for infrastructure and third-party integrations.

Depending on the environment, these include configuration for:

```text
Database
JWT
Email delivery
Stripe
PayPal
Application port / runtime configuration
```

Payment-provider secrets must remain server-side.

Never commit:

```text
.env
Stripe secret keys
Stripe webhook signing secrets
PayPal client secrets
database credentials
JWT secrets
AWS credentials
```

---

## Deployment

The intended production architecture is:

```text
                    ┌──────────────┐
                    │   Route 53   │
                    └──────┬───────┘
                           │
                           ▼
                 ┌──────────────────┐
                 │       ALB        │
                 └────────┬─────────┘
                          │
                          ▼
                 ┌──────────────────┐
                 │   ECS Fargate    │
                 │  Express API     │
                 └────────┬─────────┘
                          │
                          ▼
                 ┌──────────────────┐
                 │ RDS PostgreSQL   │
                 └──────────────────┘
```

Planned environments:

```text
sandbox-api.colorful-life.co.uk
→ Sandbox backend
→ Stripe Sandbox
→ PayPal Sandbox
→ Sandbox database
```

```text
api.colorful-life.co.uk
→ Production backend
→ Stripe Live
→ PayPal Live
→ Production database
```

Deployment is currently pending while the customer-facing storefront is developed.

---

## Current Project Status

### Backend

**V1 core complete.**

Core commerce functionality, inventory reservation, order lifecycle, authentication, payments, returns, refunds, and Stripe Sandbox verification are implemented.

### Frontend

Customer storefront development is the next major project phase.

The intended customer journey is:

```text
Home
→ Catalogue
→ Product Detail
→ Cart
→ Account / Address
→ Checkout
→ Stripe / PayPal
→ Order Confirmation
→ My Orders
```

### Deployment

Production deployment will follow once the customer storefront can exercise the backend as a genuine end-to-end commerce application.

Real public PayPal Sandbox webhook verification will be completed against the deployed sandbox backend before production payment activation.

---

## Development Principles

Several rules guide the project:

1. **The database is authoritative for inventory and commerce state.**
2. **The client never controls authoritative prices or payment amounts.**
3. **Inventory must be protected against concurrent overselling.**
4. **External provider calls should not hold database transactions open.**
5. **Payments and refunds must be idempotent.**
6. **Webhook delivery must be safe to repeat.**
7. **Late payments must not resurrect expired inventory reservations.**
8. **Provider state is reconciled rather than blindly trusted.**
9. **Refund capacity must be reserved before asynchronous refund processing.**
10. **Real provider behaviour is verified with Sandbox integration tests rather than assumed.**

---

## Roadmap

Next:

- Customer storefront V1
- Product catalogue integration
- Customer authentication UI
- Cart and checkout
- Stripe checkout integration
- PayPal checkout integration
- Customer order history
- Sandbox deployment
- Public PayPal Sandbox webhook verification
- Production deployment

## Order and dispatch confirmation email and commercial invoice

See [Issue #180 configuration, rollout, dependencies and test boundaries](docs/order-confirmation-email.md). The new durable order and dispatch senders are independently disabled by default. Existing best-effort dispatch notifications remain available until durable dispatch is explicitly activated. Missing shipping/business facts block invoice issuance; SES readiness failures pause durable workers without blocking API startup.
