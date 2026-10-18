import { assertEmailStartupReady } from './domain/orderConfirmation/readiness.js';
import { startOrderConfirmationWorker } from './domain/orderConfirmation/worker.js';
import { startPaymentResolutionWorker } from './domain/payments/stripeResolutionService.js';
import { startCartReconciliationWorker } from './domain/cart/cartProvenanceService.js';
import { startPayPalWebhookReplayWorker } from './domain/payments/paypalWebhookReplayService.js';
import { prisma } from './prisma/runtime.js';
import app from './app.js';
import { config } from './config/index.js';
await assertEmailStartupReady();
// A missing financial review schema is fatal; providers remaining unavailable are not.
await prisma.$queryRaw`SELECT r."reviewRevision",a.id FROM "Refund" r LEFT JOIN "OperationalAudit" a ON false LIMIT 0`;
const [schema]=await prisma.$queryRaw<Array<{ready:boolean}>>`SELECT to_regclass('"FbaOutbound_shipment_listing_key"') IS NOT NULL
 AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='"Refund"'::regclass AND tgname='refund_review_revision' AND tgenabled IN ('O','A')) AS ready`;
if(!schema?.ready)throw new Error('Financial review schema not ready; migrate before starting');
const server=app.listen(config.PORT,()=>console.log(`Server listening on port ${config.PORT}`));
const stops:Array<()=>void|Promise<void>>=config.BACKGROUND_WORKERS_ENABLED ? [
  startCartReconciliationWorker(),startPayPalWebhookReplayWorker(),startPaymentResolutionWorker(),startOrderConfirmationWorker(),
]:[];
let stopping=false;
async function shutdown(){
  if(stopping)return;stopping=true;
  const deadline=setTimeout(()=>{console.error('Shutdown drain deadline exceeded');process.exit(1);},25000);deadline.unref();
  await Promise.all([new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve())),...stops.map(stop=>Promise.resolve(stop()))]);
  await prisma.$disconnect();clearTimeout(deadline);
}
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{void shutdown().catch(()=>{console.error('Shutdown failed');process.exitCode=1;});});
