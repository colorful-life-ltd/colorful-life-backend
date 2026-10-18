import { positivePriceSchema, salePriceSchema, priceMessage } from "../domain/products/listingPrice.js";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../prisma/runtime.js";
import { createProduct } from "../controllers/products.js";
import { createProductListingCreationService } from "../domain/products/productListingCreationService.js";

// Mounted under the authenticated ADMIN review router.
export const purchaseListingsRouter = Router({ mergeParams: true });
const listingCreation = createProductListingCreationService();
purchaseListingsRouter.use(async (req, res, next) => {
  const id = Number((req.params as Record<string, string>).id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "Invalid purchase" }); return; }
  try {
    if (!await prisma.purchase.findFirst({ where: { id, purchaseDocuments: { some: { importedByUserId: req.user!.id } } } })) {
      res.status(404).json({ error: "Purchase not found" }); return;
    }
    next();
  } catch { res.status(500).json({ error: "Purchase could not be checked" }); }
});
purchaseListingsRouter.get("/products", async (req, res) => {
  const parsed = z.object({ q: z.string().trim().min(1).max(100) }).safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: "Enter a product search" }); return; }
  try {
    res.json(await prisma.legoProduct.findMany({
      where: { OR: [{ setNumber: { contains: parsed.data.q, mode: "insensitive" } }, { title: { contains: parsed.data.q, mode: "insensitive" } }] },
      select: { id: true, setNumber: true, title: true }, orderBy: { setNumber: "asc" }, take: 50,
    }));
  } catch { res.status(500).json({ error: "Product search failed" }); }
});
const pricing = {
  condition: z.enum(["NEW", "USED_LIKE_NEW"]), originalPrice: positivePriceSchema,
  salePrice: salePriceSchema, currentStock: z.literal(0),
};
const creation = z.union([
  z.object({ ...pricing, existingProductId: z.number().int().positive() }).strict(),
  z.object({ ...pricing, setNumber: z.string().trim().min(1), title: z.string().trim().min(1),
    description: z.string().optional(), theme: z.string().trim().min(1), categoryId: z.number().int().positive(),
    ageRecommendation: z.string().trim().min(1), pieceCount: z.number().int().positive() }).strict(),
]);
purchaseListingsRouter.post("/listings", async (req, res) => {
  const parsed = creation.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Select a condition and valid product details. Initial stock must be zero. " + priceMessage }); return; }
  const body = parsed.data;
  if (body.condition === "USED_LIKE_NEW") { res.status(400).json({ error: "Used offers must be created through the per-item Used offer operation" }); return; }
  if (!("existingProductId" in body)) {
    req.body = body;
    await createProduct(req, res);
    return;
  }
  try {
    const product = await prisma.legoProduct.findUnique({ where: { id: body.existingProductId }, select: { id: true, categoryId: true } });
    if (!product) { res.status(404).json({ error: "Product not found" }); return; }
    const { existingProductId, ...data } = body;
    const listing = await listingCreation.createForCategory(product.categoryId, async (tx, firstProductInCategory) => {
      if (firstProductInCategory) await tx.legoProduct.update({ where: { id: existingProductId }, data: { isFeatureProduct: true } });
      return tx.productListing.create({
        data: { ...data, currentStock: 0, legoProductId: existingProductId },
        include: { legoProduct: { include: {
          category: true,
          productImages: {
            select: { id: true, url: true, publicId: true, altText: true, sortOrder: true },
            orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
          },
        } } },
      });
    });
    const { category, ...legoProduct } = listing.legoProduct;
    res.status(201).json({ ...listing, legoProduct, category, availableStock: 0 });
  } catch { res.status(500).json({ error: "Listing could not be created" }); }
});
