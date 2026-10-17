import type { Business, Invoice, Purchase } from '../../domain/orderConfirmation/contract.js';
// Entirely synthetic identities/logo. Never production business configuration.
export const businessFixture: Business = {
  approved: true, legalName: 'Colorful Life Ltd', registrationNumber: 'TEST-ONLY-000',
  registeredAddress: ['Synthetic company fixture', '1 Fictional Road', 'Testville', 'TEST'], registeredIn: 'England and Wales',
  fromEmail: 'orders@example.test', replyToEmail: 'support@example.test', replyToMonitored: true,
  retentionPolicy: 'Synthetic isolated-test retention policy', invoicePrefix: 'TEST', numberDigits: 8,
  primaryColor: '#234d46', accentColor: '#b6d3c2',
  logo: { mime: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR1kAAAAASUVORK5CYII=', alt: 'Synthetic Colorful Life test logo' },
};
export const purchaseFixture: Purchase = {
  version: 1, orderId: 42, paymentId: 7, paidAt: '2026-10-16T12:00:00.000Z', currency: 'GBP',
  recipientEmail: 'buyer@example.test', firstName: 'Élodie',
  billing: { recipientName: 'Élodie Test', line1: '1 Fictional Street', line2: null, city: 'Testville', county: null, postcode: 'T1 1TT', countryCode: 'GB' },
  shippingAddress: { recipientName: 'Élodie Test', line1: '1 Fictional Street', line2: null, city: 'Testville', county: null, postcode: 'T1 1TT', countryCode: 'GB' },
  items: [{ description: 'Synthetic city set', setNumber: 'TEST-001', quantity: 2, unitPence: 1250, linePence: 2500 }],
  subtotalPence: 2500, totalPence: 2899,
  delivery: { method: 'Standard Delivery', chargePence: 399, minWorkingDays: 2, maxWorkingDays: 4, estimatesFrom: 'DISPATCH' },
};
export const invoiceFixture: Invoice = { version: 1, invoiceNumber: 'TEST-00000001', issuedAt: '2026-10-16T12:01:00.000Z', purchase: purchaseFixture, business: businessFixture };
export const dispatchFixture = {
  version: 1 as const, orderId: 42, shipmentId: 9, sequence: 1, scope: 'FULL_ORDER' as const,
  recipientEmail: purchaseFixture.recipientEmail, firstName: purchaseFixture.firstName,
  dispatchedAt: '2026-10-17T10:00:00.000Z', carrier: 'ROYAL_MAIL' as const, carrierName: 'Royal Mail', trackingNumber: 'AB123456789GB', delivery: purchaseFixture.delivery,
};
