import { assertEmailStartupReady } from "./domain/orderConfirmation/readiness.js";
import { startOrderConfirmationWorker } from "./domain/orderConfirmation/worker.js";
import { startPaymentResolutionWorker } from "./domain/payments/stripeResolutionService.js";
import { startCartReconciliationWorker } from "./domain/cart/cartProvenanceService.js";
import { startPayPalWebhookReplayWorker } from "./domain/payments/paypalWebhookReplayService.js";
import app from "./app.js";
import { config } from "./config/index.js";

await assertEmailStartupReady();

const PORT = config.PORT;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

startCartReconciliationWorker();
startPayPalWebhookReplayWorker();

startPaymentResolutionWorker();

startOrderConfirmationWorker();
