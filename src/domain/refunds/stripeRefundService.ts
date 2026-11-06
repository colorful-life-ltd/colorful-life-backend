import {refundConflictEvidence} from "./refundEvidenceService.js";
import Stripe from "stripe";
import { Decimal } from "@prisma/client/runtime/client";
import { config } from "../../config/index.js";
import { applyRefundObservation, prepareExternalRefund, refundWithContext, retainUnresolved, type RefundObservation } from "./refundLifecycleService.js";

export class StripeRefundProviderError extends Error {}
export class StripeRefundValidationError extends Error {}
export type StripeRefundResponse=Pick<Stripe.Refund,"id"|"amount"|"currency"|"status"|"payment_intent"|"metadata">;
export type StripeRefundList={data:StripeRefundResponse[];has_more:boolean};
export type StripeRefundClient={createRefund(input:Stripe.RefundCreateParams,options:Stripe.RequestOptions):Promise<StripeRefundResponse>;
  retrieveRefund?(reference:string):Promise<StripeRefundResponse>;listRefunds?(paymentIntent:string):Promise<StripeRefundList>};
let testClient:StripeRefundClient|undefined;
export function setStripeRefundClientForTests(client:StripeRefundClient):()=>void{const previous=testClient;testClient=client;return()=>{testClient=previous;};}
export function stripeRefundClient():StripeRefundClient{
  if(testClient)return testClient;
  if(!config.STRIPE_SECRET_KEY)throw new StripeRefundProviderError("Stripe is not configured");
  const stripe=new Stripe(config.STRIPE_SECRET_KEY,{timeout:5000,maxNetworkRetries:0});
  return {createRefund:(input,options)=>stripe.refunds.create(input,options) as Promise<StripeRefundResponse>,
    retrieveRefund:reference=>stripe.refunds.retrieve(reference) as Promise<StripeRefundResponse>,
    listRefunds:paymentIntent=>stripe.refunds.list({payment_intent:paymentIntent,limit:100}) as Promise<StripeRefundList>};
}
/** A complete Stripe refund object of this intent (Stripe.Refund contract): object "refund", id, positive
 * integer amount, currency, created, a status, and a metadata key that is present (null or an object).
 * Truncated or ambiguous objects (e.g. only id and payment_intent, or status null) are not evidence. */
function wellFormedListedRefund(r:Record<string,unknown>,paymentIntent:string){
  const intent=r.payment_intent;
  const parent=typeof intent==="string"?intent:intent&&typeof intent==="object"?(intent as {id?:unknown}).id:undefined;
  return r.object==="refund"&&typeof r.id==="string"&&!!r.id&&parent===paymentIntent
    &&Number.isSafeInteger(r.amount)&&(r.amount as number)>0&&typeof r.currency==="string"&&/^[a-z]{3}$/i.test(r.currency)
    &&Number.isSafeInteger(r.created)&&(r.created as number)>0&&typeof r.status==="string"&&!!r.status
    &&Object.prototype.hasOwnProperty.call(r,"metadata")&&(r.metadata===null||(typeof r.metadata==="object"&&!Array.isArray(r.metadata)));
}
/** Classifies one listed entry. "unrelated" needs a complete refund object of this intent that provably is
 * not this local refund (explicit null metadata, no local_refund_id, or another canonical refund ID). Anything
 * that cannot be classified is "malformed" and makes the whole lookup unavailable, never evidence of absence. */
function classifyListedRefund(entry:unknown,paymentIntent:string,refundId:number):"match"|"unrelated"|"malformed"{
  if(!entry||typeof entry!=="object"||Array.isArray(entry))return "malformed";
  const r=entry as Record<string,unknown>;
  if(!wellFormedListedRefund(r,paymentIntent))return "malformed";
  const metadata=r.metadata;
  if(metadata===null)return "unrelated";
  const local=(metadata as Record<string,unknown>).local_refund_id;
  if(local===undefined)return "unrelated";
  if(typeof local!=="string"||!/^[1-9][0-9]*$/.test(local))return "malformed";
  return local===String(refundId)?"match":"unrelated";
}
/** The refunds Stripe holds for this intent that carry this local refund's metadata. Only a complete
 * (unpaginated) list whose every entry is classifiable is evidence; any failure, truncation or
 * malformed entry is "unavailable", never "none". */
export async function stripeRefundsForLocalRefund(client:StripeRefundClient,paymentIntent:string,refundId:number)
  :Promise<{complete:true;matches:StripeRefundResponse[]}|{complete:false}>{
  if(!client.listRefunds)return {complete:false};
  try{
    const list=await client.listRefunds(paymentIntent);
    if(!list||!Array.isArray(list.data)||list.has_more!==false)return {complete:false};
    const matches:StripeRefundResponse[]=[];
    for(const entry of list.data){
      const kind=classifyListedRefund(entry,paymentIntent,refundId);
      if(kind==="malformed")return {complete:false};
      if(kind==="match")matches.push(entry);
    }
    return {complete:true,matches};
  }catch{return {complete:false};}
}
/** A lookup match is adopted only with full correlation: our metadata, this intent and a valid amount. */
export function stripeLookupMatchValid(response:StripeRefundResponse,refundId:number,orderId:number,paymentIntent:string){
  const parent=typeof response.payment_intent==="string"?response.payment_intent:response.payment_intent?.id;
  return typeof response.id==="string"&&!!response.id&&parent===paymentIntent&&response.metadata?.local_refund_id===String(refundId)
    &&response.metadata?.order_id===String(orderId)&&Number.isSafeInteger(response.amount)&&response.amount>0;
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
/** Request-validation rejections: Stripe refuses the request before executing anything. */
const VALIDATION_REJECTIONS=["parameter_invalid_enum","parameter_missing","parameter_unknown","parameter_invalid_integer"];
/** Documented refund refusals (docs.stripe.com/error-codes) that create no refund. They release capacity
 * only when a complete provider lookup also shows no refund carrying this local refund's metadata. */
export const STRIPE_REFUND_REJECTIONS=["refund_disputed_payment","amount_too_large","amount_too_small"];
type Classified={kind:"validation"|"refund_rejection";code:string}|{kind:"unresolved";code:string};
/** Anything not clearly definitive (timeouts, network, 5xx, 409, 429, unknown codes) stays unresolved. */
function classifyRejection(error:unknown):Classified{
  if(error instanceof Stripe.errors.StripeInvalidRequestError && error.statusCode===400 && error.code){
    if(VALIDATION_REJECTIONS.includes(error.code))return {kind:"validation",code:error.code};
    if(STRIPE_REFUND_REJECTIONS.includes(error.code))return {kind:"refund_rejection",code:error.code};
  }
  if(error instanceof Stripe.errors.StripeError && error.statusCode===429)return {kind:"unresolved",code:"PROVIDER_RETRY_LATER"};
  return {kind:"unresolved",code:"PROVIDER_OUTCOME_UNKNOWN"};
}
/** Releases capacity for a definitive refusal only with corroborating lookup evidence; otherwise retains it. */
export async function resolveStripeRefusal(client:StripeRefundClient,refund:{id:number;orderId:number;amount:Decimal;currency:string;providerPaymentReference:string|null},rejectionCode:string){
  const parent=refund.providerPaymentReference!;
  const lookup=await stripeRefundsForLocalRefund(client,parent,refund.id);
  if(!lookup.complete)return retainUnresolved(refund.id,"PROVIDER_REJECTION_UNCORROBORATED",false,{issue:"PROVIDER_REJECTION_UNCORROBORATED",rejectionCode});
  if(lookup.matches.length===0)return applyRefundObservation(refund.id,{provider:"STRIPE",parentReference:parent,amount:refund.amount.toString(),currency:refund.currency,status:"FAILED",rejectionCode,source:"POST"});
  const [match]=lookup.matches;
  if(lookup.matches.length===1&&stripeLookupMatchValid(match,refund.id,refund.orderId,parent))return applyRefundObservation(refund.id,{...stripeRefundObservation(match),source:"GET"});
  return retainUnresolved(refund.id,"PROVIDER_EVIDENCE_MISMATCH",true,refundConflictEvidence("PROVIDER_EVIDENCE_MISMATCH","GET",{rejectionCode,observedMatches:lookup.matches.length}));
}
export async function createOrReuseStripeRefund(orderId:number,paymentId:number,inputAmount:Decimal|number,reason:string|undefined,performedByUserId:number,
  injectedClient?:StripeRefundClient,refundId?:number,clientRequestKey?:string){
  const prepared=await prepareExternalRefund({orderId,paymentId,amount:inputAmount,reason,actor:performedByUserId,provider:"STRIPE",refundId,clientRequestKey});
  if(!prepared.submit)return prepared.refund; // Includes legacy and ambiguous intents: never blindly resubmit.
  const refund=prepared.refund;
  return refundWithContext(refund.id,async()=>{
    let response:StripeRefundResponse,client:StripeRefundClient|undefined;
    try{
      client=injectedClient??stripeRefundClient();
      response=await client.createRefund({payment_intent:refund.providerPaymentReference!,amount:new Decimal(refund.amount).mul(100).toNumber(),
        metadata:{local_refund_id:String(refund.id),order_id:String(orderId)}}, {idempotencyKey:refund.refundIdempotencyKey!});
    }catch(error){
      const rejection=classifyRejection(error);
      if(rejection.kind==="validation")return applyRefundObservation(refund.id,{provider:"STRIPE",parentReference:refund.providerPaymentReference!,amount:refund.amount.toString(),currency:refund.currency,status:"FAILED",rejectionCode:rejection.code});
      if(rejection.kind==="refund_rejection"&&client)return resolveStripeRefusal(client,refund,rejection.code);
      return retainUnresolved(refund.id,rejection.code);
    }
    if(!stripeRefundMetadataMatches(response,refund.id,orderId))return retainUnresolved(refund.id,"PROVIDER_EVIDENCE_MISMATCH",true,refundConflictEvidence("PROVIDER_EVIDENCE_MISMATCH","POST",{observedReference:response.id,observedAmount:response.amount,observedCurrency:response.currency}));
    let observation:RefundObservation;
    try{if(!Number.isSafeInteger(response.amount)||response.amount<=0||!response.id)throw new Error();observation=stripeRefundObservation(response);}
    catch{return retainUnresolved(refund.id,"INVALID_PROVIDER_RESPONSE",true);}
    return applyRefundObservation(refund.id,{...observation,source:"POST"});
  });
}
