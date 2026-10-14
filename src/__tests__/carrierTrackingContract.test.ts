import assert from "node:assert/strict";
import { it } from "node:test";
import { exceedsTrackingClockSkew, CanonicalTrackingEventSchema, TrackingObservationSchema, derivedProviderEventId, normalizeProviderStatus } from "../domain/tracking/trackingContract.js";
import { PollPolicySchema, trackingBackoff, realCarrierAdapters } from "../domain/tracking/trackingPoller.js";
import { config } from "../config/index.js";
it("canonical normalization uses only reviewed mappings and preserves unknown codes",()=>{
 const mapping=new Map([["TEST_MOVE","IN_TRANSIT" as const],["TEST_DELIVERED","DELIVERED" as const]]);
 assert.equal(normalizeProviderStatus("TEST_MOVE",mapping),"IN_TRANSIT");assert.equal(normalizeProviderStatus("ACTUAL_UNDOCUMENTED_STATUS",mapping),"UNKNOWN");
});
it("derived event identifiers are stable and distinguish immutable fields",()=>{
 assert.equal(derivedProviderEventId(["a","b"]),derivedProviderEventId(["a","b"]));assert.notEqual(derivedProviderEventId(["a","b"]),derivedProviderEventId(["ab"]));
});
it("canonical validation bounds input and rejects invalid timestamps, secret fields and contradictory exceptions",()=>{
 const event={providerEventId:"event",providerStatus:"TEST_MOVE",occurredAt:new Date(),status:"IN_TRANSIT"};
 assert.ok(CanonicalTrackingEventSchema.safeParse(event).success);
 for(const patch of [{occurredAt:new Date(NaN)},{secret:"token"},{providerEventId:"a".repeat(129)},{exception:"DELAY"},{status:"EXCEPTION"},{providerEventId:"   "},{evidenceReference:"   "}])assert.equal(CanonicalTrackingEventSchema.safeParse({...event,...patch}).success,false);
 const observation={carrier:"ROYAL_MAIL",providerIdentity:"fake",trackingNumber:"ab 123 456 789 gb",source:"TEST_FIXTURE",verified:true,events:[event]};
 assert.equal(TrackingObservationSchema.parse(observation).trackingNumber,"AB123456789GB");assert.equal(TrackingObservationSchema.safeParse({...observation,events:Array(101).fill(event)}).success,false);
});
it("policy bounds retries, run budgets, timeout and backoff",()=>{
 assert.equal(trackingBackoff(1),60_000);assert.equal(trackingBackoff(2),120_000);assert.equal(trackingBackoff(100),6*60*60_000);
 for(const policy of [{maxRequests:26},{maxFailures:9},{perDay:1001},{timeoutMs:10001},{runTimeoutMs:120001},{maxLifetimeRequests:201}])assert.equal(PollPolicySchema.safeParse(policy).success,false);
});
it("polling and the real adapter registry are disabled by default",()=>{
 assert.equal(config.CARRIER_TRACKING_POLLING_ENABLED,false);assert.equal(realCarrierAdapters.size,0);
});

it("clock-skew tolerance has an exact five-second boundary",()=>{
 const at=new Date("2040-01-01T00:00:00Z");
 assert.equal(exceedsTrackingClockSkew(new Date(at.getTime()+5000),at),false);
 assert.equal(exceedsTrackingClockSkew(new Date(at.getTime()+5001),at),true);
});
