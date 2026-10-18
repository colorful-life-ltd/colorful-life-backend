import {refundConflictEvidence} from "./refundEvidenceService.js";
import { Decimal } from "@prisma/client/runtime/client";
import { config } from "../../config/index.js";
import { applyRefundObservation, DefinitiveRefundRejection, prepareExternalRefund, refundWithContext, retainUnresolved, type RefundObservation } from "./refundLifecycleService.js";
export class PayPalRefundProviderError extends Error {}
export class PayPalRefundValidationError extends Error {}
export type PayPalRefundResponse={id?:string;status?:string;amount?:{value?:string;currency_code?:string};custom_id?:string;links?:Array<{rel?:string;href?:string}>};
export type PayPalRefundClient={refundCapture(captureId:string,requestId:string,amount:string,currency:string,localRefundId?:number):Promise<PayPalRefundResponse>;
  retrieveRefund?(reference:string):Promise<PayPalRefundResponse>};
let testClient:PayPalRefundClient|undefined;
export function setPayPalRefundClientForTests(client:PayPalRefundClient):()=>void{const previous=testClient;testClient=client;return()=>{testClient=previous;};}
export function paypalRefundClient():PayPalRefundClient{
  if(testClient)return testClient;
  if(!config.PAYPAL_CLIENT_ID||!config.PAYPAL_CLIENT_SECRET)throw new PayPalRefundProviderError("PayPal is not configured");
  async function request(path:string,body?:object,requestId?:string){
    const signal=AbortSignal.timeout(5000);
    const auth=await fetch(`${config.PAYPAL_BASE_URL}/v1/oauth2/token`,{method:"POST",redirect:"error",signal,headers:{Authorization:`Basic ${Buffer.from(`${config.PAYPAL_CLIENT_ID}:${config.PAYPAL_CLIENT_SECRET}`).toString("base64")}`,"Content-Type":"application/x-www-form-urlencoded"},body:"grant_type=client_credentials"});
    if(!auth.ok)throw new PayPalRefundProviderError("PayPal authentication unavailable");
    const token=(await auth.json() as {access_token?:string}).access_token;if(!token)throw new PayPalRefundProviderError("PayPal authentication unavailable");
    const response=await fetch(`${config.PAYPAL_BASE_URL}${path}`,{method:body?"POST":"GET",redirect:"error",signal,headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json",Prefer:"return=representation",...(requestId?{"PayPal-Request-Id":requestId}:{})},...(body?{body:JSON.stringify(body)}:{})});
    if(!response.ok){
      if(body && response.status===400){
        const error=await response.json() as {name?:string;details?:Array<{issue?:string}>};
        const issues=error.details?.map(d=>d.issue);
        if(error.name==="INVALID_REQUEST" && issues?.length && issues.every(i=>["INVALID_PARAMETER_VALUE","MISSING_REQUIRED_PARAMETER","INVALID_STRING_LENGTH"].includes(i??"")))throw new DefinitiveRefundRejection("PAYPAL_INVALID_REQUEST");
      }
      throw new PayPalRefundProviderError("PayPal operation unavailable");
    }
    return await response.json() as PayPalRefundResponse;
  }
  return {refundCapture:(captureId,requestId,amount,currency,localRefundId)=>request(`/v2/payments/captures/${encodeURIComponent(captureId)}/refund`,
    {amount:{value:amount,currency_code:currency},custom_id:`cl-refund-${localRefundId}`},requestId),
    retrieveRefund:reference=>request(`/v2/payments/refunds/${encodeURIComponent(reference)}`)};
}
/** Parse identity only; never follow a provider-supplied URL. */
export function paypalRefundParent(response:PayPalRefundResponse):string|undefined{
  const live=["api-m.paypal.com","api.paypal.com"];
  const sandbox=["api-m.sandbox.paypal.com","api.sandbox.paypal.com"];
  try{
    const base=new URL(config.PAYPAL_BASE_URL);
    const hosts=live.includes(base.hostname)?live:sandbox.includes(base.hostname)?sandbox:[];
    if(base.protocol!=="https:"||base.port||base.username||base.password)return undefined;
    const links=response.links?.filter(l=>l.rel==="up")??[];
    if(!links.length)return undefined;
    let parent:string|undefined;
    for(const link of links){
      if(!link.href)return undefined;
      const url=new URL(link.href);
      if(url.protocol!=="https:"||!hosts.includes(url.hostname)||url.port||url.username||url.password||url.search||url.hash)return undefined;
      const match=/^\/v2\/payments\/captures\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
      if(!match || parent!==undefined&&parent!==match[1])return undefined;
      parent=match[1];
    }
    return parent;
  }catch{return undefined;}
}
export function paypalRefundObservation(response:PayPalRefundResponse,parentReference:string):RefundObservation{
  return {provider:"PAYPAL",reference:response.id,parentReference,amount:response.amount?.value??"",currency:response.amount?.currency_code??"",
    status:response.status==="COMPLETED"?"SUCCEEDED":response.status==="FAILED"||response.status==="CANCELLED"?"FAILED":response.status==="PENDING"?"PENDING":"UNKNOWN"};
}
export async function createOrReusePayPalRefund(orderId:number,paymentId:number,inputAmount:Decimal|number,reason:string|undefined,performedByUserId:number,
  injectedClient?:PayPalRefundClient,refundId?:number,clientRequestKey?:string){
  const prepared=await prepareExternalRefund({orderId,paymentId,amount:inputAmount,reason,actor:performedByUserId,provider:"PAYPAL",refundId,clientRequestKey});
  if(!prepared.submit)return prepared.refund;
  const refund=prepared.refund;
  return refundWithContext(refund.id,async()=>{
    let response:PayPalRefundResponse;
    try{response=await (injectedClient??paypalRefundClient()).refundCapture(refund.providerPaymentReference!,refund.refundIdempotencyKey!,new Decimal(refund.amount).toFixed(2),refund.currency,refund.id);}
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
