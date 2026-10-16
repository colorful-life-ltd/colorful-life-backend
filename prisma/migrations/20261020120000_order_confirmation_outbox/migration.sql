BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "Order" ADD COLUMN "confirmationDeliverySnapshot" JSONB;
ALTER TABLE "OrderItem" ADD COLUMN "invoiceDescriptionSnapshot" TEXT, ADD COLUMN "invoiceSetNumberSnapshot" TEXT;
CREATE TABLE "OrderConfirmationJob" (
 "id" TEXT PRIMARY KEY, "orderId" INTEGER NOT NULL UNIQUE REFERENCES "Order"(id) ON DELETE CASCADE,
 "source" JSONB NOT NULL, "state" TEXT NOT NULL DEFAULT 'PENDING', "attempts" INTEGER NOT NULL DEFAULT 0,
 "nextAttemptAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "claimOwner" TEXT, "claimGeneration" INTEGER NOT NULL DEFAULT 0, "leaseExpiresAt" TIMESTAMPTZ(3), "sendStartedAt" TIMESTAMPTZ(3),
 "lastErrorCode" TEXT, "providerMessageId" TEXT, "sentAt" TIMESTAMPTZ(3),
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMPTZ(3) NOT NULL,
 CHECK ("state" IN ('PENDING','PROCESSING','RETRY','BLOCKED','UNKNOWN','SENT','FAILED','SUPPRESSED')),
 CHECK ("attempts">=0 AND "claimGeneration">=0)
);
CREATE INDEX "OrderConfirmationJob_state_nextAttemptAt_idx" ON "OrderConfirmationJob"("state","nextAttemptAt");
CREATE SEQUENCE "commercial_invoice_number_seq";
CREATE TABLE "CommercialInvoice" (
 "id" SERIAL PRIMARY KEY, "orderId" INTEGER NOT NULL UNIQUE REFERENCES "Order"(id) ON DELETE RESTRICT,
 "invoiceNumber" TEXT NOT NULL UNIQUE, "snapshot" JSONB NOT NULL, "pdfBytes" BYTEA, "pdfSha256" TEXT,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK (((snapshot->>'invoiceNumber'="invoiceNumber") AND (snapshot->'purchase'->>'orderId'="orderId"::text) AND snapshot->>'version'='1') IS TRUE),
 CHECK (("pdfBytes" IS NULL AND "pdfSha256" IS NULL) OR
   ("pdfBytes" IS NOT NULL AND "pdfSha256" IS NOT NULL AND octet_length("pdfBytes") BETWEEN 5 AND 3000000 AND "pdfSha256" ~ '^[0-9a-f]{64}$'))
);
CREATE FUNCTION confirmation_source_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.id IS DISTINCT FROM OLD.id OR NEW."orderId" IS DISTINCT FROM OLD."orderId"
    OR NEW.source IS DISTINCT FROM OLD.source OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
  RAISE EXCEPTION 'Confirmation source is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER confirmation_source_immutable BEFORE UPDATE ON "OrderConfirmationJob" FOR EACH ROW EXECUTE FUNCTION confirmation_source_immutable();
CREATE FUNCTION commercial_invoice_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Invoice retention requires a separately approved procedure' USING ERRCODE='23514'; END IF;
 IF (to_jsonb(NEW)-ARRAY['pdfBytes','pdfSha256']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['pdfBytes','pdfSha256'])
    OR (OLD."pdfBytes" IS NOT NULL AND (NEW."pdfBytes" IS DISTINCT FROM OLD."pdfBytes" OR NEW."pdfSha256" IS DISTINCT FROM OLD."pdfSha256")) THEN
  RAISE EXCEPTION 'Commercial invoice is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER commercial_invoice_immutable BEFORE UPDATE OR DELETE ON "CommercialInvoice" FOR EACH ROW EXECUTE FUNCTION commercial_invoice_immutable();
COMMIT;
