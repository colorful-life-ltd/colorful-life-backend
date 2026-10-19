import {logOperationalError} from "../utils/operationalLog.js";
import { positivePriceSchema, salePriceSchema } from "../domain/products/listingPrice.js";
import { Request, Response } from "express";
import { Prisma } from "../generated/prisma-client/client.js";
import { ListingCondition, InventoryMovementType } from "../generated/prisma-client/enums.js";
import { prisma } from "../prisma/runtime.js";
import { z } from "zod";
import { ProductCatalogueQuerySchema } from "../domain/products/productCatalogueValidator.js";
import { getCatalogueProductById, listCatalogueProducts } from "../domain/products/productCatalogueService.js";
import { createProductFeatureService, FeatureProductNotFoundError, FeatureProductCategoryChangedError } from "../domain/products/productFeatureService.js";
import { createProductListingCreationService } from "../domain/products/productListingCreationService.js";
import { productMetadataUpdateFields } from "../domain/products/productMetadataUpdateValidator.js";

const categorySelect = { id: true, name: true, subtitle: true, description: true, imageUrl: true, thumbnailUrl: true } as const;

function serializeListing<T extends { legoProduct: { category?: unknown } }>(listing: T) {
  const { category, ...legoProduct } = listing.legoProduct;
  return { ...listing, category: category ?? null, legoProduct };
}

/**
 * GET /products
 * Returns all active product listings with related LegoProduct and ordered listing images.
 */
export const getProducts = async (req: Request, res: Response) => {
  const parseResult = ProductCatalogueQuerySchema.safeParse(req.query);
  if (!parseResult.success) {
    return res.status(400).json({ error: parseResult.error.format() });
  }
  try {
    res.json(await listCatalogueProducts(parseResult.data));
  } catch (err) {
    logOperationalError("Get products error", err);
    res.status(500).json({ error: "Internal server error" });
  }
};

/** Product-level catalogue detail with all currently stocked offers. */
export const getCatalogueProduct = async (req: Request, res: Response) => {
  const id = Number(req.params.productId);
  if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ error: "Product not found" });
  try {
    const product = await getCatalogueProductById(id);
    if (!product) return res.status(404).json({ error: "Product not found" });
    return res.json(product);
  } catch (error) {
    logOperationalError("Get catalogue product error", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};
/**
 * POST /products
 * Creates a new Lego product and its product listing in a single atomic transaction.
 * The request body must contain all required fields; numeric values are expected as JSON numbers.
 *
 * @body
 *   - setNumber: string
 *   - title: string
 *   - description?: string
 *   - theme: string
 *   - categoryId: existing Category ID
 *   - ageRecommendation: string
 *   - pieceCount: number
 *   - isRetired?: boolean (manually managed shared product metadata)
 *   - isPublished?: boolean (public catalogue visibility; defaults to true)
 *   - condition: "NEW" | "USED_LIKE_NEW"
 *   - originalPrice: number
 *   - salePrice?: number
 *   - currentStock?: number
 */
export const createProduct = async (req: Request, res: Response) => {
  const schema = z.object({
    setNumber: z.string().nonempty({ message: "setNumber is required" }),
    title: z.string().nonempty({ message: "title is required" }),
    description: z.string().optional(),
    theme: z.string().nonempty({ message: "theme is required" }),
    categoryId: z.number().int().positive(),
    ageRecommendation: z.string().nonempty({ message: "ageRecommendation is required" }),
    pieceCount: z.number().int().positive({ message: "pieceCount must be a positive integer" }),
    isRetired: z.boolean().optional(),
    isPublished: z.boolean().optional(),
    condition: z.nativeEnum(ListingCondition),
    originalPrice: positivePriceSchema,
    salePrice: salePriceSchema,
    currentStock: z.number().int().nonnegative().optional(),
  });

  const parseResult = schema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ error: parseResult.error.format() });
  }
  if (parseResult.data.condition === ListingCondition.USED_LIKE_NEW) {
    return res.status(400).json({ error: "Used offers must be created through the per-item Used offer operation" });
  }
  const {
    setNumber,
    title,
    description,
    theme,
    categoryId,
    ageRecommendation,
    pieceCount,
    isRetired,
    isPublished,
    condition,
    originalPrice,
    salePrice,
    currentStock,
  } = parseResult.data;

  try {
    const category = await prisma.category.findUnique({ where: { id: categoryId }, select: { id: true } });
    if (!category) return res.status(400).json({ error: "Category not found" });

    // Serialize first-feature selection and create the product/listing atomically.
    const listing = await createProductListingCreationService().createForCategory(category.id, (tx, isFeatureProduct) =>
      tx.productListing.create({
        data: {
          condition,
          originalPrice,
          salePrice,
          currentStock: currentStock ?? 0,
          legoProduct: {
            create: {
              category: { connect: { id: category.id } },
              setNumber,
              title,
              description,
              theme,
              ageRecommendation,
              pieceCount,
              isRetired,
              isPublished,
              isFeatureProduct,
            },
          },
        },
      }),
    );

    const result = await prisma.productListing.findUnique({
      where: { id: listing.id },
      select: {
        id: true,
        legoProductId: true,
        condition: true,
        originalPrice: true,
        salePrice: true,
        currentStock: true,
        createdAt: true,
        updatedAt: true,
        legoProduct: { include: {
          category: { select: categorySelect },
          productImages: {
            select: { id: true, url: true, publicId: true, altText: true, sortOrder: true },
            orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
          },
        } },
      },
    });
    if (!result) return res.status(500).json({ error: "Failed to retrieve created listing" });
    res.status(201).json(serializeListing(result));
  } catch (err) {
    logOperationalError("Create product error", err);
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return res.status(409).json({ error: "setNumber already exists" });
    }
    res.status(500).json({ error: "Internal server error" });
  }
};

/**
 * PATCH /products/:id
 * Partially updates a product listing and its associated LegoProduct.
 * Supports updates to the following fields:
 *   - LegoProduct: setNumber, title, description, theme, ageRecommendation, pieceCount, isRetired
 *   - ProductListing: condition, originalPrice, salePrice
 * Non‑updatable fields (IDs, timestamps, active flag, etc.) are ignored.
 */
export const updateProduct = async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(404).json({ error: "Listing not found" });
  }

  if (typeof req.body === "object" && req.body !== null && "currentStock" in req.body) {
    return res.status(400).json({ error: "currentStock must be changed through an inventory operation" });
  }

  // Define partial schema for validation
  const updateSchema = z
    .object({
      ...productMetadataUpdateFields,
      condition: z.nativeEnum(ListingCondition),
      originalPrice: positivePriceSchema,
      salePrice: salePriceSchema,
    })
    // Category and publication are product-level: PATCH /admin/products/:productId.
    .omit({ categoryId: true, isPublished: true, availabilityState: true, availabilityReason: true, permanentDiscontinuationConfirmed: true, restockExpectationConfirmed: true, discontinuationReversalConfirmed: true })
    .partial();

  const parseResult = updateSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ error: parseResult.error.format() });
  }

  const body = parseResult.data;
  if (Object.keys(body).length === 0) {
    return res.status(400).json({ error: "No updatable fields provided" });
  }

  const listingData: any = {};
  const legoUpdate: any = {};

  // Map ProductListing fields
  if (body.condition !== undefined) listingData.condition = body.condition;
  if (body.originalPrice !== undefined) listingData.originalPrice = body.originalPrice;
  if (body.salePrice !== undefined) listingData.salePrice = body.salePrice;

  // Map LegoProduct fields
  const legoFields = [
    "setNumber",
    "title",
    "description",
    "theme",
    "ageRecommendation",
    "pieceCount",
    "isRetired",
  ] as const;
  legoFields.forEach((field) => {
    if (body[field] !== undefined) {
      legoUpdate[field] = body[field];
    }
  });
  if (Object.keys(legoUpdate).length > 0) {
    listingData.legoProduct = { update: legoUpdate };
  }

  try {
    // Verify existence
    const existing = await prisma.productListing.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ error: "Listing not found" });
    }
    if (body.condition !== undefined && body.condition !== existing.condition) {
      return res.status(400).json({ error: "Listing condition cannot be changed through generic product editing" });
    }
    // Perform atomic nested update
    await prisma.productListing.update({ where: { id }, data: listingData });
    // Return the updated listing
    const updated = await prisma.productListing.findUnique({
      where: { id },
      select: {
        id: true,
        legoProductId: true,
        condition: true,
        originalPrice: true,
        salePrice: true,
        currentStock: true,
        createdAt: true,
        updatedAt: true,
        legoProduct: { include: {
          category: { select: categorySelect },
          productImages: {
            select: { id: true, url: true, publicId: true, altText: true, sortOrder: true },
            orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
          },
        } },
      },
    });
    if (!updated) {
      return res.status(500).json({ error: "Failed to retrieve updated listing" });
    }
    res.json(serializeListing(updated));
  } catch (err) {
    logOperationalError("Update product error", err);
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return res.status(409).json({ error: "setNumber already exists" });
    }
    res.status(500).json({ error: "Internal server error" });
  }
};

/**
 * GET /products/:id
 * Returns a single active product listing by numeric listing ID.
 * Returns 404 if not found, inactive, or its product is unpublished.
 */
export const getProductById = async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(404).json({ error: "Listing not found" });
  }
  try {
    const listing = await prisma.productListing.findUnique({
      where: { id, active: true, legoProduct: { isPublished: true, availabilityState: { not: "DISCONTINUED" } } },
      select: {
        id: true,
        legoProductId: true,
        condition: true,
        originalPrice: true,
        salePrice: true,
        currentStock: true,
        reservedStock: true,
        createdAt: true,
        updatedAt: true,
        legoProduct: { include: {
          category: { select: categorySelect },
          productImages: {
            select: { id: true, url: true, publicId: true, altText: true, sortOrder: true },
            orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
          },
        } },
      },
    });
    if (!listing) {
      return res.status(404).json({ error: "Listing not found" });
    }
    const {reservedStock,...publicListing}=listing;
    res.json(serializeListing({...publicListing,currentStock:Math.max(0,listing.currentStock-reservedStock)}));
  } catch (err) {
    logOperationalError("Get product by id error", err);
    res.status(500).json({ error: "Internal server error" });
  }
};

/**
 * PATCH /products/:id/deactivate
 * Deactivates a product listing without deleting data.
 */
export const deactivateProduct = async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(404).json({ error: "Listing not found" });
  }
  try {
    const existing = await prisma.productListing.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ error: "Listing not found" });
    }
    await prisma.productListing.update({ where: { id }, data: { active: false } });
    const updated = await prisma.productListing.findUnique({
      where: { id },
      select: {
        id: true,
        legoProductId: true,
        condition: true,
        originalPrice: true,
        salePrice: true,
        active: true,
        currentStock: true,
        createdAt: true,
        updatedAt: true,
        legoProduct: { include: {
          category: { select: categorySelect },
          productImages: {
            select: { id: true, url: true, publicId: true, altText: true, sortOrder: true },
            orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
          },
        } },
      },
    });
    if (!updated) {
      return res.status(500).json({ error: "Failed to retrieve updated listing" });
    }
    res.json(serializeListing(updated));
  } catch (err) {
    logOperationalError("Deactivate product error", err);
    res.status(500).json({ error: "Internal server error" });
  }
};

/**
 * PATCH /products/:id/reactivate
 * Reactivates a product listing without deleting data.
 */
export const reactivateProduct = async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(404).json({ error: "Listing not found" });
  }
  try {
    const existing = await prisma.productListing.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ error: "Listing not found" });
    }
    if (existing.condition === ListingCondition.USED_LIKE_NEW && existing.usedLifecycle !== "AVAILABLE") {
      return res.status(409).json({ error: "A terminal Used offer cannot be reactivated" });
    }
    await prisma.productListing.update({ where: { id }, data: { active: true } });
    const updated = await prisma.productListing.findUnique({
      where: { id },
      select: {
        id: true,
        legoProductId: true,
        condition: true,
        originalPrice: true,
        salePrice: true,
        active: true,
        currentStock: true,
        createdAt: true,
        updatedAt: true,
        legoProduct: { include: {
          category: { select: categorySelect },
          productImages: {
            select: { id: true, url: true, publicId: true, altText: true, sortOrder: true },
            orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
          },
        } },
      },
    });
    if (!updated) {
      return res.status(500).json({ error: "Failed to retrieve updated listing" });
    }
    res.json(serializeListing(updated));
  } catch (err) {
    logOperationalError("Reactivate product error", err);
    res.status(500).json({ error: "Internal server error" });
  }
};

/** PATCH /products/by-product/:productId/feature — atomically selects a product as its category feature. */
export const setFeatureProduct = async (req: Request, res: Response) => {
  const id = Number(req.params.productId);
  if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ error: "Product not found" });
  try {
    return res.json(await createProductFeatureService().setFeature(id));
  } catch (error) {
    if (error instanceof FeatureProductNotFoundError) return res.status(404).json({ error: error.message });
    if (error instanceof FeatureProductCategoryChangedError) return res.status(409).json({ error: error.message });
    logOperationalError("Set feature product error", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};

/**
 * POST /products/:id/inventory-adjustments
 * Manually adjust the stock of a product listing and record an inventory movement.
 *
 * Request body: { quantity: number }
 * Positive integer increases stock, negative decreases.
 */
export const adjustInventory = async (req: Request, res: Response) => {
  const listingId = Number(req.params.id);
  if (!Number.isInteger(listingId) || listingId <= 0) {
    return res.status(404).json({ error: "Listing not found" });
  }
  const schema = z.object({
    quantity: z
      .number()
      .int()
      .refine((q) => q !== 0, { message: "quantity must not be zero" }),
  });
  const parseResult = schema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ error: parseResult.error.format() });
  }
  const { quantity } = parseResult.data;
  // Ensure authenticated user
  const performedBy = req.user?.id;
  if (!performedBy) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const result = await prisma.$transaction(async (tx) => {
      const listing = await tx.productListing.findUnique({ where: { id: listingId } });
      if (!listing) {
        throw new Error("listing_not_found");
      }
      if (listing.condition === ListingCondition.USED_LIKE_NEW && (listing.usedLifecycle !== "AVAILABLE" || quantity > 0)) {
        throw new Error("used_listing_is_not_adjustable");
      }
      const updatedRows = await tx.$executeRaw`
        UPDATE "ProductListing"
        SET "currentStock" = "currentStock" + ${quantity},
            "usedLifecycle" = CASE WHEN "condition" = 'USED_LIKE_NEW' AND "currentStock" + ${quantity} = 0 THEN 'RETIRED'::"UsedOfferLifecycle" ELSE "usedLifecycle" END
        WHERE "id" = ${listingId}
          AND "currentStock" + ${quantity} >= 0
          AND "currentStock" + ${quantity} >= "reservedStock"
      `;
      if (updatedRows === 0) {
        throw new Error(listing.currentStock < Math.max(0, -quantity)
          ? "negative_stock"
          : "insufficient_available_stock");
      }
      const movement = await tx.inventoryMovement.create({
        data: {
          listingId,
          quantityChange: quantity,
          type: InventoryMovementType.MANUAL_ADJUSTMENT,
          note: `Manual inventory adjustment of ${quantity}`,
          performedByUserId: performedBy,
        },
      });
      const updatedListing = await tx.productListing.findUnique({ where: { id: listingId } });
      return { listing: updatedListing, movement };
    });
    const { listing, movement } = result;
    if (!listing) {
      return res.status(404).json({ error: "Listing not found" });
    }
    res.json({
      listing: {
        id: listing.id,
        currentStock: listing.currentStock,
      },
      movement,
    });
  } catch (err: any) {
    if (err.message === "negative_stock") {
      return res
        .status(400)
        .json({ error: "Adjustment would make stock negative" });
    }
    if (err.message === "insufficient_available_stock") {
      return res
        .status(400)
        .json({ error: "Adjustment would consume reserved stock" });
    }
    if (err.message === "listing_not_found") {
      return res.status(404).json({ error: "Listing not found" });
    }
    if (err.message === "used_listing_is_not_adjustable") return res.status(409).json({ error: "Used offers cannot be restocked or adjusted into a pooled quantity" });
    logOperationalError("Inventory adjustment error", err);
    res.status(500).json({ error: "Internal server error" });
  }
};

/**
 * GET /products/:id/inventory-movements
 * Returns the inventory movement history for a ProductListing.
 * Requires authentication via authMiddleware.
 */
export const getInventoryMovements = async (req: Request, res: Response) => {
  const listingId = Number(req.params.id);
  if (!Number.isInteger(listingId) || listingId <= 0) {
    return res.status(404).json({ error: "Listing not found" });
  }
  try {
    // Verify listing exists (active or inactive)
    const listing = await prisma.productListing.findUnique({
      where: { id: listingId },
      select: { id: true },
    });
    if (!listing) {
      return res.status(404).json({ error: "Listing not found" });
    }
    const movements = await prisma.inventoryMovement.findMany({
      where: { listingId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        listingId: true,
        quantityChange: true,
        type: true,
        note: true,
        performedByUserId: true,
        createdAt: true,
        fbaOutbound: { select: { id: true, shipmentReference: true, idempotencyKey: true } },
      },
    });
    res.json({ listingId, movements });
  } catch (err) {
    logOperationalError("Get inventory movements error", err);
    res.status(500).json({ error: "Internal server error" });
  }
};
