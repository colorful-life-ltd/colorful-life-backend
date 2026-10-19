BEGIN;
SET LOCAL lock_timeout='5s';
CREATE INDEX "OperationalAudit_order_kind_id_idx" ON "OperationalAudit"("orderId",kind,id);
CREATE INDEX "FbaOutbound_listing_shortfall_id_idx" ON "FbaOutbound"("productListingId",shortfall,id);
COMMIT;
