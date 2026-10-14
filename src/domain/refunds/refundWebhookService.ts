import { z } from "zod";
import { prisma } from "../../prisma/runtime.js";
import { applyRefundObservationInTransaction, lockRefund } from "./refundLifecycleService.js";
const text=z.string().min(1).max(256);
export const RefundWebhookEvidenceSchema=z.object({version:z.literal(2),kind:z.literal("refund"),provider:z.enum(["STRIPE","PAYPAL"]),
  id:text,eventType:text,reference:text.optional(),parentReference:text.optional(),localRefundId:z.string().max(64).optional(),localOrderId:z.string().max(64).optional(),
  amount:z.string().max(32).optional(),currency:z.string().max(3).optional(),status:z.enum(["SUCCEEDED","FAILED","PENDING","UNKNOWN"])}).strict();
export type RefundWebhookEvidence=z.infer<typeof RefundWebhookEvidenceSchema>;
export class RefundWebhookConflictError extends Error {constructor(){super("Conflicting refund webhook evidence");}}
/** Verified callers only. The receipt transaction never waits for an Order or Payment lock. */
export async function persistRefundWebhookEvidence(input:RefundWebhookEvidence){
  const event=RefundWebhookEvidenceSchema.parse(input);
  return prisma.$transaction(async tx=>{
    const inserted=await tx.$queryRaw<Array<{id:number}>>`INSERT INTO "PaymentWebhookEvent" (provider,"providerEventId","eventType",evidence)
      VALUES (${event.provider}::"PaymentProvider",${event.id},${event.eventType},${JSON.stringify(event)}::jsonb)
      ON CONFLICT (provider,"providerEventId") DO NOTHING RETURNING id`;
    await tx.$queryRaw`SELECT id FROM "PaymentWebhookEvent" WHERE provider=${event.provider}::"PaymentProvider" AND "providerEventId"=${event.id} FOR UPDATE`;
    const receipt=await tx.paymentWebhookEvent.findUniqueOrThrow({where:{provider_providerEventId:{provider:event.provider,providerEventId:event.id}}});
    if(receipt.eventType!==event.eventType)throw new RefundWebhookConflictError();
    if(receipt.evidence!==null){const stored=RefundWebhookEvidenceSchema.safeParse(receipt.evidence);
      if(!stored.success || JSON.stringify(stored.data)!==JSON.stringify(event))throw new RefundWebhookConflictError();
    }else await tx.paymentWebhookEvent.update({where:{id:receipt.id},data:{evidence:event,processedAt:null}});
    return {receiptId:receipt.id,duplicate:inserted.length===0};
  });
}
export async function processRefundWebhookReceipt(receiptId:number){
  const snapshot=await prisma.paymentWebhookEvent.findUnique({where:{id:receiptId}});
  const decoded=RefundWebhookEvidenceSchema.safeParse(snapshot?.evidence);
  if(!snapshot||!decoded.success||decoded.data.provider!==snapshot.provider||decoded.data.id!==snapshot.providerEventId||decoded.data.eventType!==snapshot.eventType)return {handled:false,processed:false};
  const event=decoded.data;
  return prisma.$transaction(async tx=>{
    let candidate=event.reference?await tx.refund.findUnique({where:{provider_providerReference:{provider:event.provider,providerReference:event.reference}}}):null;
    const localId=event.localRefundId&&/^[1-9][0-9]*$/.test(event.localRefundId)?Number(event.localRefundId):undefined;
    if(!candidate&&localId&&Number.isSafeInteger(localId))candidate=await tx.refund.findUnique({where:{id:localId}});
    if(candidate)await lockRefund(tx,candidate.id);
    await tx.$queryRaw`SELECT id FROM "PaymentWebhookEvent" WHERE id=${receiptId} FOR UPDATE`;
    const receipt=await tx.paymentWebhookEvent.findUniqueOrThrow({where:{id:receiptId}});
    const current=RefundWebhookEvidenceSchema.safeParse(receipt.evidence);
    if(!current.success||JSON.stringify(current.data)!==JSON.stringify(event))throw new RefundWebhookConflictError();
    if(receipt.processedAt)return {handled:!receipt.processingError,processed:true};
    const unresolved=async(code:string)=>{await tx.paymentWebhookEvent.update({where:{id:receiptId},data:{processingError:code}});return {handled:false,processed:false};};
    if(!candidate)return unresolved("REFUND_UNCORRELATED");
    if(candidate.provider!==event.provider || event.localRefundId!==undefined&&localId!==candidate.id
      || event.localOrderId!==undefined&&event.localOrderId!==String(candidate.orderId))return unresolved("REFUND_CORRELATION_MISMATCH");
    if(!event.reference||!event.parentReference||!event.amount||!event.currency||event.status==="UNKNOWN")return unresolved("REFUND_EVIDENCE_INCOMPLETE");
    const result=await applyRefundObservationInTransaction(tx,candidate.id,{provider:event.provider,reference:event.reference,
      parentReference:event.parentReference,amount:event.amount,currency:event.currency,status:event.status});
    const error=result.reviewRequired?result.resolutionCode:null;
    await tx.paymentWebhookEvent.update({where:{id:receiptId},data:{processedAt:new Date(),processingError:error}});
    return {handled:!error,processed:true};
  });
}
export async function reconcileRefundWebhook(input:RefundWebhookEvidence){
  const saved=await persistRefundWebhookEvidence(input); // Commit before processing and before HTTP acknowledgement.
  const outcome=await processRefundWebhookReceipt(saved.receiptId);
  return {duplicate:saved.duplicate,handled:outcome.handled};
}
