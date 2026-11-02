CREATE TABLE "RetiredRefundRequestKey" (
    "clientRequestKey" VARCHAR(128) NOT NULL,
    "orderId" INTEGER NOT NULL,
    "paymentId" INTEGER NOT NULL,
    "retiredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RetiredRefundRequestKey_pkey" PRIMARY KEY ("clientRequestKey")
);

CREATE INDEX "RetiredRefundRequestKey_paymentId_retiredAt_idx"
    ON "RetiredRefundRequestKey"("paymentId", "retiredAt");
