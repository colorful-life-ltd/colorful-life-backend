import { prisma } from "../../prisma/runtime.js";
import { config } from "../../config/index.js";
import { databaseNow, journalResolutionOperation, managedResolution } from "./paymentResolutionService.js";
import { reconcilePayPalWebhookEvent } from "./paypalReconciliationService.js";
import { randomUUID } from "node:crypto";

export type PayPalResolutionOrder = { id: string; status: string; purchase_units?: Array<{ payments?: { captures?: Array<{
  id: string; status: string; amount: { value: string; currency_code: string };
}> } }> };
export type PayPalResolutionClient = { retrieveOrder(id: string): Promise<PayPalResolutionOrder> };
let testClient: PayPalResolutionClient | undefined;
export function setPayPalResolutionClientForTests(client: PayPalResolutionClient) {
  const previous=testClient;testClient=client;return()=>{testClient=previous;};
}
function providerClient(): PayPalResolutionClient {
  if (process.env.NODE_ENV === "test") throw Error("A local PayPal resolution fake is required");
  return {async retrieveOrder(id) {
    if (!config.PAYPAL_CLIENT_ID || !config.PAYPAL_CLIENT_SECRET) throw Error("PayPal unavailable");
    const authorization=Buffer.from(`${config.PAYPAL_CLIENT_ID}:${config.PAYPAL_CLIENT_SECRET}`).toString("base64");
    const auth=await fetch(`${config.PAYPAL_BASE_URL}/v1/oauth2/token`,{method:"POST",headers:{Authorization:`Basic ${authorization}`,"Content-Type":"application/x-www-form-urlencoded"},body:"grant_type=client_credentials",signal:AbortSignal.timeout(10_000)});
    if (!auth.ok) throw Error("PayPal unavailable");
    const token=await auth.json() as {access_token:string};
    const response=await fetch(`${config.PAYPAL_BASE_URL}/v2/checkout/orders/${encodeURIComponent(id)}`,{headers:{Authorization:`Bearer ${token.access_token}`},signal:AbortSignal.timeout(10_000)});
    if (!response.ok) throw Error("PayPal outcome unknown");
    return await response.json() as PayPalResolutionOrder;
  }};
}
/** Read-only provider reconciliation. No generic cancellation or deadline-based finality claim. */
export async function resolvePayPalPaymentOutcome(orderId: number, client?: PayPalResolutionClient) {
  const claim=await prisma.$transaction(async tx=>{
    await tx.$queryRaw`SELECT id FROM "Order" WHERE id=${orderId} FOR UPDATE`;
    const r=await managedResolution(tx,orderId);
    const payment=await tx.payment.findUnique({where:{orderId}});
    if (!r || r.reservationDisposition!=="HELD" || r.state==="PAID" || !payment || payment.provider!=="PAYPAL" || payment.paidAt || payment.status==="SUCCEEDED") return null;
    const now=await databaseNow(tx);
    if (!r.paymentAdmissionClosedAt && now < (r.retryDeadline ?? r.initialPaymentDeadline)) {
      await tx.paymentResolution.update({where:{orderId},data:{resolutionNextCheckAt:r.retryDeadline??r.initialPaymentDeadline}});return null;
    }
    const attempt=await tx.paymentAttempt.findFirst({where:{paymentId:payment.id,providerReference:payment.providerReference,historical:false}});
    if (!attempt || payment.providerReference.startsWith("pending:")) {
      await tx.paymentResolution.update({where:{orderId},data:{state:"SAFETY_HOLD",resolutionNextCheckAt:new Date(now.getTime()+300_000),escalatedAt:r.escalatedAt??now}});return null;
    }
    if (await tx.paymentOperation.findFirst({where:{attemptId:attempt.id,type:"RETRIEVE",leaseExpiresAt:{gt:now}}})) return null;
    const reusable=await tx.paymentOperation.findFirst({where:{attemptId:attempt.id,type:"RETRIEVE",state:{in:["POTENTIALLY_DISPATCHED","UNKNOWN"]},OR:[{leaseExpiresAt:null},{leaseExpiresAt:{lte:now}}]},orderBy:{id:"asc"}});
    const operation=reusable??await journalResolutionOperation(tx,attempt.id,"RETRIEVE");const owner=randomUUID();
    await tx.paymentOperation.update({where:{id:operation.id},data:{claimOwner:owner,claimGeneration:{increment:1},executionCount:reusable?{increment:1}:undefined,leaseExpiresAt:new Date(now.getTime()+60_000)}});
    await tx.paymentResolution.update({where:{orderId},data:{resolutionNextCheckAt:new Date(now.getTime()+60_000)}});
    return {payment,operation,owner};
  });
  if (!claim) return;
  try {
    const remote=await (client??testClient??providerClient()).retrieveOrder(claim.payment.providerReference);
    const captures=remote.purchase_units?.flatMap(unit=>unit.payments?.captures??[])??[];
    const capture=captures[0];
    if (remote.id !== claim.payment.providerReference || captures.length>1) throw Error("PayPal evidence mismatch");
    if (capture && ["COMPLETED","DENIED","DECLINED","PENDING"].includes(capture.status)) {
      if (!capture.id || capture.amount?.value!==claim.payment.amount.toFixed(2) || capture.amount.currency_code!==claim.payment.currency) throw Error("PayPal evidence mismatch");
      // Verified GET observation is durably stored in the existing inbox. It is not a provider webhook delivery.
      await reconcilePayPalWebhookEvent({id:`resolution:${remote.id}:${capture.id}:${capture.status}`,
        eventType:capture.status==="COMPLETED"?"PAYMENT.CAPTURE.COMPLETED":capture.status==="PENDING"?"PAYMENT.CAPTURE.PENDING":"PAYMENT.CAPTURE.DENIED",
        paypalOrderId:remote.id,captureId:capture.id,amount:capture.amount.value,currency:capture.amount.currency_code});
    }
  } catch { /* A missing/expired object or provider outage proves no finality. Retain stock. */ }
  await prisma.$transaction(async tx=>{
    await tx.$queryRaw`SELECT id FROM "Order" WHERE id=${orderId} FOR UPDATE`;
    const op=await tx.paymentOperation.findUniqueOrThrow({where:{id:claim.operation.id}});
    if (op.claimOwner!==claim.owner) return;
    await tx.paymentOperation.update({where:{id:op.id},data:{state:"UNKNOWN",claimOwner:null,leaseExpiresAt:null,lastErrorCode:"PAYPAL_FINALITY_UNPROVEN"}});
    const r=await managedResolution(tx,orderId);const now=await databaseNow(tx);
    if (r && r.state!=="PAID") await tx.paymentResolution.update({where:{orderId},data:{state:r.retryDeadline && !r.paymentAdmissionClosedAt?"RETRY_OPEN":"SAFETY_HOLD",
      resolutionNextCheckAt:new Date(now.getTime()+300_000),escalatedAt:r.escalatedAt??now}});
  });
}
