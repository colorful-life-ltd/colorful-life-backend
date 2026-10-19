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
    if(observation.status!=="PENDING" && observation.status!=="UNKNOWN" && observation.status!==refund.status)
      return tx.refund.update({where:{id:refund.id},data:{reviewRequired:true,resolutionCode:"TERMINAL_EVIDENCE_CONFLICT",reviewEvidence:evidence}});
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
