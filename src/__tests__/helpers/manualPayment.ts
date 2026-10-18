import { randomUUID } from 'node:crypto';
import { prisma } from '../../prisma/runtime.js';
import { createPayment as record } from '../../domain/payments/paymentService.js';
import type { CreatePaymentInput } from '../../domain/payments/paymentValidator.js';
let actorId: number | undefined;
/** Synthetic bank evidence; production callers cannot omit actor or supporting evidence. */
export async function createPayment(orderId: number, input: CreatePaymentInput) {
    actorId ??= (await prisma.user.create({ data: { email: `manual-test-${randomUUID()}@example.com`, passwordHash: 'not-a-real-password', emailVerified: true, role: 'ADMIN' } })).id;
    return record(orderId, { ...input, reason: 'Synthetic verified bank receipt', evidenceReference: 'test-bank-receipt' }, actorId);
}
