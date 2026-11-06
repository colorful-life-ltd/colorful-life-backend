import {logOperationalError} from "../utils/operationalLog.js";
import { RefundIntentError, RefundPersistenceError, refundProjection, retireUnsubmittedRefundRequest, validClientRequestKey } from "../domain/refunds/refundLifecycleService.js";
import { reconcileExternalRefund } from "../domain/refunds/refundReconciliationService.js";
import { RefundCapacityExceededError } from "../domain/refunds/refundCapacityService.js";
import { Request, Response } from "express";
import { createRefund, getOrderRefunds } from "../domain/refunds/refundService.js";
import { createOrReuseStripeRefund, StripeRefundProviderError, StripeRefundValidationError } from "../domain/refunds/stripeRefundService.js";
import { prisma } from "../prisma/runtime.js";
import { PaymentProvider } from "../generated/prisma-client/enums.js";
import { CreateRefundSchema } from "../domain/refunds/refundValidator.js";
import { sendApiError } from "../utils/apiErrorResponse.js";
import {
  RefundAmountExceededError,
  RefundInvalidAmountError,
  RefundInvalidProviderReferenceError,
  RefundInvalidReasonError,
  RefundOrderNotFoundError,
  RefundPaymentNotFoundError,
  RefundPaymentNotRefundableError,
  RefundProviderReferenceConflictError,
} from "../domain/refunds/refundErrors.js";

export const createRefundHandler = async (req: Request, res: Response) => {
  const user = req.user as { id: number; role: string };
  if (user.role !== "ADMIN") {
    return sendApiError(res, 403, "FORBIDDEN", "Forbidden: ADMIN only");
  }

  const orderId = Number(req.params.orderId);
  if (!Number.isInteger(orderId) || orderId < 1) {
    return res.status(400).json({ error: "Invalid order id" });
  }

  const parseResult = CreateRefundSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ error: parseResult.error.format() });
  }

  const { paymentId, amount, providerReference, reason, refundId } = parseResult.data;

  try {
    const payment = await prisma.payment.findUnique({ where: { id: paymentId }, select: { orderId: true, provider: true } });
    if (!payment || payment.orderId !== orderId) return res.status(404).json({ error: "Payment not found for order" });
    if (payment.provider === PaymentProvider.STRIPE) {
      if (providerReference !== undefined) return res.status(400).json({ error: "providerReference is only valid for manual refunds" });
      const refund = await createOrReuseStripeRefund(orderId, paymentId, amount, reason, user.id, undefined, refundId, req.get("Idempotency-Key"));
      return res.status(refund.status === "PROCESSING" ? 202 : refundId ? 200 : 201).json(refundProjection(refund));
    }
    // Residual payments from a retired provider are never refundable through this API.
    if (payment.provider !== PaymentProvider.MANUAL) return res.status(409).json({ error: { code: "PAYMENT_PROVIDER_UNSUPPORTED", message: "This payment provider is not supported" } });
    if (refundId !== undefined) return res.status(400).json({ error: "refundId is only valid for provider refunds" });
    if (providerReference === undefined) return res.status(400).json({ error: "Refund provider reference cannot be empty" });
    const result = await createRefund(
      orderId,
      paymentId,
      amount,
      providerReference,
      reason,
      user.id,
    );
    return res.status(result.created ? 201 : 200).json(result.refund);
  } catch (err: unknown) {
    if(err instanceof RefundIntentError) {
      if (err.code === "REFUND_UNRESOLVED" && err.refundId) {
        const key = req.get("Idempotency-Key");
        const provedUnsubmitted = validClientRequestKey(key) && err.clientRequestKey === key;
        return res.status(err.httpStatus).json({ error: err.code, blockingRefundId: err.refundId, blockingRefundStatus: err.refundStatus ?? "UNKNOWN",
          ...(provedUnsubmitted ? { refundSubmissionDisposition: "NOT_SUBMITTED", refundRequestKey: key } : {}) });
      }
      return res.status(err.httpStatus).json({error:err.code,...(err.refundId?{refundId:err.refundId,status:err.refundStatus??"UNKNOWN",resolutionCode:err.code}:{})});
    }
    if(err instanceof RefundPersistenceError)return res.status(503).json({error:"REFUND_PERSISTENCE_UNAVAILABLE",refundId:err.refundId,status:"UNKNOWN",resolutionCode:"RECONCILIATION_REQUIRED"});
    if(err instanceof RefundCapacityExceededError) {
      const key = req.get("Idempotency-Key");
      const provedUnsubmitted = validClientRequestKey(key) && err.clientRequestKey === key;
      return res.status(409).json({ error: "REFUND_CAPACITY_EXCEEDED", ...(err.availableRefundAmount === undefined ? {} : { availableRefundAmount: err.availableRefundAmount }),
        ...(provedUnsubmitted ? { refundSubmissionDisposition: "NOT_SUBMITTED", refundRequestKey: key } : {}) });
    }
    if (
      err instanceof RefundInvalidAmountError ||
      err instanceof RefundInvalidProviderReferenceError ||
      err instanceof RefundInvalidReasonError
    ) {
      return res.status(400).json({ error: err.message });
    }
    if (
      err instanceof RefundOrderNotFoundError ||
      err instanceof RefundPaymentNotFoundError
    ) {
      return res.status(404).json({ error: err.message });
    }
    if (
      err instanceof RefundPaymentNotRefundableError ||
      err instanceof RefundAmountExceededError ||
      err instanceof RefundProviderReferenceConflictError
    ) {
      return res.status(409).json({ error: err.message });
    }
    if (err instanceof StripeRefundValidationError) return res.status(409).json({ error: "Stripe refund request is not valid" });
    if (err instanceof StripeRefundProviderError) return res.status(503).json({ error: "Payment service unavailable" });
    logOperationalError("Create refund failed; inspect existing intent before retry", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};

export const refundRequestStatusHandler = async (req: Request, res: Response) => {
  if ((req.user as { role: string }).role !== "ADMIN") return sendApiError(res, 403, "FORBIDDEN", "Forbidden: ADMIN only");
  res.setHeader("Cache-Control", "no-store");
  const orderId = Number(req.params.orderId);
  const paymentId = Number(req.params.paymentId);
  const key = req.get("Idempotency-Key");
  if (!Number.isSafeInteger(orderId) || orderId < 1 || !Number.isSafeInteger(paymentId) || paymentId < 1 || !validClientRequestKey(key)) return res.status(400).json({ error: "Invalid refund request reference" });
  try {
    // This is a point-in-time read only. Absence is not sufficient to retire a
    // timed-out request key; the explicit retirement endpoint provides that guarantee.
    const state = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id=${orderId} FOR NO KEY UPDATE`;
      const order = await tx.order.findUnique({ where: { id: orderId }, select: { id: true } });
      if (!order) return { state: "NOT_FOUND" as const };
      await tx.$queryRaw`SELECT id FROM "Payment" WHERE id=${paymentId} FOR UPDATE`;
      const payment = await tx.payment.findUnique({ where: { id: paymentId }, select: { id: true, orderId: true } });
      if (!payment || payment.orderId !== orderId) return { state: "NOT_FOUND" as const };
      const refund = await tx.refund.findUnique({ where: { clientRequestKey: key } });
      if (!refund) {
        const retired = await tx.retiredRefundRequestKey.findUnique({ where: { clientRequestKey: key } });
        if (retired) return retired.orderId === orderId && retired.paymentId === paymentId
          ? { state: "RETIRED" as const } : { state: "CONFLICT" as const };
        return { state: "NOT_SUBMITTED" as const };
      }
      if (refund.orderId !== orderId || refund.paymentId !== paymentId) return { state: "CONFLICT" as const };
      return { state: "RECORDED" as const, refund };
    });
    if (state.state === "NOT_FOUND") return res.status(404).json({ error: "Refund request target not found" });
    if (state.state === "CONFLICT") return res.status(409).json({ state: "CONFLICT" });
    if (state.state === "NOT_SUBMITTED") return res.json({ state: "NOT_SUBMITTED", requestKey: key });
    if (state.state === "RETIRED") return res.json({ state: "RETIRED", requestKey: key });
    return res.json({ state: "RECORDED", requestKey: key, refund: refundProjection(state.refund) });
  } catch {
    return res.status(503).json({ error: "Refund request status unavailable" });
  }
};

export const retireRefundRequestKeyHandler = async (req: Request, res: Response) => {
  if ((req.user as { role: string }).role !== "ADMIN") return sendApiError(res, 403, "FORBIDDEN", "Forbidden: ADMIN only");
  res.setHeader("Cache-Control", "no-store");
  const orderId = Number(req.params.orderId);
  const paymentId = Number(req.params.paymentId);
  const key = req.get("Idempotency-Key");
  if (!Number.isSafeInteger(orderId) || orderId < 1 || !Number.isSafeInteger(paymentId) || paymentId < 1 || !validClientRequestKey(key)) return res.status(400).json({ error: "Invalid refund request reference" });
  try {
    const state = await retireUnsubmittedRefundRequest(orderId, paymentId, key);
    if (state === "CONFLICT") return res.status(409).json({ state, requestKey: key });
    return res.json({ state, requestKey: key });
  } catch (error) {
    if (error instanceof RefundOrderNotFoundError || error instanceof RefundPaymentNotFoundError) return res.status(404).json({ error: "Refund request target not found" });
    if (error instanceof RefundIntentError) return res.status(error.httpStatus).json({ error: error.code });
    return res.status(503).json({ error: "Refund request could not be safely retired" });
  }
};

export const listRefundsHandler = async (req: Request, res: Response) => {
  const userRole = (req.user as { role: string }).role;
  if (userRole !== "ADMIN") {
    return sendApiError(res, 403, "FORBIDDEN", "Forbidden: ADMIN only");
  }

  const orderId = Number(req.params.orderId);
  if (!Number.isInteger(orderId) || orderId < 1) {
    return res.status(400).json({ error: "Invalid order id" });
  }

  try {
    const refunds = await getOrderRefunds(orderId);
    return res.status(200).json(refunds);
  } catch (err: unknown) {
    if (err instanceof RefundOrderNotFoundError) {
      return res.status(404).json({ error: err.message });
    }
    logOperationalError("List refunds failed", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};

export const reconcileRefundHandler=async(req:Request,res:Response)=>{
  if((req.user as {role:string}).role!=="ADMIN")return sendApiError(res,403,"FORBIDDEN","Forbidden: ADMIN only");
  const orderId=Number(req.params.orderId),refundId=Number(req.params.refundId);
  if(!Number.isSafeInteger(orderId)||orderId<1||!Number.isSafeInteger(refundId)||refundId<1)return res.status(400).json({error:"INVALID_REFUND_ID"});
  if(req.body&&Object.keys(req.body).length)return res.status(400).json({error:"Reconciliation does not accept provider parameters"});
  try{const refund=await reconcileExternalRefund(orderId,refundId);return res.status(refund.status==="PROCESSING"?202:200).json(refundProjection(refund));}
  catch(error){
    if(error instanceof RefundIntentError)return res.status(error.httpStatus).json({error:error.code,refundId:error.refundId??refundId,status:error.refundStatus??"UNKNOWN"});
    return res.status(503).json({error:"REFUND_RECONCILIATION_UNAVAILABLE",refundId,status:"UNKNOWN"});
  }
};
