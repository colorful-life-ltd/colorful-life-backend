import type { Prisma } from "../../generated/prisma-client/client.js";
import type { ShippingCarrier } from "../../generated/prisma-client/enums.js";
import { databaseNow } from "../payments/paymentResolutionService.js";

/** Caller holds Order -> Shipment. Clock dependency is internal and allows deterministic boundary tests. */
export async function chargeTrackingBudget(tx: Prisma.TransactionClient,
  key: { carrier: ShippingCarrier; providerIdentity: string }, limits: { perMinute: number; perDay: number },
  clock: typeof databaseNow = databaseNow) {
  if (clock !== databaseNow && process.env.NODE_ENV !== "test") throw new Error("Budget clock overrides are test-only");
  await tx.$executeRaw`INSERT INTO "TrackingCarrierBudget" (carrier,"providerIdentity","minuteStartedAt","dayStartedAt")
    VALUES (${key.carrier}::"ShippingCarrier",${key.providerIdentity},date_trunc('minute',clock_timestamp()),date_trunc('day',clock_timestamp()))
    ON CONFLICT (carrier,"providerIdentity") DO NOTHING`;
  await tx.$queryRaw`SELECT carrier FROM "TrackingCarrierBudget" WHERE carrier=${key.carrier}::"ShippingCarrier"
    AND "providerIdentity"=${key.providerIdentity} FOR UPDATE`;
  // Authoritative time MUST be obtained after the possibly blocking insert/row lock.
  const at = await clock(tx);
  const budget = await tx.trackingCarrierBudget.findUniqueOrThrow({ where: { carrier_providerIdentity: key } });
  // Clock corrections must never reopen an earlier bucket or overwrite a newer committed bucket.
  const minute = new Date(Math.max(budget.minuteStartedAt.getTime(), Math.floor(at.getTime()/60_000)*60_000));
  const day = new Date(Math.max(budget.dayStartedAt.getTime(), Math.floor(at.getTime()/86_400_000)*86_400_000));
  const minuteRequests = budget.minuteStartedAt.getTime() === minute.getTime() ? budget.minuteRequests : 0;
  const dayRequests = budget.dayStartedAt.getTime() === day.getTime() ? budget.dayRequests : 0;
  const denied = minuteRequests >= limits.perMinute || dayRequests >= limits.perDay;
  if (!denied) await tx.trackingCarrierBudget.update({ where: { carrier_providerIdentity: key }, data: {
    minuteStartedAt: minute, minuteRequests: minuteRequests+1, dayStartedAt: day, dayRequests: dayRequests+1 } });
  return { at, denied, nextPollAt: new Date(dayRequests >= limits.perDay ? day.getTime()+86_400_000 : minute.getTime()+60_000) };
}
