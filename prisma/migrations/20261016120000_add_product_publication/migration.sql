-- Product publication (Issue #163). Publication is product-level and independent
-- of stock: published products stay publicly discoverable when sold out.

-- Legacy rows start unpublished; nothing becomes public merely by migrating.
ALTER TABLE "LegoProduct" ADD COLUMN "isPublished" BOOLEAN NOT NULL DEFAULT false;

-- Compatibility policy (owner-confirmed storefront policy: published products stay
-- visible regardless of stock). Publish a legacy product when at least one ACTIVE
-- offer shows public intent:
--   * it is purchasable now (active, purchasable condition, physical stock), or
--   * it has stock or sales history (any InventoryMovement or OrderItem), i.e. a
--     product that was on sale and has since sold out.
-- Reservations are transient checkout holds, so they are ignored.
-- Stay private: products with no offers and products whose offers never held stock
-- (drafts), and products whose offers are all deactivated (private).
UPDATE "LegoProduct" lp
SET "isPublished" = TRUE
WHERE EXISTS (
  SELECT 1 FROM "ProductListing" pl
  WHERE pl."legoProductId" = lp."id"
    AND pl."active" = TRUE
    AND (
      (pl."currentStock" > 0
        AND (pl."condition" = 'NEW' OR (pl."condition" = 'USED_LIKE_NEW' AND pl."usedLifecycle" = 'AVAILABLE')))
      OR EXISTS (SELECT 1 FROM "InventoryMovement" im WHERE im."listingId" = pl."id")
      OR EXISTS (SELECT 1 FROM "OrderItem" oi WHERE oi."productListingId" = pl."id")
    )
);

-- Products created from now on are published unless explicitly created unpublished.
ALTER TABLE "LegoProduct" ALTER COLUMN "isPublished" SET DEFAULT true;

CREATE INDEX "LegoProduct_isPublished_id_idx" ON "LegoProduct"("isPublished", "id");
