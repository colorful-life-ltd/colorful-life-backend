import {refundConflictEvidence} from "./refundEvidenceService.js";
import { Decimal } from "@prisma/client/runtime/client";
import { config } from "../../config/index.js";
import { prisma } from "../../prisma/runtime.js";
import { applyRefundObservationInTransaction, type RefundObservation, lockRefund, RefundIntentError, refundWithContext, retainUnresolved } from "./refundLifecycleService.js";
import { stripeRefundClient, stripeRefundObservation, stripeRefundMetadataMatches } from "./stripeRefundService.js";
import { paypalRefundClient, paypalRefundObservation, paypalRefundParent } from "./paypalRefundService.js";

async function boundedRead<T>(work:()=>Promise<T>):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([work(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("Provider read timeout")),5000);})]);}
  finally{if(timer)clearTimeout(timer);}
}
/** Exactly one explicit GET per invocation, eight attempts per refund; no timer, scheduler or POST replay. */
export async function reconcileExternalRefund(orderId:number,refundId:number){
  if(!config.REFUND_RECONCILIATION_ENABLED)throw new RefundIntentError("REFUND_RECONCILIATION_DISABLED",503);
  const claim=await prisma.$transaction(async tx=>{
    const {refund,payment}=await lockRefund(tx,refundId);
    if(refund.orderId!==orderId)throw new RefundIntentError("REFUND_NOT_FOUND",404);
    if(refund.provider==="MANUAL"||(refund.status!=="PROCESSING"&&!refund.reviewRequired))return {refund,reference:null,payment};
    const candidate=refund.reviewEvidence&&typeof refund.reviewEvidence==="object"&&!Array.isArray(refund.reviewEvidence)?refund.reviewEvidence.reference:undefined;
    const reference=!refund.providerReference.startsWith("pending:")?refund.providerReference:typeof candidate==="string"?candidate:undefined;
    if(!reference||!reference.length||reference.length>256||refund.reconciliationAttempts>=8){
      const updated=await tx.refund.update({where:{id:refundId},data:{reviewRequired:true,resolutionCode:refund.reconciliationAttempts>=8?"RECONCILIATION_EXHAUSTED":"MANUAL_REVIEW_REQUIRED"}});
      return {refund:updated,reference:null,payment};
    }
    const updated=await tx.refund.update({where:{id:refundId},data:{reconciliationAttempts:{increment:1}}});
    return {refund:updated,reference,payment};
  });
  if(!claim.reference)return claim.refund;
  return refundWithContext(refundId,async()=>{
    try {
      if(claim.refund.provider==='STRIPE'){
        const client=stripeRefundClient();if(!client.retrieveRefund)throw new Error();
        // Keep the completion handler attached after HTTP timeout. A late read
        // must still pass validation and retain contradictory terminal evidence.
        return await boundedRead(async()=>{
          const response=await client.retrieveRefund!(claim.reference!);
          if(!stripeRefundMetadataMatches(response,refundId,orderId)||response.id!==claim.reference||!Number.isSafeInteger(response.amount)||response.amount<=0)
            return retainUnresolved(refundId,'PROVIDER_EVIDENCE_MISMATCH',true,refundConflictEvidence('PROVIDER_EVIDENCE_MISMATCH','GET',{observedReference:response.id,observedAmount:response.amount,observedCurrency:response.currency}));
          return corroborate(refundId,{...stripeRefundObservation(response),source:"GET"},claim.refund.reviewRevision);
        });
      }
      const client=paypalRefundClient();if(!client.retrieveRefund)throw new Error();
      return await boundedRead(async()=>{
        const response=await client.retrieveRefund!(claim.reference!);
        const parent=paypalRefundParent(response);
        if(response.id!==claim.reference||!parent||response.custom_id&&response.custom_id!==`cl-refund-${refundId}`)
          return retainUnresolved(refundId,'PROVIDER_EVIDENCE_MISMATCH',true,refundConflictEvidence('PROVIDER_EVIDENCE_MISMATCH','GET',{observedReference:response.id,observedAmount:response.amount?.value,observedCurrency:response.amount?.currency_code,observedParent:parent}));
        return corroborate(refundId,{...paypalRefundObservation(response,parent),source:"GET"},claim.refund.reviewRevision);
      });
    }catch{return retainUnresolved(refundId,'RECONCILIATION_UNAVAILABLE');}
  });
}

async function corroborate(refundId:number, observation:RefundObservation, claimedRevision:number){
  return prisma.$transaction(async tx=>{
    const {refund}=await lockRefund(tx,refundId);
    const updated=await applyRefundObservationInTransaction(tx,refundId,observation);
    if(refund.reviewRevision===claimedRevision && refund.status!=='PROCESSING' && observation.status===refund.status && observation.reference===refund.providerReference
      && observation.parentReference===refund.providerPaymentReference && observation.currency.toUpperCase()===refund.currency.toUpperCase()
      && new Decimal(observation.amount).eq(refund.amount)) {
      await tx.$executeRaw`INSERT INTO "OperationalAudit" (kind,"orderId","refundId",revision,details)
        VALUES ('REFUND_PROVIDER_CORROBORATION',${refund.orderId},${refundId},${refund.reviewRevision},${JSON.stringify(observation)}::jsonb)`;
    }
    return updated;
  });
}
