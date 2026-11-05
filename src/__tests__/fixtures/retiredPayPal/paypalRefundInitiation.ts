// RETIRED: PayPal refunds can no longer be initiated by the application. This copy of the
// former initiation path exists only so historical-compatibility tests can create PayPal
// refund records exactly as production once did. It lives under __tests__, which the
// runtime image deletes, and it requires an injected (fake) provider client.
import { Decimal } from "@prisma/client/runtime/client";
import { refundConflictEvidence } from "../../../domain/refunds/refundEvidenceService.js";
import { applyRefundObservation, DefinitiveRefundRejection, prepareExternalRefund, refundWithContext, retainUnresolved } from "../../../domain/refunds/refundLifecycleService.js";
import { paypalRefundClient, paypalRefundObservation, paypalRefundParent, type PayPalRefundClient, type PayPalRefundResponse } from "../../../domain/refunds/paypalRefundService.js";

export async function createOrReusePayPalRefund(orderId:number,paymentId:number,inputAmount:Decimal|number,reason:string|undefined,performedByUserId:number,
  injectedClient?:PayPalRefundClient,refundId?:number,clientRequestKey?:string){
  const prepared=await prepareExternalRefund({orderId,paymentId,amount:inputAmount,reason,actor:performedByUserId,provider:"PAYPAL",refundId,clientRequestKey});
  if(!prepared.submit)return prepared.refund;
  const refund=prepared.refund;
  return refundWithContext(refund.id,async()=>{
    let response:PayPalRefundResponse;
    try{const client=injectedClient??paypalRefundClient();if(!client.refundCapture)throw new Error("Retired PayPal fixture requires an injected client");response=await client.refundCapture(refund.providerPaymentReference!,refund.refundIdempotencyKey!,new Decimal(refund.amount).toFixed(2),refund.currency,refund.id);}
    catch(error){
      if(error instanceof DefinitiveRefundRejection)return applyRefundObservation(refund.id,{provider:"PAYPAL",parentReference:refund.providerPaymentReference!,amount:refund.amount.toString(),currency:refund.currency,status:"FAILED",rejectionCode:error.safeCode});
      return retainUnresolved(refund.id,"PROVIDER_OUTCOME_UNKNOWN");
    }
    // The authenticated POST response belongs to its requested capture. Any supplied parent/custom ID must corroborate it.
    const parent=paypalRefundParent(response);
    if(response.links?.some(link=>link.rel==="up")&&!parent || parent&&parent!==refund.providerPaymentReference || response.custom_id&&response.custom_id!==`cl-refund-${refund.id}`)return retainUnresolved(refund.id,"PROVIDER_EVIDENCE_MISMATCH",true,refundConflictEvidence("PROVIDER_EVIDENCE_MISMATCH","POST",{observedReference:response.id,observedAmount:response.amount?.value,observedCurrency:response.amount?.currency_code,observedParent:parent}));
    const validId=typeof response.id==="string"&&/^[A-Za-z0-9_-]{1,256}$/.test(response.id);
    if(!validId||!response.amount?.value||!response.amount.currency_code)return retainUnresolved(refund.id,"INCOMPLETE_PROVIDER_RESPONSE",false,validId?{reference:response.id!}:undefined);
    return applyRefundObservation(refund.id,{...paypalRefundObservation(response,parent??refund.providerPaymentReference!),source:"POST"});
  });
}
