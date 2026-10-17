import { z } from 'zod';

export const paypalRiskEvents = [
  'PAYMENT.CAPTURE.DECLINED', 'PAYMENT.CAPTURE.REVERSED',
  'CUSTOMER.DISPUTE.CREATED', 'CUSTOMER.DISPUTE.UPDATED', 'CUSTOMER.DISPUTE.RESOLVED',
  'CHECKOUT.PAYMENT-APPROVAL.REVERSED',
];
const identifier = z.string().min(1).max(256);
export const riskFields = {
  resourceStatus: identifier.optional(),
  disputeId: identifier.optional(),
  sellerTransactionIds: z.array(identifier).max(100).optional(),
  providerUpdatedAt: z.string().datetime({ offset: true }).optional(),
  disputeOutcome: identifier.optional(),
  invalidFields: z.array(z.string().max(100)).max(100).optional(),
};

/** Called only after signature verification. No links, names, addresses, free text,
 * custom_id, invoice_id, buyer transaction IDs, or full provider payload retained. */
export function normalizePayPalRiskResource(eventType: string, input: unknown) {
  const invalid: string[] = [];
  const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
  const resource = object(input);
  if (resource !== input) invalid.push('resource');
  const text = (obj: Record<string, unknown>, key: string, path = key) => {
    if (obj[key] === undefined) return undefined;
    const parsed = identifier.safeParse(obj[key]);
    if (!parsed.success) { invalid.push(path); return undefined; }
    return parsed.data;
  };
  const dispute = eventType.startsWith('CUSTOMER.DISPUTE.');
  const id = text(resource, dispute ? 'dispute_id' : 'id');
  const status = text(resource, 'status');
  const related = object(object(resource.supplementary_data).related_ids);
  const amount = object(resource.amount);
  const approval = eventType === 'CHECKOUT.PAYMENT-APPROVAL.REVERSED';
  const transactions = resource.disputed_transactions;
  const sellerIds: string[] = [];
  if (dispute) {
    if (!Array.isArray(transactions) || transactions.length < 1 || transactions.length > 100) invalid.push('disputed_transactions');
    else for (const transaction of transactions) {
      const sellerId = text(object(transaction), 'seller_transaction_id', 'disputed_transactions.seller_transaction_id');
      if (sellerId) sellerIds.push(sellerId); else invalid.push('disputed_transactions.seller_transaction_id');
    }
  }
  const updated = text(resource, 'update_time');
  const validUpdated = updated === undefined ? undefined : riskFields.providerUpdatedAt.safeParse(updated);
  if (validUpdated && !validUpdated.success) invalid.push('update_time');
  const value = text(amount, 'value', 'amount.value');
  const currency = text(amount, 'currency_code', 'amount.currency_code');
  if (value && value.length > 32) invalid.push('amount.value');
  if (currency && currency.length !== 3) invalid.push('amount.currency_code');
  if (!dispute && !approval && !id) invalid.push('id');
  if (dispute && !id) invalid.push('dispute_id');
  const orderId = approval ? text(resource, 'order_id') : text(related, 'order_id', 'supplementary_data.related_ids.order_id');
  if (approval && !orderId) invalid.push('order_id');
  return {
    ...(!dispute && !approval && id ? { captureId: id } : {}),
    ...(orderId ? { paypalOrderId: orderId } : {}),
    ...(status ? { resourceStatus: status } : {}),
    ...(value && value.length <= 32 ? { amount: value } : {}),
    ...(currency?.length === 3 ? { currency } : {}),
    ...(dispute && id ? { disputeId: id } : {}),
    ...(dispute ? { sellerTransactionIds: [...new Set(sellerIds)].sort() } : {}),
    ...(validUpdated?.success ? { providerUpdatedAt: validUpdated.data } : {}),
    ...(dispute ? { disputeOutcome: text(object(resource.dispute_outcome), 'outcome_code') } : {}),
    ...(invalid.length ? { invalidFields: [...new Set(invalid)].sort() } : {}),
  };
}
