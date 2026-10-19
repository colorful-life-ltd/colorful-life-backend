ALTER TABLE "LegoProduct" ADD COLUMN "everPublished" BOOLEAN NOT NULL DEFAULT false,
 ADD COLUMN "availabilityState" TEXT NOT NULL DEFAULT 'STANDARD';
-- Prior order history proves a public identity even if already unpublished.
UPDATE "LegoProduct" p SET "everPublished"=true WHERE p."isPublished"=true
 OR EXISTS(SELECT 1 FROM "ProductListing" l JOIN "OrderItem" i ON i."productListingId"=l.id WHERE l."legoProductId"=p.id);
ALTER TABLE "LegoProduct" ADD CONSTRAINT "LegoProduct_availabilityState_check"
 CHECK ("availabilityState" IN ('STANDARD','MORE_ON_THE_WAY','DISCONTINUED'));
CREATE FUNCTION retain_product_publication() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 NEW."everPublished" := NEW."everPublished" OR NEW."isPublished";
 IF TG_OP='UPDATE' THEN NEW."everPublished" := NEW."everPublished" OR OLD."everPublished"; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER retain_product_publication BEFORE INSERT OR UPDATE ON "LegoProduct"
 FOR EACH ROW EXECUTE FUNCTION retain_product_publication();
