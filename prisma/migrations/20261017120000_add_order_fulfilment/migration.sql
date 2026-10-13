-- Order fulfilment, Phase 1 (Issue #165 / #161): Confirmed -> Preparing -> Dispatched.
-- Additive only. Existing orders keep their status; preparingAt starts NULL, so no
-- historical order is marked Preparing, Dispatched or Delivered. No Shipment or audit
-- rows are backfilled: legacy dispatches stay readable from Order.shippingCarrier,
-- trackingNumber and dispatchedAt.

-- CreateEnum
CREATE TYPE "ShippingCarrier" AS ENUM ('ROYAL_MAIL', 'EVRI', 'DPD', 'OTHER');

-- CreateEnum
CREATE TYPE "FulfilmentStage" AS ENUM ('CONFIRMED', 'PREPARING', 'DISPATCHED');

-- CreateEnum
CREATE TYPE "FulfilmentEventAction" AS ENUM ('PREPARING_STARTED', 'DISPATCHED');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "preparingAt" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "Shipment" (
    "id" SERIAL NOT NULL,
    "orderId" INTEGER NOT NULL,
    "sequence" INTEGER NOT NULL DEFAULT 1,
    "carrier" "ShippingCarrier",
    "carrierName" VARCHAR(100) NOT NULL,
    "trackingNumber" VARCHAR(100),
    "dispatchedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdByUserId" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Shipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderFulfilmentEvent" (
    "id" SERIAL NOT NULL,
    "orderId" INTEGER NOT NULL,
    "action" "FulfilmentEventAction" NOT NULL,
    "fromStage" "FulfilmentStage" NOT NULL,
    "toStage" "FulfilmentStage" NOT NULL,
    "shipmentId" INTEGER,
    "performedByUserId" INTEGER NOT NULL,
    "source" VARCHAR(40) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderFulfilmentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Shipment_createdByUserId_idx" ON "Shipment"("createdByUserId");

-- CreateIndex
CREATE UNIQUE INDEX "Shipment_orderId_sequence_key" ON "Shipment"("orderId", "sequence");

-- CreateIndex
CREATE INDEX "OrderFulfilmentEvent_orderId_id_idx" ON "OrderFulfilmentEvent"("orderId", "id");

-- CreateIndex
CREATE INDEX "OrderFulfilmentEvent_performedByUserId_idx" ON "OrderFulfilmentEvent"("performedByUserId");

-- CreateIndex
CREATE INDEX "OrderFulfilmentEvent_shipmentId_idx" ON "OrderFulfilmentEvent"("shipmentId");

-- AddForeignKey
ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderFulfilmentEvent" ADD CONSTRAINT "OrderFulfilmentEvent_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderFulfilmentEvent" ADD CONSTRAINT "OrderFulfilmentEvent_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "Shipment"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderFulfilmentEvent" ADD CONSTRAINT "OrderFulfilmentEvent_performedByUserId_fkey" FOREIGN KEY ("performedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Phase 1 creates only sequence 1; parcels are numbered from 1.
ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_sequence_check" CHECK ("sequence" >= 1);
