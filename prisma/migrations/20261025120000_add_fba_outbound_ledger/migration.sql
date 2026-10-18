-- Additive ledger only. Do not backfill or alter historical inventory movements.
CREATE TABLE "FbaOutbound" (
  "id" SERIAL NOT NULL,
  "movementId" INTEGER NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "requestHash" VARCHAR(64) NOT NULL,
  "shipmentReference" VARCHAR(200) NOT NULL,
  "currentStockAfter" INTEGER NOT NULL,
  "reservedStockAfter" INTEGER NOT NULL,
  CONSTRAINT "FbaOutbound_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FbaOutbound_stock_check" CHECK ("reservedStockAfter" >= 0 AND "currentStockAfter" >= "reservedStockAfter"),
  CONSTRAINT "FbaOutbound_reference_check" CHECK (length(btrim("shipmentReference")) > 0),
  CONSTRAINT "FbaOutbound_key_check" CHECK (length("idempotencyKey") > 0)
);
CREATE UNIQUE INDEX "FbaOutbound_movementId_key" ON "FbaOutbound"("movementId");
CREATE UNIQUE INDEX "FbaOutbound_idempotencyKey_key" ON "FbaOutbound"("idempotencyKey");
CREATE INDEX "FbaOutbound_shipmentReference_idx" ON "FbaOutbound"("shipmentReference");
ALTER TABLE "FbaOutbound" ADD CONSTRAINT "FbaOutbound_movementId_fkey"
  FOREIGN KEY ("movementId") REFERENCES "InventoryMovement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
