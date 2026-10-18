import {refundConflictEvidence} from "./refundEvidenceService.js";
import Stripe from "stripe";
import { Decimal } from "@prisma/client/runtime/client";
import { config } from "../../config/index.js";
import { applyRefundObservation, prepareExternalRefund, refundWithContext, retainUnresolved, type RefundObservation } from "./refundLifecycleService.js";

export class StripeRefundProviderError extends Error {}
export class StripeRefundValidationError extends Error {}
export type StripeRefundResponse=Pick<Stripe.Refund,"id"|"amount"|"currency"|"status"|"payment_intent"|"metadata">;
export type StripeRefundClient={createRefund(input:Stripe.RefundCreateParams,options:Stripe.RequestOptions):Promise<StripeRefundResponse>;
  retrieveRefund?(reference:string):Promise<StripeRefundResponse>};
let testClient:StripeRefundClient|undefined;
export function setStripeRefundClientForTests(client:StripeRefundClient):()=>void{const previous=testClient;testClient=client;return()=>{testClient=previous;};}
export function stripeRefundClient():StripeRefundClient{
  if(testClient)return testClient;
  if(!config.STRIPE_SECRET_KEY)throw new StripeRefundProviderError("Stripe is not configured");
  const stripe=new Stripe(config.STRIPE_SECRET_KEY,{timeout:5000,maxNetworkRetries:0});
  return {createRefund:(input,options)=>stripe.refunds.create(input,options) as Promise<StripeRefundResponse>,
    retrieveRefund:reference=>stripe.refunds.retrieve(reference) as Promise<StripeRefundResponse>};
}
export function stripeRefundObservation(response:StripeRefundResponse):RefundObservation{
  const parent=typeof response.payment_intent==="string"?response.payment_intent:response.payment_intent?.id;
  return {provider:"STRIPE",reference:response.id,parentReference:parent??"",amount:new Decimal(response.amount).div(100).toFixed(2),
    currency:response.currency??"",status:response.status==="succeeded"?"SUCCEEDED":response.status==="failed"||response.status==="canceled"?"FAILED"
      :response.status==="pending"||response.status==="requires_action"?"PENDING":"UNKNOWN"};
}
export function stripeRefundMetadataMatches(response:StripeRefundResponse,refundId:number,orderId:number){
  return (!response.metadata?.local_refund_id||response.metadata.local_refund_id===String(refundId))
    && (!response.metadata?.order_id||response.metadata.order_id===String(orderId));
}
function definitiveRejection(error:unknown):string|undefined{
  if(error instanceof Stripe.errors.StripeInvalidRequestError && error.statusCode===400
    && ["parameter_invalid_enum","parameter_missing","parameter_unknown","parameter_invalid_integer"].includes(error.code??""))return error.code;
  return undefined;
}
export async function createOrReuseStripeRefund(orderId:number,paymentId:number,inputAmount:Decimal|number,reason:string|undefined,performedByUserId:number,
  injectedClient?:StripeRefundClient,refundId?:number,clientRequestKey?:string){
  const prepared=await prepareExternalRefund({orderId,paymentId,amount:inputAmount,reason,actor:performedByUserId,provider:"STRIPE",refundId,clientRequestKey});
  if(!prepared.submit)return prepared.refund; // Includes legacy and ambiguous intents: never blindly resubmit.
  const refund=prepared.refund;
  return refundWithContext(refund.id,async()=>{
    let response:StripeRefundResponse;
    try{
      response=await (injectedClient??stripeRefundClient()).createRefund({payment_intent:refund.providerPaymentReference!,amount:new Decimal(refund.amount).mul(100).toNumber(),
        metadata:{local_refund_id:String(refund.id),order_id:String(orderId)}}, {idempotencyKey:refund.refundIdempotencyKey!});
    }catch(error){
      const code=definitiveRejection(error);
      if(code)return applyRefundObservation(refund.id,{provider:"STRIPE",parentReference:refund.providerPaymentReference!,amount:refund.amount.toString(),currency:refund.currency,status:"FAILED",rejectionCode:code});
      return retainUnresolved(refund.id,"PROVIDER_OUTCOME_UNKNOWN");
    }
    if(!stripeRefundMetadataMatches(response,refund.id,orderId))return retainUnresolved(refund.id,"PROVIDER_EVIDENCE_MISMATCH",true,refundConflictEvidence("PROVIDER_EVIDENCE_MISMATCH","POST",{observedReference:response.id,observedAmount:response.amount,observedCurrency:response.currency}));
    let observation:RefundObservation;
    try{if(!Number.isSafeInteger(response.amount)||response.amount<=0||!response.id)throw new Error();observation=stripeRefundObservation(response);}
    catch{return retainUnresolved(refund.id,"INVALID_PROVIDER_RESPONSE",true);}
    return applyRefundObservation(refund.id,{...observation,source:"POST"});
  });
}
