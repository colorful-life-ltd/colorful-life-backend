import {providerFinancialHold} from "../payments/providerFinancialGuard.js";
import { journalRefundEvidence } from "./refundEvidenceService.js";
import { randomUUID } from "node:crypto";
import { Decimal } from "@prisma/client/runtime/client";
import type { Prisma, Refund } from "../../generated/prisma-client/client.js";
import { prisma } from "../../prisma/runtime.js";
import { databaseNow } from "../payments/paymentResolutionService.js";
import { reserveRefundCapacity, finalizeRefundCapacity, releaseRefundCapacity } from "./refundCapacityService.js";
import { RefundOrderNotFoundError, RefundPaymentNotFoundError, RefundPaymentNotRefundableError } from "./refundErrors.js";

export type ExternalRefundProvider = "STRIPE" | "PAYPAL";
export class RefundIntentError extends Error {
  constructor(public readonly code: string, public readonly httpStatus=409, public readonly refundId?: number, public readonly refundStatus?: string) { super(code); }
}
export class RefundPersistenceError extends Error {
  constructor(public readonly refundId: number) { super("Refund persistence failed; reconcile the existing intent"); }
}
export class DefinitiveRefundRejection extends Error {
  constructor(public readonly safeCode: string) { super("Provider rejected the original refund request before execution"); }
}
export function validClientRequestKey(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{16,128}$/.test(value);
}
export async function lockRefundPayment(tx: Prisma.TransactionClient, orderId: number, paymentId: number) {
  await tx.$queryRaw`SELECT id FROM "Order" WHERE id=${orderId} FOR NO KEY UPDATE`;
  if (!await tx.order.findUnique({where:{id:orderId},select:{id:true}})) throw new RefundOrderNotFoundError(orderId);
  await tx.$queryRaw`SELECT id FROM "Payment" WHERE id=${paymentId} FOR UPDATE`;
  const payment=await tx.payment.findUnique({where:{id:paymentId}});
  if (!payment || payment.orderId!==orderId) throw new RefundPaymentNotFoundError(paymentId,orderId);
  return payment;
}
export async function lockRefund(tx: Prisma.TransactionClient, refundId: number) {
  const candidate=await tx.refund.findUnique({where:{id:refundId}});
  if(!candidate) throw new RefundIntentError("REFUND_NOT_FOUND",404);
  const payment=await lockRefundPayment(tx,candidate.orderId,candidate.paymentId);
  await tx.$queryRaw`SELECT id FROM "Refund" WHERE id=${refundId} FOR UPDATE`;
  const refund=await tx.refund.findUniqueOrThrow({where:{id:refundId}});
  if(refund.orderId!==candidate.orderId || refund.paymentId!==payment.id) throw new RefundIntentError("REFUND_IDENTITY_CONFLICT");
  return {refund,payment};
}
export async function assertNoUnresolvedRefund(tx: Prisma.TransactionClient, paymentId:number) {
  const existing=await tx.refund.findFirst({where:{paymentId,OR:[{status:"PROCESSING"},{reviewRequired:true}]},orderBy:{id:"asc"}});
  if(existing) throw new RefundIntentError("REFUND_UNRESOLVED",409,existing.id,existing.status);
  const payment=await tx.payment.findUniqueOrThrow({where:{id:paymentId}});
  const hold=await providerFinancialHold(tx,payment);
  if(hold==='REFUND')throw new RefundIntentError('REFUND_PROVIDER_EVIDENCE_UNRESOLVED');
}
export async function prepareExternalRefund(input:{orderId:number;paymentId:number;amount:Decimal|number;reason?:string;actor:number;provider:ExternalRefundProvider;clientRequestKey?:string;refundId?:number}) {
  const amount=new Decimal(input.amount);
  if(!amount.isFinite() || amount.lte(0) || !amount.mul(100).isInteger() || amount.mul(100).gt(Number.MAX_SAFE_INTEGER)) throw new RefundIntentError("INVALID_REFUND_AMOUNT",400);
  const reason=input.reason?.trim() || null;
  if(input.clientRequestKey!==undefined && !validClientRequestKey(input.clientRequestKey)) throw new RefundIntentError("INVALID_IDEMPOTENCY_KEY",400);
  if(!input.refundId && !input.clientRequestKey) throw new RefundIntentError("IDEMPOTENCY_KEY_REQUIRED",400);
  const matches=(r:Refund)=>r.orderId===input.orderId && r.paymentId===input.paymentId && r.provider===input.provider
    && (!r.clientRequestKey || (new Decimal(r.amount).eq(amount) && r.reason===reason))
    && (!input.clientRequestKey || r.clientRequestKey===input.clientRequestKey);
  let allocatedId:number|undefined;
  try { return await prisma.$transaction(async tx=>{
    const payment=await lockRefundPayment(tx,input.orderId,input.paymentId);
    const existing=input.refundId ? await tx.refund.findUnique({where:{id:input.refundId}})
      : await tx.refund.findUnique({where:{clientRequestKey:input.clientRequestKey!}});
    if(input.refundId && !existing) throw new RefundIntentError("REFUND_NOT_FOUND",404);
    if(existing){if(!matches(existing))throw new RefundIntentError("IDEMPOTENCY_CONFLICT",409,existing.id,existing.status);allocatedId=existing.id;return {refund:existing,payment,submit:false};}
    if(payment.status!=="SUCCEEDED")throw new RefundPaymentNotRefundableError(payment.id);
    const parent=input.provider==="STRIPE"?payment.providerReference:payment.providerCaptureReference;
    if(payment.provider!==input.provider || !parent || parent.startsWith("pending:"))throw new RefundIntentError("PROVIDER_PAYMENT_UNAVAILABLE");
    await assertNoUnresolvedRefund(tx,payment.id);
    await reserveRefundCapacity(payment.id,amount,tx);
    const key=randomUUID(); // Also fits PayPal's conservative UUID request-id guidance.
    const refund=await tx.refund.create({data:{orderId:input.orderId,paymentId:payment.id,amount,currency:payment.currency,
      provider:input.provider,status:"PROCESSING",providerReference:`pending:${key}`,refundIdempotencyKey:key,
      clientRequestKey:input.clientRequestKey!,providerPaymentReference:parent,submissionStartedAt:await databaseNow(tx),
      reason,performedByUserId:input.actor,resolutionCode:"SUBMISSION_STARTED"}});
    allocatedId=refund.id;
    return {refund,payment,submit:true};
  }); } catch(error){
    if(error && typeof error==="object" && "code" in error && error.code==="P2002" && input.clientRequestKey){
      const existing=await prisma.refund.findUnique({where:{clientRequestKey:input.clientRequestKey}});
      if(existing){if(!matches(existing))throw new RefundIntentError("IDEMPOTENCY_CONFLICT",409,existing.id,existing.status);
        const payment=await prisma.payment.findUniqueOrThrow({where:{id:existing.paymentId}});return {refund:existing,payment,submit:false};}
    }
    if(error instanceof RefundIntentError)throw error;
    if(allocatedId)throw new RefundPersistenceError(allocatedId);
    throw error;
  }
}
export type RefundObservation={provider:ExternalRefundProvider;reference?:string;parentReference:string;amount:string;currency:string;
  status:"SUCCEEDED"|"FAILED"|"PENDING"|"UNKNOWN";source?:"POST"|"GET"|"WEBHOOK";rejectionCode?:string};
export async function retainUnresolved(refundId:number,code:string,review=false,evidence?:Prisma.InputJsonValue){
  return prisma.$transaction(async tx=>{
    const {refund}=await lockRefund(tx,refundId);
    const fresh = await journalRefundEvidence(tx,refundId,evidence ?? {issue:code});
    if(!fresh)return refund;
    if(refund.status!=="PROCESSING" && !review)return refund;
    // A delayed incomplete POST must not replace an identity already established by a webhook.
    const candidate=evidence && typeof evidence==="object"&&!Array.isArray(evidence)?(evidence as Prisma.InputJsonObject).reference:undefined;
    if(refund.provider==="PAYPAL"&&typeof candidate==="string"&&!refund.providerReference.startsWith("pending:")&&refund.providerReference!==candidate)
      return tx.refund.update({where:{id:refundId},data:{resolutionCode:"PROVIDER_EVIDENCE_MISMATCH",reviewRequired:true,reviewEvidence:{issue:"PROVIDER_EVIDENCE_MISMATCH"}}});
    return tx.refund.update({where:{id:refundId},data:{resolutionCode:code,...(review?{reviewRequired:true}:{}),...(evidence?{reviewEvidence:evidence}:review?{reviewEvidence:{issue:code}}:{})}});
  });
}
export const STRIPE_FAILED_AFTER_SUCCESS_AUDIT="REFUND_FAILED_AFTER_SUCCESS";
export const stripeFailedAfterSuccessKey=(refundId:number)=>`refund-failed-after-success:${refundId}`;
const jsonObject=(value:Prisma.JsonValue|null)=>value&&typeof value==="object"&&!Array.isArray(value)?value:{};
/**
 * Stripe documents refunds that report `succeeded` and later fail. Stage 1 (signed `refund.failed` webhook)
 * only records TERMINAL_EVIDENCE_CONFLICT. Stage 2 (this, from an explicit provider GET that already passed
 * identity, amount, currency and parent validation) corrects the accounting exactly once: the unique audit
 * key and the Order -> Payment -> Refund locks make duplicates and concurrent reconciliations no-ops.
 * Review stays required, so dispatch and new refunds remain blocked until an operator resolves it, and the
 * order's status, cancellation and stock are never changed.
 */
async function applyStripeFailureAfterSuccess(tx:Prisma.TransactionClient,refund:Refund,payment:{id:number;refundedAmount:Decimal},evidence:RefundObservation){
  const stage1=jsonObject(refund.reviewEvidence);
  if(!refund.reviewRequired||refund.resolutionCode!=="TERMINAL_EVIDENCE_CONFLICT"||stage1.source!=="WEBHOOK"||stage1.status!=="FAILED"
    ||stage1.reference!==refund.providerReference) // No verified stage-1 webhook conflict: flag exactly as before, move no money.
    return tx.refund.update({where:{id:refund.id},data:{reviewRequired:true,resolutionCode:"TERMINAL_EVIDENCE_CONFLICT",reviewEvidence:{...evidence}}});
  if(new Decimal(payment.refundedAmount).lt(refund.amount))
    return tx.refund.update({where:{id:refund.id},data:{reviewRequired:true,resolutionCode:"REFUND_ADJUSTMENT_INVARIANT",reviewEvidence:{issue:"REFUND_ADJUSTMENT_INVARIANT",observed:{...evidence}}}});
  const order=await tx.order.findUniqueOrThrow({where:{id:refund.orderId},select:{status:true,dispatchedAt:true,cancelledAt:true}});
  const cancellation=await tx.$queryRaw<Array<{id:bigint}>>`SELECT id FROM "OperationalAudit" WHERE "orderId"=${refund.orderId} AND kind='PAID_ORDER_CANCELLED' LIMIT 1`;
  const restocks=await tx.inventoryMovement.findMany({where:{type:"ORDER_CANCELLATION_RETURN",note:{startsWith:`Fully refunded order ${refund.orderId}:`}},select:{id:true,listingId:true,quantityChange:true}});
  const closed=cancellation.length>0||restocks.length>0||order.status==="CANCELLED"||order.status==="RETURNED";
  const code=closed?"REFUND_FAILED_AFTER_CANCELLATION":"REFUND_FAILED_AFTER_SUCCESS";
  const revision=refund.reviewRevision+1; // refund_review_revision bumps it when the review evidence changes below
  const inserted=await tx.$queryRaw<Array<{id:bigint}>>`INSERT INTO "OperationalAudit" (kind,"orderId","refundId",revision,"requestKey",details)
    VALUES (${STRIPE_FAILED_AFTER_SUCCESS_AUDIT},${refund.orderId},${refund.id},${revision},${stripeFailedAfterSuccessKey(refund.id)},${JSON.stringify({
      amount:refund.amount.toFixed(2),currency:refund.currency,priorOutcome:refund.providerOutcome,stage1,observed:evidence,
      order:{status:order.status,dispatched:!!order.dispatchedAt,cancelled:!!order.cancelledAt},paidOrderCancelled:cancellation.length>0,
      cancellationRestocks:restocks.map(m=>({id:m.id,listingId:m.listingId,quantityChange:m.quantityChange}))})}::jsonb)
    ON CONFLICT ("requestKey") DO NOTHING RETURNING id`;
  if(!inserted.length)return refund; // Already adjusted.
  const adjusted=await tx.payment.updateMany({where:{id:payment.id,refundedAmount:{gte:refund.amount}},data:{refundedAmount:{decrement:refund.amount}}});
  if(adjusted.count!==1)throw new Error("Refund adjustment invariant changed under lock");
  // providerOutcome keeps the first terminal observation (immutable); the confirmed failure lives in the audit.
  const updated=await tx.refund.update({where:{id:refund.id},data:{status:"FAILED",reviewRequired:true,resolutionCode:code,
    reviewEvidence:{issue:code,status:"FAILED",reference:refund.providerReference,source:"GET"}}});
  if(updated.reviewRevision!==revision)throw new Error("Refund review revision changed under lock");
  return updated;
}
/** All synchronous, webhook and GET observations use the same Order -> Payment -> Refund lock boundary. */
export async function applyRefundObservationInTransaction(tx:Prisma.TransactionClient,refundId:number,observation:RefundObservation){
  const {refund,payment}=await lockRefund(tx,refundId);
  const expectedParent=refund.providerPaymentReference ?? (refund.provider==="STRIPE"?payment.providerReference:payment.providerCaptureReference);
  let moneyMatches=false;try{moneyMatches=new Decimal(observation.amount).isFinite() && new Decimal(observation.amount).eq(refund.amount);}catch{}
  const evidence={...observation};
  const fresh=await journalRefundEvidence(tx,refundId,evidence);
  if(!fresh && refund.status!=="PROCESSING")return refund;
  const valid=observation.provider===refund.provider && payment.provider===refund.provider && expectedParent===observation.parentReference
    && moneyMatches && typeof observation.currency==="string" && observation.currency.toUpperCase()===refund.currency.toUpperCase()
    && (observation.rejectionCode ? !observation.reference && refund.providerReference.startsWith("pending:")
      : typeof observation.reference==="string" && !!observation.reference && observation.reference.length<=256 && !observation.reference.startsWith("pending:")
        && (refund.providerReference.startsWith("pending:") || refund.providerReference===observation.reference));
  if(!valid)return tx.refund.update({where:{id:refund.id},data:{reviewRequired:true,resolutionCode:"PROVIDER_EVIDENCE_MISMATCH",reviewEvidence:evidence}});
  if(refund.status!=="PROCESSING"){
    if(observation.status!=="PENDING" && observation.status!=="UNKNOWN" && observation.status!==refund.status){
      // Stage 2 of a Stripe refund failing after success: only an explicit provider read moves money.
      if(refund.provider==="STRIPE" && refund.status==="SUCCEEDED" && observation.status==="FAILED" && observation.source==="GET")
        return applyStripeFailureAfterSuccess(tx,refund,payment,evidence);
      return tx.refund.update({where:{id:refund.id},data:{reviewRequired:true,resolutionCode:"TERMINAL_EVIDENCE_CONFLICT",reviewEvidence:evidence}});
    }
    return refund;
  }
  const reference=observation.reference ?? refund.providerReference;
  if(observation.status==="PENDING" || observation.status==="UNKNOWN")return tx.refund.update({where:{id:refund.id},data:{providerReference:reference,resolutionCode:observation.status==="PENDING"?"PROVIDER_PENDING":"PROVIDER_OUTCOME_UNKNOWN"}});
  if(observation.status==="SUCCEEDED")await finalizeRefundCapacity(payment.id,refund.amount,tx);
  else await releaseRefundCapacity(payment.id,refund.amount,tx);
  const priorReview=refund.reviewEvidence;
  const unresolvedConflict=!!priorReview&&typeof priorReview==="object"&&!Array.isArray(priorReview)
    && ("issue" in priorReview||"status" in priorReview);
  return tx.refund.update({where:{id:refund.id},data:{providerReference:reference,status:observation.status,providerOutcome:evidence,
    reviewRequired:refund.reviewRequired&&unresolvedConflict,
    resolutionCode:refund.reviewRequired&&unresolvedConflict?"PROVIDER_EVIDENCE_REVIEW_REQUIRED":observation.status==="SUCCEEDED"?"REFUND_SUCCEEDED":"REFUND_FAILED"}});
}
export async function applyRefundObservation(refundId:number,observation:RefundObservation){
  return prisma.$transaction(tx=>applyRefundObservationInTransaction(tx,refundId,observation));
}
export async function refundWithContext<T>(refundId:number,work:()=>Promise<T>):Promise<T>{
  try{return await work();}catch(error){if(error instanceof RefundIntentError)throw error;throw new RefundPersistenceError(refundId);}
}
export function refundProjection(refund:Refund){return {refundId:refund.id,status:refund.status,amount:refund.amount,currency:refund.currency,provider:refund.provider,
  ...(refund.status==="PROCESSING" || refund.reviewRequired?{resolutionCode:refund.resolutionCode,reviewRequired:refund.reviewRequired}:{})};}
