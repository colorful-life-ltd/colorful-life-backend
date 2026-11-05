import { config } from "../../config/index.js";
import type { RefundObservation } from "./refundLifecycleService.js";
export class PayPalRefundProviderError extends Error {}
export type PayPalRefundResponse={id?:string;status?:string;amount?:{value?:string;currency_code?:string};custom_id?:string;links?:Array<{rel?:string;href?:string}>};
// Stripe is the only payment provider: new PayPal refunds cannot be submitted. The runtime
// client only retrieves existing (historical) refunds for reconciliation. `refundCapture`
// is supplied solely by retired-PayPal test fixtures that recreate historical records.
export type PayPalRefundClient={refundCapture?(captureId:string,requestId:string,amount:string,currency:string,localRefundId?:number):Promise<PayPalRefundResponse>;
  retrieveRefund?(reference:string):Promise<PayPalRefundResponse>};
let testClient:PayPalRefundClient|undefined;
export function setPayPalRefundClientForTests(client:PayPalRefundClient):()=>void{const previous=testClient;testClient=client;return()=>{testClient=previous;};}
export function paypalRefundClient():PayPalRefundClient{
  if(testClient)return testClient;
  if(!config.PAYPAL_CLIENT_ID||!config.PAYPAL_CLIENT_SECRET)throw new PayPalRefundProviderError("PayPal is not configured");
  // GET only: retrieval of existing refunds. No PayPal refund can be submitted.
  async function request(path:string){
    const signal=AbortSignal.timeout(5000);
    const auth=await fetch(`${config.PAYPAL_BASE_URL}/v1/oauth2/token`,{method:"POST",redirect:"error",signal,headers:{Authorization:`Basic ${Buffer.from(`${config.PAYPAL_CLIENT_ID}:${config.PAYPAL_CLIENT_SECRET}`).toString("base64")}`,"Content-Type":"application/x-www-form-urlencoded"},body:"grant_type=client_credentials"});
    if(!auth.ok)throw new PayPalRefundProviderError("PayPal authentication unavailable");
    const token=(await auth.json() as {access_token?:string}).access_token;if(!token)throw new PayPalRefundProviderError("PayPal authentication unavailable");
    const response=await fetch(`${config.PAYPAL_BASE_URL}${path}`,{method:"GET",redirect:"error",signal,headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json",Prefer:"return=representation"}});
    if(!response.ok)throw new PayPalRefundProviderError("PayPal operation unavailable");
    return await response.json() as PayPalRefundResponse;
  }
  return {retrieveRefund:reference=>request(`/v2/payments/refunds/${encodeURIComponent(reference)}`)};
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
