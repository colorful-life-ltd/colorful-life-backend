import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DeliveryAddressSchema} from '../domain/orders/orderValidator.js';
import {customerAddressError,normalizePostcode} from '../utils/customerInput.js';
const base={recipientName:'Synthetic Buyer',line1:'1 Test Road',city:'London',countryCode:'GB'};
test('delivery and shared validation normalise whitespace before the postcode length bound',()=>{
 for(const postcode of ['sw1a1aa','  sw1a   1aa  ','sw1a\t1aa',' SW1A\n1AA ']) {
  assert.equal(normalizePostcode(postcode),'SW1A 1AA');
  assert.equal(DeliveryAddressSchema.parse({...base,postcode}).postcode,'SW1A 1AA');
  assert.equal(customerAddressError({...base,postcode}),null);
 }
 for(const postcode of ['SW1AAAA1AA','         ','not a postcode']) {
  assert.equal(DeliveryAddressSchema.safeParse({...base,postcode}).success,false);
  assert.notEqual(customerAddressError({...base,postcode}),null);
 }
});
