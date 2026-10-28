import {logOperationalError} from "../utils/operationalLog.js";
import { InvalidListingPriceError } from "../domain/products/listingPrice.js";
import type { Request, Response } from "express";
import { addCartItem, clearCart, getCart, removeCartItem, updateCartItem } from "../domain/cart/cartService.js";
import { CartAccountUnavailableError, CartItemNotFoundError, InsufficientAvailableStockError, ProductListingInactiveError, ProductListingNotFoundError } from "../domain/cart/cartErrors.js";
import { CartItemSchema, UpdateCartItemSchema } from "../domain/cart/cartValidator.js";

function listingId(req: Request) { const id = Number(req.params.productListingId); return Number.isInteger(id) && id > 0 ? id : null; }
function respondError(res: Response, err: unknown) {
  if (err instanceof CartAccountUnavailableError) return res.status(401).json({ error: err.message });
  if (err instanceof CartItemNotFoundError || err instanceof ProductListingNotFoundError) return res.status(404).json({ error: err.message });
  if (err instanceof InvalidListingPriceError || err instanceof ProductListingInactiveError || err instanceof InsufficientAvailableStockError) return res.status(409).json({ error: err.message });
  logOperationalError("Cart error"); return res.status(500).json({ error: "Internal server error" });
}
export async function getCartHandler(req: Request, res: Response) { try { return res.status(200).json(await getCart(req.user!.id)); } catch (e) { return respondError(res, e); } }
export async function addCartItemHandler(req: Request, res: Response) { const parsed = CartItemSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: parsed.error.format() }); try { return res.status(200).json(await addCartItem(req.user!.id, parsed.data.productListingId, parsed.data.quantity)); } catch (e) { return respondError(res, e); } }
export async function updateCartItemHandler(req: Request, res: Response) { const id = listingId(req); if (!id) return res.status(400).json({ error: "Invalid product listing id" }); const parsed = UpdateCartItemSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: parsed.error.format() }); try { return res.status(200).json(await updateCartItem(req.user!.id, id, parsed.data.quantity)); } catch (e) { return respondError(res, e); } }
export async function removeCartItemHandler(req: Request, res: Response) { const id = listingId(req); if (!id) return res.status(400).json({ error: "Invalid product listing id" }); try { return res.status(200).json(await removeCartItem(req.user!.id, id)); } catch (e) { return respondError(res, e); } }
export async function clearCartHandler(req: Request, res: Response) { try { return res.status(200).json(await clearCart(req.user!.id)); } catch (e) { return respondError(res, e); } }
