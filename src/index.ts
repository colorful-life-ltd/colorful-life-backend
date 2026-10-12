import { startCartReconciliationWorker } from "./domain/cart/cartProvenanceService.js";
import { startPayPalWebhookReplayWorker } from "./domain/payments/paypalWebhookReplayService.js";
import app from "./app.js";
import { config } from "./config/index.js";

const PORT = config.PORT;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

startCartReconciliationWorker();
startPayPalWebhookReplayWorker();
