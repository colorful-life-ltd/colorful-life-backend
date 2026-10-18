import {logOperationalError} from "../utils/operationalLog.js";
import { Request, Response } from "express";
import { createHash } from "node:crypto";
import { importAmazonPurchaseInvoice } from "../domain/purchases/purchaseImportService.js";
// Manual purchase controller
import { createManualPurchase as domainCreateManualPurchase } from "../domain/purchases/manualPurchaseService.js";
import { ProductListingNotFoundError } from "../domain/purchases/manualPurchaseService.js";
import { ManualPurchaseSchema } from "../domain/purchases/manualPurchaseValidator.js";
import { DuplicateImportError } from "../domain/purchases/purchasePersistence.js";
import { PdfTextExtractionError } from "../domain/purchases/pdfTextExtractor.js";
import { AmazonPurchaseInvoiceParseError } from "../domain/purchases/parsers/amazonPurchaseInvoiceParser.js";
import { PurchaseNormalizationError } from "../domain/purchases/purchaseNormalizer.js";
import {
  MANUAL_PURCHASE_CUSTOM_SUPPLIER_LABEL,
  MANUAL_PURCHASE_SUPPLIER_OPTIONS,
} from "../domain/purchases/manualPurchaseSupplierOptions.js";
import { ValidationError } from "../domain/purchases/purchaseImport.js";
import { Prisma } from "../generated/prisma-client/client.js";
import { prisma } from "../prisma/runtime.js";
// Domain service and error classes for purchase item receiving
import {
  receivePurchaseItem as domainReceivePurchaseItem,
  PurchaseItemNotFoundError,
  AlreadyReceivedError,
  InvalidQuantityError,
  ProductListingMissingError,
  NonInventoryPurchaseItemError,
  UsedOfferPurchaseReceiptError,
} from "../domain/purchases/purchaseItemReceiving.js";
// Domain service and error classes for purchase item return
import {
  returnPurchaseItem as domainReturnPurchaseItem,
  PurchaseItemNotFoundError as ReturnPurchaseItemNotFoundError,
  PurchaseItemNotReceivedError as ReturnPurchaseItemNotReceivedError,
  PurchaseItemAlreadyReturnedError as ReturnPurchaseItemAlreadyReturnedError,
  ProductListingMissingError as ReturnProductListingMissingError,
  InvalidQuantityError as ReturnInvalidQuantityError,
  InsufficientStockError as ReturnInsufficientStockError,
} from "../domain/purchases/purchaseItemReturn.js";

/**
 * Controller for the Purchase Invoice import endpoint.
 * Expects a single PDF file in the `file` field of a multipart/form‑data request.
 * The request must be authenticated via `authMiddleware`; the user ID is
 * available on `req.user.id`.
 */
export const importPurchaseInvoice = async (req: Request, res: Response) => {
  try {
    const file = req.file as Express.Multer.File | undefined;
    if (!file) {
      return res.status(400).json({ error: "No file provided" });
    }

    if (file.size === 0) {
      return res.status(400).json({ error: "Uploaded file is empty" });
    }

    // Simple PDF signature check – %PDF- is 5 bytes
    const pdfSignature = Buffer.from("%PDF-");
    if (!file.buffer.subarray(0, pdfSignature.length).equals(pdfSignature)) {
      return res.status(400).json({ error: "Uploaded file is not a valid PDF" });
    }

    const hash = createHash("sha256")
      .update(file.buffer)
      .digest("hex");

    const userId = (req.user as { id: number }).id;

    await importAmazonPurchaseInvoice(file.buffer, hash, userId);

    return res
      .status(201)
      .json({ message: "Purchase invoice imported successfully", importHash: hash });
  } catch (err: unknown) {
    if (err instanceof DuplicateImportError) {
      return res.status(409).json({ error: err.message });
    }
    if (
      err instanceof PdfTextExtractionError ||
      err instanceof AmazonPurchaseInvoiceParseError ||
      err instanceof PurchaseNormalizationError ||
      err instanceof ValidationError
    ) {
      return res.status(400).json({ error: err.message });
    }
    logOperationalError("Purchase import error", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};

/**
 * HTTP controller for receiving a purchase item.
 *
 * This controller validates the request, calls the domain service
 * `receivePurchaseItem(userId, purchaseItemId)`, and maps domain errors
 * to appropriate HTTP status codes.  It does not perform any business logic
 * beyond delegating to the domain service.
 */
export const receivePurchaseItem = async (req: Request, res: Response) => {
  const userId = (req.user as { id: number }).id;
  const idParam = req.params.id;
  const purchaseItemId = Number(idParam);
  if (!Number.isInteger(purchaseItemId) || purchaseItemId < 1) {
    return res.status(400).json({ error: "Invalid purchase item id" });
  }
  try {
    const result = await domainReceivePurchaseItem(userId, purchaseItemId);
    return res.status(200).json(result);
  } catch (err: unknown) {
    if (err instanceof PurchaseItemNotFoundError) {
      return res.status(404).json({ error: err.message });
    }
    if (err instanceof AlreadyReceivedError) {
      return res.status(409).json({ error: err.message });
    }
    if (err instanceof InvalidQuantityError) {
      return res.status(400).json({ error: err.message });
    }
    if (err instanceof ProductListingMissingError) {
      return res.status(400).json({ error: err.message });
    }
    if (err instanceof NonInventoryPurchaseItemError) {
      return res.status(409).json({ error: err.message });
    }
    if (err instanceof UsedOfferPurchaseReceiptError) return res.status(409).json({ error: err.message });
    logOperationalError("Receive purchase item error", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};

/**
 * HTTP controller for returning a fully received purchase item.
 *
 * It delegates to the domain service {@link domainReturnPurchaseItem} and
 * maps domain errors to appropriate HTTP status codes.
 */
export const returnPurchaseItem = async (req: Request, res: Response) => {
  const authenticatedUserId = (req.user as { id: number }).id;
  const idParam = req.params.id;
  const purchaseItemId = Number(idParam);
  if (!Number.isInteger(purchaseItemId) || purchaseItemId < 1) {
    return res.status(400).json({ error: "Invalid purchase item id" });
  }
  try {
    const result = await domainReturnPurchaseItem(authenticatedUserId, purchaseItemId);
    return res.status(200).json(result);
  } catch (err: unknown) {
    // Map domain errors to HTTP status codes
    if (err instanceof ReturnPurchaseItemNotFoundError) {
      return res.status(404).json({ error: err.message });
    }
    if (err instanceof ReturnPurchaseItemNotReceivedError) {
      return res.status(400).json({ error: err.message });
    }
    if (err instanceof ReturnPurchaseItemAlreadyReturnedError) {
      return res.status(409).json({ error: err.message });
    }
    if (err instanceof ReturnProductListingMissingError) {
      return res.status(400).json({ error: err.message });
    }
    if (err instanceof ReturnInvalidQuantityError) {
      return res.status(400).json({ error: err.message });
    }
    if (err instanceof ReturnInsufficientStockError) {
      return res.status(400).json({ error: err.message });
    }
    logOperationalError("Return purchase item error", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};

/**
 * HTTP controller for creating a manual purchase entry.
 *
 * The request body is validated against {@link ManualPurchaseSchema}.  On
 * validation failure a 400 with a formatted Zod error object is returned.
 * Domain errors are mapped to appropriate HTTP status codes:
 *   • {@link ProductListingNotFoundError} → 400
 *   • {@link DuplicateImportError} → 409
 *   • {@link ValidationError} or {@link PurchaseNormalizationError} → 400
 *   • Any other error → 500
 */
export const createManualPurchase = async (req: Request, res: Response) => {
  const userId = (req.user as { id: number }).id;
  const parseResult = ManualPurchaseSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ error: parseResult.error.format() });
  }
  try {
    const purchaseDocument = await domainCreateManualPurchase(parseResult.data, userId);
    return res.status(201).json(purchaseDocument);
  } catch (err: unknown) {
    if (err instanceof ProductListingNotFoundError) {
      return res.status(400).json({ error: err.message });
    }
    if (err instanceof DuplicateImportError) {
      return res.status(409).json({ error: err.message });
    }
    if (err instanceof ValidationError || err instanceof PurchaseNormalizationError) {
      return res.status(400).json({ error: err.message });
    }
    logOperationalError("Manual purchase error", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};

/** Admin contract for the canonical options used by manual purchase entry. */
export const getManualPurchaseSupplierOptions = (_req: Request, res: Response) => {
  return res.json({
    canonicalSuppliers: MANUAL_PURCHASE_SUPPLIER_OPTIONS,
    customSupplierOption: MANUAL_PURCHASE_CUSTOM_SUPPLIER_LABEL,
  });
};

/**
 * GET /purchases
 * Returns a paginated list of purchases that belong to the authenticated user.
 * Ownership is determined by presence of at least one PurchaseDocument
 * owned by the user.
 */
export const listPurchases = async (req: Request, res: Response) => {
  const userId = (req.user as { id: number }).id;
  const pageParam = req.query.page;
  const pageSizeParam = req.query.pageSize ?? req.query.limit;
  const searchParam = req.query.search;
  const parsePositiveInteger = (value: unknown, fallback: number): number | null => {
    if (value === undefined) return fallback;
    if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  };
  const page = parsePositiveInteger(pageParam, 1);
  const pageSize = parsePositiveInteger(pageSizeParam, 20);
  if (page === null) {
    return res.status(400).json({ error: "Invalid page parameter" });
  }
  if (pageSize === null || pageSize > 100) {
    return res.status(400).json({ error: "Invalid pageSize parameter" });
  }
  if (!Number.isSafeInteger((page - 1) * pageSize)) {
    return res.status(400).json({ error: "Invalid page parameter" });
  }
  if (typeof searchParam !== "undefined" && typeof searchParam !== "string") {
    return res.status(400).json({ error: "Invalid search parameter" });
  }
  const search = typeof searchParam === "string" ? searchParam.trim() : "";
  if (search.length > 200) {
    return res.status(400).json({ error: "Invalid search parameter" });
  }

  let dateSearch: string | undefined;
  if (/^\d{4}-/.test(search)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(search)) {
      return res.status(400).json({ error: "Invalid search date; use YYYY-MM-DD" });
    }
    const [year, month, day] = search.split("-").map(Number);
    const candidate = new Date(0);
    candidate.setUTCHours(0, 0, 0, 0);
    candidate.setUTCFullYear(year, month - 1, day);
    if (year < 1 || candidate.toISOString().slice(0, 10) !== search) {
      return res.status(400).json({ error: "Invalid search date; use YYYY-MM-DD" });
    }
    dateSearch = search;
  }
  try {
    const searchFilter = search
      ? dateSearch
        ? Prisma.sql`AND (
            STRPOS(LOWER(p."sourceOrderReference"), LOWER(${search})) > 0
            OR (
              p."sourceOrderDate" >= CAST(${dateSearch} AS timestamp)
              AND p."sourceOrderDate" < CAST(${dateSearch} AS timestamp) + INTERVAL '1 day'
            )
          )`
        : Prisma.sql`AND STRPOS(LOWER(p."sourceOrderReference"), LOWER(${search})) > 0`
      : Prisma.empty;
    const purchaseScope = Prisma.sql`
      WHERE EXISTS (
        SELECT 1 FROM "PurchaseDocument" scoped_document
        WHERE scoped_document."purchaseId" = p."id"
          AND scoped_document."importedByUserId" = ${userId}
      )
      ${searchFilter}
    `;
    const [countRows, pageRows] = await Promise.all([
      prisma.$queryRaw<Array<{ totalItems: bigint }>>(Prisma.sql`
        SELECT COUNT(*)::bigint AS "totalItems"
        FROM "Purchase" p
        ${purchaseScope}
      `),
      prisma.$queryRaw<Array<{ id: number }>>(Prisma.sql`
        SELECT p."id"
        FROM "Purchase" p
        ${purchaseScope}
        ORDER BY
          (
            SELECT CASE
              WHEN COUNT(item."id") FILTER (
                WHERE item."inventoryDisposition" = 'NON_INVENTORY'::"PurchaseItemDisposition"
                   OR item."productListingId" IS NOT NULL
              ) = 0 THEN 0
              WHEN COUNT(item."id") FILTER (
                WHERE item."inventoryDisposition" = 'NON_INVENTORY'::"PurchaseItemDisposition"
                   OR item."productListingId" IS NOT NULL
              ) < COUNT(item."id") THEN 1
              ELSE 2
            END
            FROM "PurchaseDocument" document
            LEFT JOIN "PurchaseItem" item ON item."purchaseDocumentId" = document."id"
            WHERE document."purchaseId" = p."id"
              AND document."importedByUserId" = ${userId}
          ) ASC,
          p."sourceOrderDate" DESC NULLS LAST,
          p."id" DESC
        OFFSET ${(page - 1) * pageSize}
        LIMIT ${pageSize}
      `),
    ]);
    const totalItems = Number(countRows[0]?.totalItems ?? 0n);
    const pageIds = pageRows.map(({ id }) => id);
    const purchases = pageIds.length
      ? await prisma.purchase.findMany({
          where: {
            id: { in: pageIds },
            purchaseDocuments: { some: { importedByUserId: userId } },
          },
          include: {
            purchaseDocuments: {
              where: { importedByUserId: userId },
              include: {
                purchaseItems: { select: { productListingId: true, inventoryDisposition: true } },
              },
            },
          },
        })
      : [];
    const purchasesById = new Map(purchases.map((purchase) => [purchase.id, purchase]));
    const pagePurchases = pageIds.flatMap((id) => {
      const purchase = purchasesById.get(id);
      if (!purchase) return [];
      return [{
        ...purchase,
        // Preserve the Purchase History response shape; items are only read to
        // derive the existing resolution priority before database pagination.
        purchaseDocuments: purchase.purchaseDocuments.map(({ purchaseItems: _items, ...document }) => document),
      }];
    });
    const totalPages = Math.ceil(totalItems / pageSize);
    res.json({
      purchases: pagePurchases,
      pagination: {
        page,
        pageSize,
        totalItems,
        totalPages,
        // Keep the original response field names for existing clients.
        limit: pageSize,
        total: totalItems,
      },
    });
  } catch (err) {
    logOperationalError("List purchases error", err);
    res.status(500).json({ error: "Internal server error" });
  }
};

/**
 * GET /purchases/:id
 * Returns a single purchase belonging to the authenticated user, with
 * purchaseDocuments and purchaseItems filtered to the authenticated user.
 */
export const getPurchaseById = async (req: Request, res: Response) => {
  const userId = (req.user as { id: number }).id;
  const idParam = req.params.id;
  const purchaseId = Number(idParam);
  if (!Number.isInteger(purchaseId) || purchaseId < 1) {
    return res.status(400).json({ error: "Invalid purchase id" });
  }
  try {
    const purchase = await prisma.purchase.findFirst({
      where: {
        id: purchaseId,
        purchaseDocuments: {
          some: { importedByUserId: userId },
        },
      },
      include: {
        purchaseDocuments: {
          where: { importedByUserId: userId },
          orderBy: { partNumber: "asc" },
          include: {
            purchaseItems: {
              orderBy: { sourceLineNumber: "asc" },
            },
          },
        },
      },
    });
    if (!purchase) {
      return res.status(404).json({ error: "Purchase not found" });
    }
    res.json(purchase);
  } catch (err) {
    logOperationalError("Get purchase error", err);
    res.status(500).json({ error: "Internal server error" });
  }
};
