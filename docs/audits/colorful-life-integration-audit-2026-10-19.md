# Colorful Life — Three-System Integration Audit

**Date:** 19 October 2026. **Mode:** read-only. Clean, detached worktrees of each repository's `origin/main` were used. No source files, branches, issues, databases, cloud resources or provider state were changed. No servers or workers were started, no payments were initiated and no emails were sent.

## 1. Executive summary

**Overall integration verdict: PARTIAL.** **Admin production readiness: NO-GO.**

The parts of the Admin that exist are well built and match the Backend:

- All 50 Admin API calls resolve to existing Backend routes, with matching methods and paths.
- Validation is strict, and the typecheck and unit tests are green.
- Product creation, catalogue presentation, categories, purchasing, order listing, preparing and dispatch are properly integrated.

Since the Backend production-audit remediation (PR #209) was merged, the Admin has fallen behind it in two ways:

1. **Two confirmed contract breaks (P1).** The Admin rejects payloads the Backend now produces for normal operations:
   - an external (dashboard) refund, which has no actor;
   - an FBA outbound with a shortfall.

   The first hides refund history and blocks dispatch. The second wedges FBA recording in that Admin install.
2. **No Admin UI for the financial and inventory workflows the Backend now enforces.** These are refund initiation, the staged paid cancellation (request, withdraw, cancel-refunded), refund-review resolution, provider-evidence replay, security holds, stocktake (needed to clear F8 inventory discrepancies) and the order audit history.

   The Backend blocks fulfilment when any of these is pending, but the operator can neither see why nor fix it from the Admin.

On the Storefront side, customers see the order status and the dispatch tracking number. They see nothing about refunds, cancellation reasons, Preparing, or delivery progress. Orders never reach Completed because nothing in the Admin triggers completion. "More on the Way" and "Discontinued" states don't exist in any of the three systems.

## 2. Revision and environment baseline

| System | Path (verified via `origin`) | Audited revision | Local checkout |
|---|---|---|---|
| Admin (Electron + React 19) | `~/projects/colorful-life-admin` → `colorful-life-ltd/colorful-life-admin` | `d1b4ea1` (2026-10-18, merge of PR #50) | On `main` = `origin/main`, clean |
| Backend (Express + Prisma 7) | `~/projects/colorful-life-backend` → `colorful-life-ltd/colorful-life-backend` | `9b443de` (2026-10-19; includes merge of PR #209 `e6f0279` and `eb7818d`) | On `main` = `origin/main`; untracked `.playwright-mcp/` only |
| Storefront (React 19 + Vite) | `~/projects/colorful-life-frontend` → `colorful-life-ltd/colorful-life-frontend` | `5621da1` (2026-10-16, merge of PR #69) | On `main` = `origin/main`; uncommitted asset/CSS changes, not audited |

Similarly named `*-issue-*`, `*-production-audit` and `*-backups` folders are feature worktrees or copies and were not used.

The Admin calls the Backend from the Electron main process (`electron/*-service.ts`), configured by `COLORFUL_LIFE_BACKEND_URL` (HTTPS required except on localhost; `electron/backend-url.ts`). The Storefront uses `VITE_API_BASE_URL`, defaulting to `/api` (`src/features/catalogue/api.ts:165`).

## 3. Feature-by-feature integration matrix

### Admin features that exist

| Section | Feature / action | Backend contract | Status |
|---|---|---|---|
| Auth | Sign in / refresh / sign out / profile with ADMIN check | `POST /auth/login`, `/auth/refresh`, `/auth/logout`, `GET /profile` | Fully integrated |
| Products | Add listing (NEW) with category, price, initial stock, retired flag | `POST /products` (schema matches, `condition` required) | Fully integrated (always published; see P2-2) |
| Products | Add Used offer with condition photos | `POST /products/:productId/used-offers` | Fully integrated |
| Products | Product images: list, upload, reorder, alt text, delete | `/products/by-product/:id/images[...]` | Fully integrated |
| Products | Catalogue presentation: feature product, catalogue artwork | `PATCH /products/by-product/:id/feature`, `PUT/DELETE .../catalogue-artwork`, `GET /admin/product-listings` | Fully integrated |
| Edit products | Search, edit shared metadata (title, set number, theme, age, pieces, retired, category) | `GET /admin/products`, `PATCH /admin/products/:id`, `GET /admin/products/product-availability` | Fully integrated, metadata only |
| Categories | List, create, edit text, artwork and thumbnail artwork, availability summary | `/admin/categories[...]` | Fully integrated |
| Purchases | Import invoice PDF, manual purchase, history, detail | `/purchases/import`, `/purchases/manual`, `/purchases/manual-supplier-options`, `/purchases`, `/purchases/:id` | Fully integrated |
| Purchases | Review: amend line, resolve listing, create listing, disposition, receive into stock | `/purchases/:id/review[...]` | Fully integrated |
| Purchases | Analytics by supplier and month | `/purchase-analytics[...]` | Fully integrated |
| Orders | List (paginated), detail, customer and address, items, shipments, fulfilment history | `GET /admin/orders`, `GET /admin/orders/:id` | Fully integrated |
| Orders | Payment and refund read-only view | `GET /orders/:id/payments`, `GET /orders/:id/refunds` | **Broken** for orders with an external refund (P1-1) |
| Orders | Mark Preparing, Confirm Shipment | `POST /admin/orders/:id/fulfilment/preparing`, `/dispatch` | Integrated; block reasons hidden (P2-1) |
| Orders | Seller-cancel (unpaid orders only) | `POST /orders/:id/seller-cancel` | Fully integrated |
| Inventory | Listing stock table (current / reserved / available) | `GET /admin/product-listings` | Fully integrated |
| Inventory | Movement ledger | `GET /products/:id/inventory-movements` | Fully integrated |
| Inventory | Home-to-Amazon FBA outbound with crash-safe journal | `POST /inventory/fba-outbounds`, `GET /inventory/fba-outbounds/:id` | **Broken** for shortfall shipments (P1-2) |

No UI-only or mock features were found. Every visible action calls the Backend.

### Backend capabilities with no Admin UI ("Not implemented" in Admin)

| Backend capability (route) | Why it matters |
|---|---|
| Refund initiation and reconcile (`POST /orders/:id/refunds`, `.../refunds/:refundId/reconcile`) | No way to refund a customer from the Admin |
| Paid cancellation (`POST /admin/orders/:id/request-paid-cancellation`, `withdraw-paid-cancellation`, `cancel-refunded`) | The owner-accepted staged workflow (F10) is API-only |
| Order audit history (`GET /admin/orders/:id/audit`) | Operators can't see cancellation, manual-payment or provider-resolution audit records |
| Refund reviews and provider evidence (`/admin/refund-reviews[...]`) | Refund holds can't be resolved from the Admin |
| Payment security holds and maintenance (`/admin/payment-security[...]`) | The Admin message says such a hold "cannot be released here" |
| PayPal webhook reviews (`/admin/paypal/webhook-reviews[...]`) | PayPal is disabled today, so lower priority |
| Stocktake and condition adjustments (`POST /inventory/stocktakes`, `/inventory/condition-adjustments`, `POST /products/:id/inventory-adjustments`) | The only way to clear an F8 inventory discrepancy |
| Listing price, sale price and stock edit (`PATCH /products/:id`) | Prices can only be set at creation |
| Publish/unpublish (`isPublished` on `PATCH /admin/products/:id`); listing deactivate/reactivate (`PATCH /products/:id/deactivate`, `/reactivate`) | Products can't be withdrawn from sale |
| Order completion (`POST /orders/:id/complete`) | Orders never reach COMPLETED |
| Returns (`POST /orders/:id/returns`, authorize, receive, inspect, complete, cancel) | Post-dispatch returns and restock are API-only |
| Manual bank payment (`POST /orders/:id/payments`) | Low priority (card payments only) |
| Business expenses (`/business-expenses`); purchase-item receive/return (`/purchase-items/:id/...`); condition conversions | Unused; possibly superseded by purchase review |
| Legacy `POST /orders/:id/dispatch` and `/orders/:id/confirm` | Duplicate or legacy contracts the Admin no longer uses |

## 4. Findings

There are no P0 findings: I found no path where money or stock is corrupted, because the Backend fences hold in every case. The P1 items are confirmed defects or gaps that block production operation.

### P1-1 — Admin rejects refunds that have no actor, which hides refund history and blocks dispatch (confirmed)

- **Admin:** `electron/order-financials.ts:69` requires `id(r.performedByUserId)`.
- **Backend:** since PR #209, verified dashboard/provider refunds are imported with `performedByUserId: null` (`src/domain/refunds/refundWebhookService.ts:50-52`; migration `20261025120000_production_audit` dropped NOT NULL). `GET /orders/:id/refunds` returns raw rows (`src/domain/refunds/refundService.ts:170-174`).
- **Effect:**
  - `parseRefunds` throws, and the refund panel shows "Refund history could not be read".
  - `dispatchFinancialWarning` returns "Financial information is incomplete", which disables Preparing and Dispatch (`src/Orders.tsx:133-134`).
  - This affects even a *partial* dashboard refund, which the Backend allows to ship.
  - Because the Admin has no refund UI, dashboard refunds are currently the *only* refund path, so this will occur.
- **Evidence:** a scratch probe fed a Backend-shaped refund row with `performedByUserId: null` to `parseRefunds`, and it threw.
- **Fix:** accept `null` and show it as "Provider dashboard / external".

### P1-2 — FBA outbound with a shortfall is treated as malformed and wedges the shipment journal (confirmed)

- **Admin:** `electron/inventory-service.ts:43` requires `movement.quantityChange === -outbound.quantity`.
- **Backend (F8):** `quantity` is the *actual* shipped amount, while the movement records only the *applied* deduction; `appliedQuantity` and `shortfall` are new fields (`src/domain/inventory/fbaOutboundService.ts:21-35, 61-76`).
- **Effect:** the Backend commits the outbound, but the Admin throws `malformed-response` after the journal has been set to `uncertain` (`:132`). `finish()` refuses to discard an uncertain journal (`:147-151`), and every retry replays the same key, which returns 200 and fails the same parse. `prepare()` then refuses any new shipment while a saved one exists (`:117-119`). FBA recording in that Admin install stays blocked until someone edits the local journal file by hand.
- **Evidence:** a scratch probe fed a Backend-shaped shortfall response to `parseOutbound`, and it threw.
- **Fix:** validate `quantityChange === -appliedQuantity` and `quantity === appliedQuantity + shortfall`, and show the shortfall to the operator.

### P1-3 — No Admin path for refunds or paid cancellation (missing UI; the Backend is complete)

- **Current state:** the Admin can cancel only unpaid orders (`electron/order-contract.ts:45`; `src/Orders.tsx:137`, "Cancellation is unavailable for orders with a payment record").
- **Missing:** refund initiation, `request-paid-cancellation`, `withdraw-paid-cancellation` (with `requestId` and `CANCELLATION_VERSION_CONFLICT` handling), `cancel-refunded`, and the order audit view.
- **Effect:** the owner-accepted staged cancellation (F10) can't be operated from the Admin.

### P1-4 — No Admin path to resolve inventory discrepancies (missing UI; the Backend is complete)

- An FBA shortfall blocks new orders, confirmation and fulfilment on the affected listing until an ADMIN stocktake with a reason (`src/domain/inventory/inventoryAdjustmentService.ts:148-153`).
- The Admin has no stocktake, adjustment or discrepancy display (`src/Inventory.tsx`, 112 lines: list, ledger and FBA only).
- **Effect:** workflow 6 can't be completed from the Admin.

### P2

1. **Fulfilment block reasons are hidden.** `electron/order-service.ts:76-80` maps `ORDER_PAYMENT_NOT_VERIFIED` to one generic message and special-cases only security review. The Backend's specific reasons appear only in the message text: `CANCELLATION_PENDING`, `INVENTORY_DISCREPANCY`, `PROVIDER_DISPUTE_REVIEW_REQUIRED`, `PROVIDER_REVERSAL_REVIEW_REQUIRED`, `PAYMENT_UNRESOLVED`, `PAYMENT_AMOUNT_MISMATCH`, `REFUND_IN_PROGRESS`, `FULLY_REFUNDED` (`src/domain/fulfilment/fulfilmentErrors.ts:31-35`). Operators can't tell what to fix.
2. **No price, stock or publication control after creation.** `ProductMetadataUpdate` (`electron/product-contract.ts:143`) excludes `isPublished`, prices and stock. Every Admin-created product is published immediately (the Backend defaults to `isPublished: true`, `src/controllers/products.ts:65`) and can't be unpublished from the Admin.
3. **Orders never complete, and the Storefront ignores fulfilment progress.**
   - There is no Admin call to `POST /orders/:id/complete`, and the tracking poller doesn't complete orders.
   - The Storefront shows only the status label, plus carrier and tracking number when the order is DISPATCHED (`src/components/account/CustomerOrders.tsx:129`).
   - It ignores the `fulfilment` object the Backend already returns: Preparing, In transit, Delivered and the tracking URL (`src/domain/fulfilment/fulfilmentPresenter.ts:47-72`).
4. **Customers can't see refunds or cancellation details.**
   - The customer order read omits refunds and cancellation fields (`src/domain/orders/orderReadService.ts:6-37`).
   - The Storefront shows only "Cancelled" (`src/features/orders/presentation.ts:4`).
   - A refunded customer sees no refund amount or status. This needs a Backend projection *and* Storefront UI.
5. **Returns workflow is API-only.** The Backend has full returns routes (`src/routes/orders.ts:64-90`); there is no Admin UI.
6. **Refund-review, provider-evidence and security-hold UIs are missing.** Holds from PR #209 can only be investigated or resolved through raw API calls.
7. **No CI and no packaging for Admin or Storefront.** Neither repository has `.github/workflows`. The Admin has no packager (no electron-builder or forge in `package.json`), so operators must run it from source.

### P3

1. The Admin inventory view doesn't show FBA actual, applied and shortfall, or open discrepancies.
2. Unused or duplicate Backend contracts are candidates for deprecation or documentation: `POST /orders/:id/dispatch`, `/orders/:id/confirm`, `/business-expenses`, `/purchase-items/:id/receive|return`, `/inventory/condition-conversions/:productId`.
3. The Storefront dispatch notice uses the legacy flat columns, not the shipment list. This is fine for today's single-shipment model.

### Not implemented (definition needed, not a defect)

**"More on the Way" and "Discontinued" states** exist in none of the three systems. Only "Out of stock" is shown (`VehiclesProductPage.tsx:30`); sold-out products stay listed by design (`productCatalogueService.ts:28`). "Retired Set" (`isRetired`) is the nearest equivalent. The owner needs to define these states and their data source.

## 5. API contract evidence (key items)

| Admin call (file:line) | Backend route (file:line) | Match |
|---|---|---|
| `GET /admin/orders?page&pageSize` (`order-service.ts:101`) | `adminOrders.ts:44` → `orderReadService.ts:111-124` | ✓ pagination shape matches |
| `GET /admin/orders/:id` (`:105`) | `adminOrders.ts:61` → `orderReadService.ts:127-149` | ✓ |
| `POST .../fulfilment/preparing`, `/dispatch` (`:106-107`) | `adminOrders.ts:84,98` | ✓ body `{carrier, carrierName?, trackingNumber, actualShippingCost}` |
| `POST /orders/:id/seller-cancel` (`:108`) | `orders.ts:61` | ✓ |
| `GET /orders/:id/refunds` (`:88`) | `orders.ts:98` → `refundService.ts:162-175` | ✗ null actor rejected (P1-1) |
| `POST /inventory/fba-outbounds` (`inventory-service.ts:130`) | `inventory.ts:8` → `fbaOutboundService.ts:39-83` | ✗ shortfall shape rejected (P1-2) |
| `POST /products` (`product-service.ts:233`) | `products.ts:21` (schema `:72-87`) | ✓ |
| `PATCH /admin/products/:id` (`:288`) | `adminProducts.ts:16`; validator accepts `isPublished` | ✓; Admin never sends `isPublished` |
| `/purchases/:id/review/*` (`purchase-service.ts:208-236`) | `purchaseReview.ts:17-23`, `purchaseListings.ts:21,41` | ✓ |

Authorization matches: every Admin-used Backend route enforces ADMIN at the route, router or controller level, and the Admin rejects non-ADMIN sessions at sign-in (`auth-service.ts`).

## 6. Missing UI versus missing Backend functionality

| Gap | Missing in |
|---|---|
| Refunds, paid cancellation, withdrawal, audit history, refund reviews, provider-evidence replay, security holds, stocktake/adjustments, price/stock edit, publish/unpublish, completion, returns | **Admin UI only** (Backend complete) |
| Customer-visible refund status and cancellation reason | **Backend projection + Storefront UI** |
| Fulfilment progress (Preparing, In transit, Delivered, tracking link) for customers | **Storefront UI only** (Backend already returns it) |
| More on the Way / Discontinued | **All three** (needs a definition first) |

## 7. Storefront consistency and data flow

- **Availability** is computed by the Backend as `currentStock − reservedStock` (`productCatalogueService.ts:38, 56-57`; public detail `products.ts:319-320`). The Storefront sells an offer only when it is active, has `availableStock > 0` and is NEW or AVAILABLE used stock (`src/features/catalogue/api.ts:72-74`). The Admin shows current, reserved and available consistently. Ownership is clean: the Backend owns all availability decisions, and neither client recomputes stock.
- **Publication:** the Storefront lists only `isPublished` products (`productCatalogueService.ts:30`), and the cart refuses unpublished or inactive listings (`cartService.ts:54`). The Admin can't change either flag.
- **Images and categories** propagate through the catalogue read. The Storefront parses `productImages` and `category`.
- **Order status:** labels cover all 7 statuses. The tracking number is visible after dispatch. COMPLETED, Preparing, delivery progress, refunds and cancellation reasons are not visible (P2-3, P2-4).
- **Customer information:** the Admin order detail shows name, email and delivery address. That's appropriate, and I found no over-exposure.

## 8. End-to-end workflow status

| # | Workflow | Status | Evidence |
|---|---|---|---|
| 1 | Admin creates product → Storefront shows it | **Verified from code** | `POST /products` (published and active by default) → `GET /products` filters `isPublished` and sellable offers |
| 2 | Admin changes price or stock → Storefront reflects it | **Partial** | Price can be set at creation only. Stock changes only through purchase receiving or FBA. The Storefront rereads available stock on each fetch. |
| 3 | Customer orders → Admin receives and processes | **Verified from code** | Storefront `POST /orders` (with Idempotency-Key, `checkout/api.ts:58`) → `GET /admin/orders` |
| 4 | Admin prepares and dispatches → customer sees status | **Partial** | DISPATCHED and the tracking number are visible. Preparing, delivery progress, tracking link and COMPLETED are not. |
| 5 | Admin cancels or refunds → customer sees outcome | **Unpaid cancel: verified. Paid cancel and refund: not implemented in Admin. Refund visibility: not implemented. External-refund view: broken.** | P1-1, P1-3, P2-4 |
| 6 | Admin corrects inventory discrepancy → orders become eligible | **Not implemented in Admin; FBA shortfall entry broken** | P1-2, P1-4 |

UNVERIFIED (not executed):

- live runtime across the three running services;
- the Electron runtime scripts (`test:*-runtime` need an Electron display);
- carrier tracking polling;
- any provider flow.

## 9. Tests and CI

| Repo | Run here | Result | CI |
|---|---|---|---|
| Admin | `tsc -b`, `vitest run`, `eslint .` | typecheck ✓, **492/492** ✓, lint ✓ | **None** |
| Storefront | `tsc -b`, `vitest run`, `eslint .`, `vite build` | ✓, **965/965** ✓, ✓, ✓ | **None** |
| Backend | Not re-run (verified during the PR #209 review: 1,976 passed, 0 failed, 3 skipped) | — | `verify` + `packaging` |

The tests are thorough within each repository but don't cross repository boundaries. The Admin fixtures predate PR #209, which is why P1-1 and P1-2 pass the Admin suite. Nothing checks the Admin parsers against Backend responses.

## 10. Recommended sequence and GitHub Issue proposals (not created)

Each issue can be done independently. Do 1–4 first.

1. **[Admin] Accept provider-origin refunds with no actor in the financial view** (P1-1).
   - *Acceptance:* `parseRefunds` accepts `performedByUserId: null` and shows "External / provider"; a partial external refund leaves dispatch enabled when the Backend allows it.
   - *Tests:* a fixture from the Backend's external refund shape.
2. **[Admin] Support the FBA actual/applied/shortfall contract** (P1-2).
   - *Acceptance:* the parser validates `quantityChange = −appliedQuantity` and `quantity = applied + shortfall`; the shortfall is shown; the journal confirms; replay is idempotent.
   - *Tests:* shortfall and zero-applied fixtures.
3. **[Admin] Staged paid cancellation and refund initiation** (P1-3).
   - *Acceptance:* request → refund (chosen amount, Idempotency-Key) → cancel-refunded; withdraw using `requestId`, handling `CANCELLATION_VERSION_CONFLICT`, `REFUND_ALREADY_INITIATED` and `IDEMPOTENCY_CONFLICT`; all errors mapped to operator messages.
4. **[Admin] Stocktake and inventory discrepancy resolution** (P1-4).
   - *Acceptance:* show open shortfalls per listing; stocktake with an actual count and a reason (at least 10 characters); a count below reservations is refused with an explanation.
5. **[Admin] Show specific fulfilment block reasons** (P2-1).
   - *Preferred:* the Backend returns `reason` as a structured field in the error body. *Fallback:* the Admin maps each reason.
6. **[Admin] Order audit history panel** (`GET /admin/orders/:id/audit`).
7. **[Admin] Listing price, sale price, publish/unpublish and active controls** (P2-2).
8. **[Admin] Refund review, provider-evidence replay and security-hold screens** (P2-6).
9. **[Backend + Storefront] Customer refund and cancellation visibility** (P2-4).
   - *Acceptance:* the customer order read exposes a minimal refund summary and the cancellation state; the Storefront shows it.
10. **[Storefront] Show fulfilment progress and tracking link; [Admin] Mark completed** (P2-3).
11. **[Admin] Returns workflow UI** (P2-5).
12. **[Admin + Storefront] Add CI (typecheck, unit tests, lint, build) and Admin packaging** (P2-7).
13. **[Owner decision] Define More on the Way / Discontinued**, then implement across all three systems.

## 11. Final verdict

**Admin production readiness: NO-GO.**

The two confirmed contract breaks (P1-1, P1-2) will occur in normal operation: dashboard refunds and FBA shortfalls are both expected events. Without P1-3 and P1-4, operators can't refund customers, cancel paid orders or release inventory holds from the Admin.

The verdict moves to **CONDITIONAL GO** once issues 1–4 are delivered. That would still be conditional on issue 5 (block reasons) and on a decision on whether issues 6, 8 and 9 are needed for launch.
