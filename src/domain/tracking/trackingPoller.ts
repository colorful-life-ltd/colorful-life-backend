import { chargeTrackingBudget } from "./trackingBudget.js";
import { randomUUID } from "node:crypto";
import { prisma } from "../../prisma/runtime.js";
import { config } from "../../config/index.js";
import { databaseNow } from "../payments/paymentResolutionService.js";
import { isValidTrackingNumber, normalizeTrackingNumber } from "../fulfilment/carriers.js";
import { persistTrackingConflict, ingestTrackingObservationInTransaction, lockTrackingShipment } from "./trackingService.js";
import { TrackingConflictError, TrackingProviderError, TrackingObservationSchema, type CarrierTrackingAdapter } from "./trackingContract.js";
import type { ShippingCarrier } from "../../generated/prisma-client/enums.js";
import { z } from "zod";
import { ZodError } from "zod";

export const PollPolicySchema = z.object({
  maxRequests: z.number().int().min(1).max(25).default(20),
  perMinute: z.number().int().min(1).max(60).default(10),
  perDay: z.number().int().min(1).max(1000).default(100),
  maxFailures: z.number().int().min(1).max(8).default(5),
  maxLifetimeRequests: z.number().int().min(1).max(200).default(100),
  timeoutMs: z.number().int().min(10).max(10_000).default(5_000),
  runTimeoutMs: z.number().int().min(10).max(120_000).default(60_000),
  successIntervalMs: z.number().int().min(60_000).max(24*60*60_000).default(6*60*60_000),
  baseBackoffMs: z.number().int().min(60_000).max(60*60_000).default(60_000),
}).strict();
export type PollPolicy = z.output<typeof PollPolicySchema>;
// No real adapters until official contracts, credentials and activation are separately approved.
export const realCarrierAdapters: ReadonlyMap<ShippingCarrier, CarrierTrackingAdapter> = new Map();
export function trackingBackoff(failures: number, baseMs=60_000) { return Math.min(6*60*60_000, baseMs*2**Math.min(16,Math.max(0,failures-1))); }

export async function configureTrackingSync(shipmentId: number, adapter: CarrierTrackingAdapter, enabled: boolean) {
  if (enabled && (!adapter.isAvailable() || adapter.mode === "TEST" && process.env.NODE_ENV !== "test")) throw new TrackingProviderError("PERMANENT");
  return prisma.$transaction(async tx => {
    const shipment = await lockTrackingShipment(tx, shipmentId);
    if (enabled && (!shipment.order.dispatchedAt || !["DISPATCHED","COMPLETED","RETURNED"].includes(shipment.order.status))) throw new TrackingProviderError("INVALID_EVIDENCE");
    if (adapter.carrier === "OTHER" || shipment.carrier !== adapter.carrier || !shipment.trackingNumber || !isValidTrackingNumber(adapter.carrier, normalizeTrackingNumber(shipment.trackingNumber))) throw new TrackingProviderError("INVALID_EVIDENCE");
    const existing = await tx.shipmentTrackingSync.findUnique({ where: { shipmentId } });
    if (existing && existing.providerIdentity !== adapter.providerIdentity) throw new TrackingConflictError("Tracking provider identity is immutable");
    // Enabling never resets retry/request counters. Exhaustion requires a separately approved recovery process.
    if (!enabled && existing?.claimOwner) await tx.shipmentTrackingPoll.updateMany({ where: { shipmentId, generation: existing.claimGeneration, completedAt: null }, data: { completedAt: await databaseNow(tx), outcome: "ABORTED" } });
    return tx.shipmentTrackingSync.upsert({ where: { shipmentId }, create: { shipmentId, providerIdentity: adapter.providerIdentity, enabled },
      update: { enabled, ...(!enabled ? { claimOwner: null, leaseExpiresAt: null } : {}), nextPollAt: enabled ? await databaseNow(tx) : undefined } });
  });
}
async function requestWithTimeout(adapter: CarrierTrackingAdapter, request: Parameters<CarrierTrackingAdapter["track"]>[0], timeoutMs: number, signal?: AbortSignal) {
  if (signal?.aborted) throw new TrackingProviderError("ABORTED");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const failure = new Promise<never>((_,reject) => {
    timer=setTimeout(()=>{controller.abort();reject(new TrackingProviderError("TIMEOUT"));},timeoutMs);
    onAbort=()=>{controller.abort();reject(new TrackingProviderError("ABORTED"));};
    signal?.addEventListener("abort",onAbort,{once:true});
    if(signal?.aborted)onAbort();
  });
  try { return await Promise.race([Promise.resolve().then(()=>{if(controller.signal.aborted)throw new TrackingProviderError("ABORTED");return adapter.track(request,controller.signal);}),failure]); }
  finally { if(timer)clearTimeout(timer);if(onAbort)signal?.removeEventListener("abort",onAbort); }
}
export async function runTrackingPoll(options: { adapters?: ReadonlyMap<ShippingCarrier,CarrierTrackingAdapter>; policy?: z.input<typeof PollPolicySchema>; signal?: AbortSignal } = {}) {
  const stats={disabled:!config.CARRIER_TRACKING_POLLING_ENABLED,selected:0,requests:0,successes:0,failures:0,budgetDenied:0,unavailable:0,staleClaims:0,conflicts:0};
  if(stats.disabled)return stats;
  const adapters=options.adapters??realCarrierAdapters;
  if(!adapters.size){stats.unavailable++;return stats;}
  const policy=PollPolicySchema.parse(options.policy??{});
  const deadline=Date.now()+policy.runTimeoutMs;
  const now=await prisma.$transaction(databaseNow);
  const rows=await prisma.shipmentTrackingSync.findMany({where:{enabled:true,OR:[{nextPollAt:null},{nextPollAt:{lte:now}}],
    AND:[{OR:[{leaseExpiresAt:null},{leaseExpiresAt:{lte:now}}]}]},orderBy:[{nextPollAt:{sort:"asc",nulls:"first"}},{shipmentId:"asc"}],take:policy.maxRequests});
  stats.selected=rows.length;
  for(const row of rows){
    if(options.signal?.aborted||Date.now()>=deadline||stats.requests>=policy.maxRequests)break;
    const claim=await prisma.$transaction(async tx=>{
      const shipment=await lockTrackingShipment(tx,row.shipmentId);
      const sync=await tx.shipmentTrackingSync.findUniqueOrThrow({where:{shipmentId:row.shipmentId}});
      const at=await databaseNow(tx);
      if(!sync.enabled||sync.nextPollAt&&sync.nextPollAt>at||sync.leaseExpiresAt&&sync.leaseExpiresAt>at)return null;
      if(sync.claimOwner)await tx.shipmentTrackingPoll.updateMany({where:{shipmentId:row.shipmentId,generation:sync.claimGeneration,completedAt:null},data:{completedAt:at,outcome:"LEASE_EXPIRED"}});
      const state=await tx.shipmentTrackingState.findUnique({where:{shipmentId:row.shipmentId}});
      if(state?.progress==="DELIVERED"||!shipment.order.dispatchedAt||!["DISPATCHED","COMPLETED","RETURNED"].includes(shipment.order.status)){
        await tx.shipmentTrackingSync.update({where:{shipmentId:row.shipmentId},data:{enabled:false,stoppedReason:state?.progress==="DELIVERED"?"DELIVERED":"ORDER_INELIGIBLE",claimOwner:null,leaseExpiresAt:null}});return null;
      }
      if(sync.consecutiveFailures>=policy.maxFailures||sync.totalRequests>=policy.maxLifetimeRequests){
        await tx.shipmentTrackingSync.update({where:{shipmentId:row.shipmentId},data:{enabled:false,stoppedReason:"RETRY_OR_LIFETIME_EXHAUSTED",claimOwner:null,leaseExpiresAt:null}});return null;
      }
      const adapter=shipment.carrier?adapters.get(shipment.carrier):undefined;
      if(!adapter||adapter.carrier!==shipment.carrier||adapter.providerIdentity!==sync.providerIdentity||!adapter.isAvailable()||adapter.mode==="TEST"&&process.env.NODE_ENV!=="test"||!shipment.trackingNumber){
        stats.unavailable++;await tx.shipmentTrackingSync.update({where:{shipmentId:row.shipmentId},data:{nextPollAt:new Date(at.getTime()+policy.successIntervalMs),lastErrorCode:"NO_ADAPTER_OR_CREDENTIALS",claimOwner:null,leaseExpiresAt:null}});return null;
      }
      const charged = await chargeTrackingBudget(tx, {carrier:adapter.carrier,providerIdentity:adapter.providerIdentity}, policy);
      if(charged.denied){
        stats.budgetDenied++;await tx.shipmentTrackingSync.update({where:{shipmentId:row.shipmentId},data:{nextPollAt:charged.nextPollAt,lastErrorCode:"REQUEST_BUDGET_EXHAUSTED",claimOwner:null,leaseExpiresAt:null}});return null;
      }
      // A crashed request consumes budget. Lease/journal timestamps also follow the budget lock wait.
      const claimedAt = charged.at;
      const owner=randomUUID(),generation=sync.claimGeneration+1;
      await tx.shipmentTrackingSync.update({where:{shipmentId:row.shipmentId},data:{claimOwner:owner,claimGeneration:generation,leaseExpiresAt:new Date(claimedAt.getTime()+30_000+2*policy.timeoutMs),totalRequests:{increment:1},lastPollAt:claimedAt}});
      const poll=await tx.shipmentTrackingPoll.create({data:{shipmentId:row.shipmentId,providerIdentity:adapter.providerIdentity,generation,startedAt:claimedAt,outcome:"PENDING"}});
      return {adapter,owner,generation,pollId:poll.id,request:{shipmentId:shipment.id,carrier:adapter.carrier,trackingNumber:normalizeTrackingNumber(shipment.trackingNumber)}};
    });
    if(!claim)continue;
    stats.requests++;
    let errorCode:string|null=null;
    try{
      const observation=TrackingObservationSchema.parse(await requestWithTimeout(claim.adapter,claim.request,Math.max(1,Math.min(policy.timeoutMs,deadline-Date.now())),options.signal));
      if(observation.trackingNumber!==claim.request.trackingNumber||observation.providerIdentity!==claim.adapter.providerIdentity||observation.carrier!==claim.adapter.carrier
        ||claim.adapter.mode==="TEST"&&observation.source!=="TEST_FIXTURE"||claim.adapter.mode==="REAL"&&observation.source!=="AUTHENTICATED_API"||!observation.verified)throw new TrackingProviderError("INVALID_EVIDENCE");
      const applied=await prisma.$transaction(async tx=>{
        await lockTrackingShipment(tx,claim.request.shipmentId);
        const sync=await tx.shipmentTrackingSync.findUniqueOrThrow({where:{shipmentId:claim.request.shipmentId}});const at=await databaseNow(tx);
        if(!sync.enabled||sync.claimOwner!==claim.owner||sync.claimGeneration!==claim.generation||!sync.leaseExpiresAt||sync.leaseExpiresAt<=at){
          await tx.shipmentTrackingPoll.updateMany({where:{id:claim.pollId,completedAt:null},data:{completedAt:at,outcome:"STALE_CLAIM"}});
          if(sync.claimOwner===claim.owner&&sync.claimGeneration===claim.generation)await tx.shipmentTrackingSync.update({where:{shipmentId:claim.request.shipmentId},data:{claimOwner:null,leaseExpiresAt:null,nextPollAt:new Date(at.getTime()+policy.baseBackoffMs)}});
          return false;
        }
        const result = await ingestTrackingObservationInTransaction(tx,claim.request.shipmentId,observation);
        const state=await tx.shipmentTrackingState.findUnique({where:{shipmentId:claim.request.shipmentId}});
        await tx.shipmentTrackingSync.update({where:{shipmentId:claim.request.shipmentId},data:{claimOwner:null,leaseExpiresAt:null,consecutiveFailures:0,lastSuccessAt:at,lastErrorCode:result.conflicts?"EVIDENCE_CONFLICT":null,
          enabled:state?.progress!=="DELIVERED",stoppedReason:state?.progress==="DELIVERED"?"DELIVERED":null,nextPollAt:new Date(at.getTime()+policy.successIntervalMs)}});
        await tx.shipmentTrackingPoll.update({where:{id:claim.pollId},data:{completedAt:at,outcome:result.conflicts?"PARTIAL_SUCCESS":"SUCCESS"}});return result;
      });
      if(applied){stats.successes++;stats.conflicts+=applied.conflicts;}else stats.staleClaims++;
    }catch(error){if(error instanceof TrackingConflictError)await persistTrackingConflict(error);errorCode=error instanceof TrackingProviderError?error.code:error instanceof TrackingConflictError||error instanceof ZodError?"INVALID_EVIDENCE":"TEMPORARY";}
    if(errorCode){
      stats.failures++;
      await prisma.$transaction(async tx=>{
        await lockTrackingShipment(tx,claim.request.shipmentId);const sync=await tx.shipmentTrackingSync.findUniqueOrThrow({where:{shipmentId:claim.request.shipmentId}});const at=await databaseNow(tx);
        if(sync.claimOwner!==claim.owner||sync.claimGeneration!==claim.generation)return;
        const failures=sync.consecutiveFailures+1;
        const stop=errorCode==="PERMANENT"||errorCode==="INVALID_EVIDENCE"||failures>=policy.maxFailures||sync.totalRequests>=policy.maxLifetimeRequests;
        await tx.shipmentTrackingSync.update({where:{shipmentId:claim.request.shipmentId},data:{enabled:sync.enabled&&!stop,claimOwner:null,leaseExpiresAt:null,consecutiveFailures:failures,
          lastErrorCode:errorCode,stoppedReason:stop?errorCode:null,nextPollAt:new Date(at.getTime()+trackingBackoff(failures,policy.baseBackoffMs))}});
        await tx.shipmentTrackingPoll.update({where:{id:claim.pollId},data:{completedAt:at,outcome:errorCode!}});
      });
    }
  }
  return stats;
}
