import { Decimal } from "@prisma/client/runtime/client";
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
    // Provider-dashboard refunds have no application intent. Correlate only by
    // a frozen provider parent; never infer ownership from arbitrary metadata.
    if(!candidate && !event.localRefundId && !event.localOrderId && event.parentReference && event.reference){
      const payment=await tx.payment.findFirst({where:{provider:event.provider,...(event.provider==='STRIPE'?{providerReference:event.parentReference}:{providerCaptureReference:event.parentReference})}});
      if(payment){
        await tx.$queryRaw`SELECT id FROM "Order" WHERE id=${payment.orderId} FOR NO KEY UPDATE`;
        await tx.$queryRaw`SELECT id FROM "Payment" WHERE id=${payment.id} FOR UPDATE`;
        candidate=await tx.refund.findUnique({where:{provider_providerReference:{provider:event.provider,providerReference:event.reference}}});
        if(!candidate && event.amount && event.currency && ['SUCCEEDED','PENDING','FAILED'].includes(event.status)){
          const current=await tx.payment.findUniqueOrThrow({where:{id:payment.id}});
          let amount:Decimal|undefined;try{amount=new Decimal(event.amount);}catch{}
          if(current.status==='SUCCEEDED'&&current.paidAt&&amount?.isFinite()&&amount.gt(0)&&amount.mul(100).isInteger()&&event.currency.toUpperCase()===current.currency.toUpperCase()
            && current.refundedAmount.add(current.reservedRefundAmount).add(amount).lte(current.amount)){
            await tx.payment.update({where:{id:payment.id},data:{reservedRefundAmount:{increment:amount}}});
            candidate=await tx.refund.create({data:{orderId:payment.orderId,paymentId:payment.id,provider:event.provider,
              providerReference:event.reference,providerPaymentReference:event.parentReference,amount,currency:current.currency,status:'PROCESSING',
              reason:'Verified external provider refund',performedByUserId:null}});
          }
        }
      }
    }
    const locked=candidate?await lockRefund(tx,candidate.id):null;
    if(locked)candidate=locked.refund;
    await tx.$queryRaw`SELECT id FROM "PaymentWebhookEvent" WHERE id=${receiptId} FOR UPDATE`;
    const receipt=await tx.paymentWebhookEvent.findUniqueOrThrow({where:{id:receiptId}});
    const current=RefundWebhookEvidenceSchema.safeParse(receipt.evidence);
    if(!current.success||JSON.stringify(current.data)!==JSON.stringify(event))throw new RefundWebhookConflictError();
    if(receipt.processedAt)return {handled:!receipt.processingError,processed:true};
    const unresolved=async(code:string)=>{await tx.paymentWebhookEvent.update({where:{id:receiptId},data:{processingError:code}});return {handled:false,processed:false};};
    if(!candidate)return unresolved("REFUND_UNCORRELATED");
    if(candidate.provider!==event.provider || event.localRefundId!==undefined&&localId!==candidate.id
      || event.localOrderId!==undefined&&event.localOrderId!==String(candidate.orderId))return unresolved("REFUND_CORRELATION_MISMATCH");
    if(!event.reference||!event.parentReference||!event.amount||!event.currency||event.status==="UNKNOWN"){
      const expectedParent=candidate.providerPaymentReference??(candidate.provider==='STRIPE'?locked?.payment.providerReference:locked?.payment.providerCaptureReference);
      let moneyMatches=!event.amount;try{if(event.amount)moneyMatches=new Decimal(event.amount).eq(candidate.amount);}catch{}
      if(candidate.status!=='PROCESSING'&&candidate.providerOutcome&&!candidate.reviewRequired
        && event.reference===candidate.providerReference&&(!event.parentReference||event.parentReference===expectedParent)
        && moneyMatches&&(!event.currency||event.currency.toUpperCase()===candidate.currency.toUpperCase())
        && (event.status==='UNKNOWN'||event.status==='PENDING'||event.status===candidate.status)){
        await tx.$executeRaw`INSERT INTO "OperationalAudit" (kind,"orderId","refundId","requestKey",details)
          VALUES ('REFUND_RECEIPT_CORROBORATED',${candidate.orderId},${candidate.id},${`refund-receipt-corroborated:${receiptId}`},${JSON.stringify({receiptId,providerOutcome:candidate.providerOutcome})}::jsonb) ON CONFLICT ("requestKey") DO NOTHING`;
        await tx.paymentWebhookEvent.update({where:{id:receiptId},data:{processedAt:new Date(),processingError:null}});
        return {handled:true,processed:true};
      }
      return unresolved('REFUND_EVIDENCE_INCOMPLETE');
    }
    const result=await applyRefundObservationInTransaction(tx,candidate.id,{provider:event.provider,reference:event.reference,
      parentReference:event.parentReference,amount:event.amount,currency:event.currency,status:event.status,source:"WEBHOOK"});
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
