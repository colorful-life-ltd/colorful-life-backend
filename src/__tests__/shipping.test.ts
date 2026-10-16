import assert from 'node:assert/strict';
import { it } from 'node:test';
import { Decimal } from '@prisma/client/runtime/client';
import { CreateOrderSchema } from '../domain/orders/orderValidator.js';
import { orderFinancials, resolveShipping, shippingOptions } from '../domain/orders/shipping.js';

for (const [code, charge, min, max] of [['STANDARD', 399, 3, 5], ['EXPRESS', 799, 1, 3]] as const) it(`${code} authoritative offer and exact arithmetic`, () => {
  const offer = resolveShipping(code);
  assert.deepEqual(offer, { method: code === 'STANDARD' ? 'Standard Delivery' : 'Express Delivery', chargePence: charge, minWorkingDays: min, maxWorkingDays: max, estimatesFrom: 'DISPATCH' });
  const total = new Decimal('12.50').add(new Decimal(charge).div(100));
  assert.deepEqual(orderFinancials({ totalAmount: total, confirmationDeliverySnapshot: offer, orderItems: [{ lineTotal: new Decimal('12.50') }] }).shipping, { code, ...offer });
  Object.assign(offer, { chargePence: 0 }); assert.equal(resolveShipping(code).chargePence, charge);
});
it('catalogue has no default and returns both GBP offers', () => {
  assert.deepEqual(shippingOptions(), { currency: 'GBP', methods: [{ code: 'STANDARD', ...resolveShipping('STANDARD') }, { code: 'EXPRESS', ...resolveShipping('EXPRESS') }] });
});
for (const method of [undefined, null, '', 'standard', 'FREE', 399]) it(`rejects missing or unsupported method ${method}`, () => {
  assert.equal(CreateOrderSchema.safeParse({ items: [{ productListingId: 1, quantity: 1 }], shippingMethod: method }).success, false);
});
for (const key of ['shippingCharge', 'chargePence', 'totalAmount', 'confirmationDeliverySnapshot', 'actualShippingCost']) it(`rejects client financial override ${key}`, () => {
  assert.equal(CreateOrderSchema.safeParse({ items: [{ productListingId: 1, quantity: 1 }], shippingMethod: 'STANDARD', [key]: 0 }).success, false);
});
it('historical absent, malformed and inconsistent delivery stays unknown, never free', () => {
  for (const snapshot of [null, {}, { ...resolveShipping('STANDARD'), chargePence: -1 }, resolveShipping('STANDARD')]) {
    const view = orderFinancials({ totalAmount: new Decimal('12.50'), confirmationDeliverySnapshot: snapshot, orderItems: [{ lineTotal: new Decimal('12.50') }] });
    assert.equal(view.shipping, null); assert.equal(view.merchandiseSubtotal, '12.50'); assert.equal(view.totalAmount, '12.50');
  }
});
it('frozen historical valid prices and estimates are not repriced against the catalogue', () => {
  const snapshot = { ...resolveShipping('STANDARD'), chargePence: 125, minWorkingDays: 8, maxWorkingDays: 9 };
  const view = orderFinancials({ totalAmount: new Decimal('13.75'), confirmationDeliverySnapshot: snapshot, orderItems: [{ lineTotal: new Decimal('12.50') }] });
  assert.deepEqual(view.shipping, { code: 'STANDARD', ...snapshot });
});
