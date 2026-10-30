# Separate gap: pre-dispatch item/quantity cancellation and refund requests

Owner policy confirmed 29 October 2026: Return Management starts only after confirmed dispatch. Paid pre-dispatch orders use the existing cancellation/refund/support process, and should support selected order items/quantities or the whole order. Unpaid orders must not initiate payment refunds.

Read-only inspection of current Backend/Admin/Frontend main found:

- Backend `CreateRefundSchema` (`src/domain/refunds/refundValidator.ts`) accepts paymentId and a monetary amount, with optional reason/reference/refundId; it has no orderItemId/quantity allocation. Strict parsing rejects extra item selection fields.
- Backend `createRefundHandler` is ADMIN-only and routes monetary refunds to the existing provider services. A partial monetary amount is supported; that is not an item-level cancellation/request workflow.
- `requestPaidCancellation` records an order-level audit intent and fences dispatch; it takes orderId/reason/idempotency key, not selected lines.
- `cancelFullyRefundedOrder` requires the whole payment's finalized refundedAmount to equal its amount and restores all original order items. It does not cancel/reduce selected quantities while preserving remaining fulfilment.
- Admin `operations-contract.ts` exposes amount-based Initiate refund and whole-order Request paid cancellation / Cancel fully refunded order. No line/quantity request queue or allocation exists.
- Customer account orders have no dedicated pre-dispatch item-level refund-request endpoint or selection UI. The existing support channel can receive a written request, but does not itself supply the missing tracked item/quantity workflow.

Therefore the confirmed item-level requirement is a **separate functional gap**, not completed by Return Management V1. A manual arbitrary-amount refund must not be represented as implemented item-level cancellation or restocking.

Return Management does not change these APIs, Stripe/PayPal calls, financial reservations or inventory-release rules. The storefront points paid pre-dispatch customers to the existing support process and asks them to specify selected items/quantities or the whole order; it does not promise that an automated item-refund workflow exists. Unpaid orders show no paid-refund action. A separate owner-approved task should define the item allocation, remaining fulfilment and stock/accounting effects before implementing this gap. No gap fix, payment call, production operation or new refund feature was executed here.
