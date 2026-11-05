import assert from "node:assert/strict";
import { afterEach,it,mock } from "node:test";
import { config } from "../config/index.js";
import { paypalRefundClient, paypalRefundParent } from "../domain/refunds/paypalRefundService.js";
const old={id:config.PAYPAL_CLIENT_ID,secret:config.PAYPAL_CLIENT_SECRET,base:config.PAYPAL_BASE_URL};
afterEach(()=>{mock.restoreAll();config.PAYPAL_CLIENT_ID=old.id;config.PAYPAL_CLIENT_SECRET=old.secret;config.PAYPAL_BASE_URL=old.base;});
function setup(){config.PAYPAL_CLIENT_ID="offline-client";config.PAYPAL_CLIENT_SECRET="offline-secret";config.PAYPAL_BASE_URL="https://api-m.sandbox.paypal.com";}
it("the runtime PayPal client cannot submit a refund: retrieval of historical refunds only",async()=>{
 setup();let calls=0;mock.method(globalThis,"fetch",async()=>{calls++;return new Response("{}");});
 const client=paypalRefundClient();
 assert.equal(client.refundCapture,undefined);assert.deepEqual(Object.keys(client),["retrieveRefund"]);assert.equal(calls,0);
});
it("PayPal GET uses a fixed endpoint and never follows external evidence links",async()=>{
 setup();let calls=0;mock.method(globalThis,"fetch",async(url:unknown,init?:RequestInit)=>{calls++;if(calls===1)return new Response(JSON.stringify({access_token:"offline-token"}));
  assert.equal(String(url),`${config.PAYPAL_BASE_URL}/v2/payments/refunds/REF-1`);assert.equal(init?.method,"GET");assert.equal(init?.body,undefined);return new Response(JSON.stringify({id:"REF-1",status:"PENDING"}));});
 await paypalRefundClient().retrieveRefund!("REF-1");assert.equal(calls,2);
 assert.equal(paypalRefundParent({links:[{rel:"up",href:"https://attacker.invalid/v2/payments/captures/CAP"}]}),undefined);
 assert.equal(paypalRefundParent({links:[{rel:"up",href:`${config.PAYPAL_BASE_URL}/v2/payments/captures/CAP`}]}),"CAP");
});
for(const environment of ["live","sandbox"]){
 it(`PayPal ${environment} accepts official host aliases only with exact capture paths`,()=>{
  const suffix=environment==="sandbox"?"sandbox.paypal.com":"paypal.com";
  config.PAYPAL_BASE_URL=`https://api-m.${suffix}`;
  const parent=(href:string)=>paypalRefundParent({links:[{rel:"up",href}]});
  for(const host of [`api-m.${suffix}`,`api.${suffix}`])assert.equal(parent(`https://${host}/v2/payments/captures/CAP-1`),"CAP-1");
  const other=environment==="sandbox"?"api.paypal.com":"api.sandbox.paypal.com";
  for(const href of [
   `https://${other}/v2/payments/captures/CAP-1`,"https://attacker.invalid/v2/payments/captures/CAP-1",
   `http://api.${suffix}/v2/payments/captures/CAP-1`,`https://user@api.${suffix}/v2/payments/captures/CAP-1`,
   `https://api.${suffix}:444/v2/payments/captures/CAP-1`,`https://api.${suffix}/v2/payments/captures/CAP-1?x=1`,
   `https://api.${suffix}/v2/payments/captures/CAP-1#x`,`https://api.${suffix}/v2/payments/captures/CAP-1/refund`,
   `https://api.${suffix}/v2/payments/captures/CAP%2F1`
  ])assert.equal(parent(href),undefined,href);
  assert.equal(paypalRefundParent({links:[{rel:"up",href:`https://api.${suffix}/v2/payments/captures/A`},{rel:"up",href:`https://api-m.${suffix}/v2/payments/captures/B`}]}),undefined);
  config.PAYPAL_BASE_URL="https://attacker.invalid";assert.equal(parent(`https://api.${suffix}/v2/payments/captures/CAP-1`),undefined);
 });
}
it("PayPal authenticated requests reject redirects rather than following links",async()=>{
 setup();let calls=0;mock.method(globalThis,"fetch",async(_url:unknown,init?:RequestInit)=>{
  calls++;assert.equal(init?.redirect,"error");return calls===1?new Response(JSON.stringify({access_token:"offline-token"})):new Response(null,{status:302,headers:{Location:"https://attacker.invalid"}});
 });
 await assert.rejects(paypalRefundClient().retrieveRefund!("REF-1"));assert.equal(calls,2);
});
