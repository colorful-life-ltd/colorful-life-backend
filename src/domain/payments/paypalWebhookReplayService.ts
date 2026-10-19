import {logOperationalError} from "../../utils/operationalLog.js";
import { prisma } from "../../prisma/runtime.js";
import { PaymentProvider } from "../../generated/prisma-client/enums.js";
import type { Prisma } from "../../generated/prisma-client/client.js";
import { processPayPalWebhookReceipt } from "./paypalReconciliationService.js";

type ReplayOptions = { paypalOrderId?: string; pageSize?: number };

/** One finite sweep with bounded pages. No lease/claim can strand work on a crash. */
export async function replayPendingPayPalWebhooks({ paypalOrderId, pageSize = 100 }: ReplayOptions = {}) {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new Error("Invalid PayPal replay page size");
  const where: Prisma.PaymentWebhookEventWhereInput = {
    provider: PaymentProvider.PAYPAL, processedAt: null,
    ...(paypalOrderId ? { evidence: { path: ["paypalOrderId"], equals: paypalOrderId } } : {}),
  };
  const last = await prisma.paymentWebhookEvent.findFirst({ where, orderBy: { id: "desc" }, select: { id: true } });
  const result = { scanned: 0, processed: 0, pending: 0, failed: 0 };
  if (!last) return result;
  let cursor = 0;
  while (true) {
    const receipts = await prisma.paymentWebhookEvent.findMany({
      where: { ...where, id: { gt: cursor, lte: last.id } }, orderBy: { id: "asc" }, take: pageSize, select: { id: true },
    });
    if (!receipts.length) return result;
    cursor = receipts[receipts.length - 1].id;
    for (const receipt of receipts) {
      result.scanned++;
      try {
        const outcome = await processPayPalWebhookReceipt(receipt.id);
        if (outcome.processed) result.processed++; else result.pending++;
      } catch {
        // Transaction rollback leaves processedAt null and evidence intact.
        // Never log provider payloads, credentials or raw database exceptions.
        result.failed++;
        logOperationalError("PayPal webhook replay failed; pending receipt retained");
      }
    }
  }
}

/** Scheduling only. Each ECS instance can run this; PostgreSQL provides correctness. */
export function startPayPalWebhookReplayWorker(intervalMs = 5_000) {
  let running = false, stopped=false;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try { await replayPendingPayPalWebhooks(); }
    catch { logOperationalError("PayPal webhook replay sweep failed; will retry"); }
    finally { running = false; }
  };
  let pending:Promise<void>=Promise.resolve();
  const launch=()=>{if(!running&&!stopped)pending=tick();};
  const timer = setInterval(launch, intervalMs);
  timer.unref();
  launch();
  return async () => { stopped=true; clearInterval(timer); await pending; };
}
