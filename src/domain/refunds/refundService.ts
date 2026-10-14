import { assertNoUnresolvedRefund, lockRefundPayment } from "./refundLifecycleService.js";
import { Decimal } from "@prisma/client/runtime/client";
import {
  PaymentStatus,
  RefundProvider,
  RefundStatus,
} from "../../generated/prisma-client/enums.js";
import { prisma } from "../../prisma/runtime.js";
import {
  RefundAmountExceededError,
  RefundInvalidAmountError,
  RefundInvalidProviderReferenceError,
  RefundInvalidReasonError,
  RefundOrderNotFoundError,
  RefundPaymentNotFoundError,
  RefundPaymentNotRefundableError,
  RefundProviderReferenceConflictError,
} from "./refundErrors.js";

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2002"
  );
}

function parseAmount(value: Decimal | number): Decimal {
  const amount = value instanceof Decimal ? value : new Decimal(value);
  if (amount.lte(0) || !amount.mul(100).isInteger()) {
    throw new RefundInvalidAmountError();
  }
  return amount;
}

export async function createRefund(
  orderId: number,
  paymentId: number,
  inputAmount: Decimal | number,
  providerReference: string,
  reason: string | undefined,
  performedByUserId: number,
) {
  const amount = parseAmount(inputAmount);
  const normalizedReference = providerReference.trim();
  if (!normalizedReference) {
    throw new RefundInvalidProviderReferenceError();
  }

  let normalizedReason: string | undefined;
  if (reason !== undefined) {
    normalizedReason = reason.trim();
    if (!normalizedReason) {
      throw new RefundInvalidReasonError();
    }
  }

  try {
    return await prisma.$transaction(async (tx) => {
      await lockRefundPayment(tx, orderId, paymentId);
      const order = await tx.order.findUnique({
        where: { id: orderId },
        select: { id: true },
      });
      if (!order) {
        throw new RefundOrderNotFoundError(orderId);
      }

      const payment = await tx.payment.findFirst({
        where: { id: paymentId, orderId },
      });
      if (!payment) {
        throw new RefundPaymentNotFoundError(paymentId, orderId);
      }
      if (payment.status !== PaymentStatus.SUCCEEDED) {
        throw new RefundPaymentNotRefundableError(paymentId);
      }

      const existing = await tx.refund.findUnique({
        where: {
          provider_providerReference: {
            provider: RefundProvider.MANUAL,
            providerReference: normalizedReference,
          },
        },
      });
      if (existing) {
        if (
          existing.paymentId !== paymentId ||
          !new Decimal(existing.amount.toString()).eq(amount)
        ) {
          throw new RefundProviderReferenceConflictError(normalizedReference);
        }
        return { refund: existing, created: false };
      }

      await assertNoUnresolvedRefund(tx, paymentId);
      const claim = await tx.payment.updateMany({
        where: {
          id: paymentId,
          orderId,
          status: PaymentStatus.SUCCEEDED,
          refundedAmount: {
            lte: payment.amount.minus(amount).minus(payment.reservedRefundAmount),
          },
        },
        data: {
          refundedAmount: {
            increment: amount,
          },
        },
      });

      if (claim.count === 0) {
        throw new RefundAmountExceededError(paymentId);
      }

      const refund = await tx.refund.create({
        data: {
          orderId,
          paymentId,
          amount,
          currency: payment.currency,
          status: RefundStatus.SUCCEEDED,
          provider: RefundProvider.MANUAL,
          providerReference: normalizedReference,
          reason: normalizedReason,
          performedByUserId,
        },
      });

      return { refund, created: true };
    });
  } catch (error: unknown) {
    if (!isUniqueViolation(error)) {
      throw error;
    }

    const existing = await prisma.refund.findUnique({
      where: {
        provider_providerReference: {
          provider: RefundProvider.MANUAL,
          providerReference: normalizedReference,
        },
      },
    });
    if (
      existing &&
      existing.orderId === orderId &&
      existing.paymentId === paymentId &&
      new Decimal(existing.amount.toString()).eq(amount)
    ) {
      return { refund: existing, created: false };
    }
    if (existing) {
      throw new RefundProviderReferenceConflictError(normalizedReference);
    }
    throw error;
  }
}

export async function getOrderRefunds(orderId: number) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true },
  });
  if (!order) {
    throw new RefundOrderNotFoundError(orderId);
  }

  return prisma.refund.findMany({
    omit: { providerOutcome: true, reviewEvidence: true, providerPaymentReference: true, clientRequestKey: true, submissionStartedAt: true },
    where: { orderId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}
