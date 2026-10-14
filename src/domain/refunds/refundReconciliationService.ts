import { config } from "../../config/index.js";
import { prisma } from "../../prisma/runtime.js";
import { applyRefundObservation, lockRefund, RefundIntentError, refundWithContext, retainUnresolved } from "./refundLifecycleService.js";
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
    if(refund.provider==="MANUAL"||refund.status!=="PROCESSING")return {refund,reference:null,payment};
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
    if(claim.refund.provider==="STRIPE"){
      let response;
      try{const client=stripeRefundClient();if(!client.retrieveRefund)throw new Error();response=await boundedRead(()=>client.retrieveRefund!(claim.reference!));}
      catch{return retainUnresolved(refundId,"RECONCILIATION_UNAVAILABLE");}
      if(!stripeRefundMetadataMatches(response,refundId,orderId)||response.id!==claim.reference||!Number.isSafeInteger(response.amount)||response.amount<=0)return retainUnresolved(refundId,"PROVIDER_EVIDENCE_MISMATCH",true);
      return applyRefundObservation(refundId,stripeRefundObservation(response));
    }
    let response;
    try{const client=paypalRefundClient();if(!client.retrieveRefund)throw new Error();response=await boundedRead(()=>client.retrieveRefund!(claim.reference!));}
    catch{return retainUnresolved(refundId,"RECONCILIATION_UNAVAILABLE");}
    const parent=paypalRefundParent(response);
    if(response.id!==claim.reference||!parent || response.custom_id&&response.custom_id!==`cl-refund-${refundId}`)return retainUnresolved(refundId,"PROVIDER_EVIDENCE_MISMATCH",true);
    return applyRefundObservation(refundId,paypalRefundObservation(response,parent));
  });
}
