import {InventoryDiscrepancyError} from "../domain/inventory/inventoryDiscrepancy.js";
import {logOperationalError} from "../utils/operationalLog.js";
import {UnsupportedDeliveryCountryError} from "../domain/orders/orderErrors.js";
import { InvalidListingPriceError } from "../domain/products/listingPrice.js";
import { sendProtectionError } from "../middleware/checkoutProtection.js";
import { OrderReturnEligibilityError, OrderCancellationReturnConflictError } from "../domain/orders/returnInventorySafety.js";
import { CartQuantityAllocatedError } from "../domain/cart/cartProvenanceService.js";
import { Request, Response } from "express";
import { CreateOrderSchema } from "../domain/orders/orderValidator.js";
import { completeOrder } from "../domain/orders/orderCompletionService.js";
import { createOrder, OrderIdempotencyMismatchError, InvalidOrderIdempotencyKeyError } from "../domain/orders/orderService.js";
// Error type used by the completion service
import { OrderNotCompletableError } from "../domain/orders/orderCompletionErrors.js";
import { OrderNotFoundError as OrderNotFoundErrorComplete } from "../domain/orders/orderDispatchErrors.js";
import {
  NoDefaultBillingAddressError,
  MultipleDefaultBillingAddressesError,
  InvalidBillingAddressCountryError,
  ProductListingNotFoundError,
  ProductListingInactiveError,
  DuplicateProductListingError,
  InsufficientAvailableStockError,
  EmailVerificationRequiredError,
  OrderUserNotFoundError,
} from "../domain/orders/orderErrors.js";
import { CancelOrderSchema, SellerCancelOrderSchema } from "../domain/orders/orderCancellationValidator.js";
import { DispatchOrderSchema } from "../domain/orders/orderDispatchValidator.js";
import { cancelOrder, cancelOrderByAdmin } from "../domain/orders/orderCancellationService.js";
import { confirmOrder } from "../domain/orders/orderConfirmationService.js";
import { dispatchOrder } from "../domain/orders/orderDispatchService.js";
import {
  requestOrderReturn,
  authorizeOrderReturn,
  receiveOrderReturn,
  inspectOrderReturn,
  completeOrderReturn,
  cancelOrderReturn,
  InvalidReturnQuantityError,
  InvalidReturnReasonError,
  InvalidReturnShippingPayerError,
  InvalidReturnShippingCostError,
  OrderNotFoundError as OrderReturnOrderNotFoundError,
  OrderItemNotFoundError,
  OrderReturnQuantityExceededError,
  OrderReturnNotFoundError,
  OrderReturnNotAuthorizableError,
  OrderReturnNotReceivableError,
  InvalidReturnConditionError,
  InvalidInspectionRestockQuantityError,
  InvalidInspectionRestockConditionError,
  OrderReturnNotInspectableError,
  OrderReturnNotCompletableError,
  OrderReturnNotCancellableError,
  ProductListingMissingError as OrderReturnProductListingMissingError,
} from "../domain/orders/orderReturnService.js";
import { OrderReturnSchema } from "../domain/orders/orderReturnValidator.js";
import { OrderReturnInspectionSchema } from "../domain/orders/orderReturnInspectionValidator.js";
import {
  OrderNotFoundError as OrderNotFoundErrorCancel,
  OrderNotCancellableError,
  OrderCancellationPaymentError,
  InsufficientReservedStockError,
} from "../domain/orders/orderCancellationErrors.js";
import {
  OrderNotFoundError as OrderNotFoundErrorConfirm,
  OrderNotConfirmableError,
  InsufficientStockError,
  ProductListingNotFoundError as ConfirmationProductListingNotFoundError,
} from "../domain/orders/orderConfirmationErrors.js";
import { OrderNotFoundError as OrderNotFoundErrorDispatch, OrderNotDispatchableError } from "../domain/orders/orderDispatchErrors.js";
import { FulfilmentPaymentNotVerifiedError } from "../domain/fulfilment/fulfilmentErrors.js";
import { getCustomerOrder, listCustomerOrders } from "../domain/orders/orderReadService.js";
import { sendApiError } from "../utils/apiErrorResponse.js";

export const listCustomerOrdersHandler = async (req: Request, res: Response) => {
  const userId = (req.user as { id: number }).id;
  try {
    return res.status(200).json(await listCustomerOrders(userId));
  } catch (err) {
    logOperationalError("Customer order listing error", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};

export const getCustomerOrderHandler = async (req: Request, res: Response) => {
  const orderId = Number(req.params.orderId);
  if (!Number.isInteger(orderId) || orderId < 1) {
    return res.status(400).json({ error: "Invalid order id" });
  }
  const userId = (req.user as { id: number }).id;
  try {
    const order = await getCustomerOrder(userId, orderId);
    if (!order) return res.status(404).json({ error: "Order not found" });
    return res.status(200).json(order);
  } catch (err) {
    logOperationalError("Customer order read error", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};

export const createOrderHandler = async (req: Request, res: Response) => {
  if(!req.get("Idempotency-Key"))return res.status(400).json({error:"IDEMPOTENCY_KEY_REQUIRED"});
  const parseResult = CreateOrderSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ error: parseResult.error.format() });
  }
  const userId = (req.user as { id: number }).id;
  try {
    const order = await createOrder(userId, parseResult.data, req.get("Idempotency-Key"), true);
    const { creationIdempotencyKey: _key, creationRequestHash: _hash, actualShippingCost: _merchantCost, confirmationDeliverySnapshot: _deliverySnapshot, ...response } = order;
    return res.status(201).json(response);
  } catch (err: unknown) {
      if(err instanceof UnsupportedDeliveryCountryError)return sendApiError(res,400,"DELIVERY_COUNTRY_UNSUPPORTED",err.message);
      if(err instanceof InventoryDiscrepancyError)return sendApiError(res,409,"INVENTORY_DISCREPANCY_REVIEW_REQUIRED","Inventory requires review before another reservation",{productListingId:err.listingId,availableQuantity:0});
      if (sendProtectionError(res, err)) return;
      if (err instanceof InvalidListingPriceError) return sendApiError(res, 409, "LISTING_UNAVAILABLE", err.message, { productListingId: err.productListingId, reason: "INVALID_PRICE", availableQuantity: 0 });
      if (err instanceof CartQuantityAllocatedError) return sendApiError(res, 409, "CART_QUANTITY_UNAVAILABLE", err.message, { productListingId: err.productListingId });
      if (err instanceof ProductListingNotFoundError) return sendApiError(res, 409, "LISTING_UNAVAILABLE", err.message, { productListingId: err.productListingId, reason: "LISTING_NOT_FOUND", availableQuantity: 0 });
      if (err instanceof ProductListingInactiveError) return sendApiError(res, 409, "LISTING_UNAVAILABLE", "This listing is no longer available", { productListingId: err.productListingId, reason: err.reason, availableQuantity: 0 });
      if (err instanceof InsufficientAvailableStockError) {
        // A failed conditional update can also mean managed reservation coverage is inconsistent.
        // Keep that guard fail-closed rather than reporting that otherwise visible stock is sold out.
        const code = err.availableQuantity === undefined || err.availableQuantity >= err.requestedQuantity
          ? "LISTING_UNAVAILABLE" : err.availableQuantity === 0 ? "OUT_OF_STOCK" : "INSUFFICIENT_STOCK";
        return sendApiError(res, 409, code, code === "LISTING_UNAVAILABLE" ? "Inventory is temporarily unavailable" : err.message,
          { productListingId: err.productListingId, requestedQuantity: err.requestedQuantity,
            availableQuantity: code === "LISTING_UNAVAILABLE" ? 0 : err.availableQuantity,
            reason: code === "LISTING_UNAVAILABLE" ? "INVENTORY_RESERVATION_CONFLICT" : code });
      }
      if (err instanceof OrderIdempotencyMismatchError) return sendApiError(res, 409, "ORDER_IDEMPOTENCY_MISMATCH", err.message);
      if (err instanceof InvalidOrderIdempotencyKeyError) return sendApiError(res, 400, "INVALID_IDEMPOTENCY_KEY", err.message);
      if (err instanceof EmailVerificationRequiredError) {
        return sendApiError(res, 403, "EMAIL_VERIFICATION_REQUIRED", err.message);
      }
      if (err instanceof OrderUserNotFoundError) {
        return res.status(404).json({ error: err.message });
      }
      if (err instanceof InvalidBillingAddressCountryError) return sendApiError(res, 400, "BILLING_ADDRESS_COUNTRY_INVALID", err.message);
      if (
        err instanceof NoDefaultBillingAddressError ||
        err instanceof MultipleDefaultBillingAddressesError ||
        err instanceof DuplicateProductListingError
    ) {
      return res.status(400).json({ error: err.message });
    }
    logOperationalError("Order creation error", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};
/**
 * ADMIN seller cancellation handler.
 * Requires the requester to be an ADMIN.
 */
export const cancelOrderBySellerHandler = async (req: Request, res: Response) => {
  const userRole = (req.user as { role: string }).role;
  if (userRole !== "ADMIN") {
    return sendApiError(res, 403, "FORBIDDEN", "Forbidden: ADMIN only");
  }
  const parseResult = SellerCancelOrderSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ error: parseResult.error.format() });
  }
  const orderId = Number(req.params.orderId);
  if (!Number.isInteger(orderId) || orderId < 1) {
    return res.status(400).json({ error: "Invalid order id" });
  }
  try {
    const order = await cancelOrderByAdmin(orderId, parseResult.data.reason, (req.user as { id: number }).id);
    return res.status(200).json(order);
  } catch (err: unknown) {
    if (err instanceof OrderCancellationReturnConflictError) return sendApiError(res, 409, "ORDER_RETURN_CONFLICT", err.message);
    if (err instanceof OrderCancellationPaymentError) {
      return sendApiError(res, 409, err.paid ? "ORDER_ALREADY_PAID" : "ORDER_PAYMENT_UNRESOLVED", err.message);
    }
    if (err instanceof OrderNotFoundErrorCancel) {
      return res.status(404).json({ error: err.message });
    }
      if (err instanceof OrderNotCancellableError || err instanceof InsufficientReservedStockError) {
      return res.status(400).json({ error: err.message });
    }
    logOperationalError("Seller order cancellation error", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};

// ADMIN order confirmation handler
export const confirmOrderHandler = async (req: Request, res: Response) => {
  const userRole = (req.user as { role: string }).role;
  if (userRole !== "ADMIN") {
    return sendApiError(res, 403, "FORBIDDEN", "Forbidden: ADMIN only");
  }
  const orderId = Number(req.params.orderId);
  if (!Number.isInteger(orderId) || orderId < 1) {
    return res.status(400).json({ error: "Invalid order id" });
  }
  try {
    const adminUserId = (req.user as { id: number }).id;
    const order = await confirmOrder(adminUserId, orderId);
    return res.status(200).json(order);
  } catch (err: unknown) {
    if(err instanceof InventoryDiscrepancyError)return sendApiError(res,409,"INVENTORY_DISCREPANCY_REVIEW_REQUIRED","Inventory requires review",{productListingId:err.listingId});
    if (err instanceof OrderNotFoundErrorConfirm) {
      return res.status(404).json({ error: err.message });
    }
    if (err instanceof ConfirmationProductListingNotFoundError) {
      return res.status(404).json({ error: err.message });
    }
    if (err instanceof OrderNotConfirmableError) {
      return res.status(400).json({ error: err.message });
    }
    if (err instanceof InsufficientStockError) {
      return res.status(400).json({ error: err.message });
    }
    logOperationalError("Order confirmation error", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};
// ADMIN order completion handler
export const completeOrderHandler = async (req: Request, res: Response) => {
  const userRole = (req.user as { role: string }).role;
  if (userRole !== "ADMIN") {
    return sendApiError(res, 403, "FORBIDDEN", "Forbidden: ADMIN only");
  }
  const orderId = Number(req.params.orderId);
  if (!Number.isInteger(orderId) || orderId < 1) {
    return res.status(400).json({ error: "Invalid order id" });
  }
  try {
    const order = await completeOrder(orderId);
    return res.status(200).json(order);
    } catch (err: unknown) {
      if (err instanceof OrderNotFoundErrorComplete) {
        return res.status(404).json({ error: err.message });
      }
      if (err instanceof OrderNotCompletableError) {
        return res.status(400).json({ error: err.message });
      }
      logOperationalError("Order completion error", err);
      return res.status(500).json({ error: "Internal server error" });
    }
};

export const cancelOrderHandler = async (req: Request, res: Response) => {
  const parseResult = CancelOrderSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ error: parseResult.error.format() });
  }
  const userId = (req.user as { id: number }).id;
  const orderId = Number(req.params.orderId);
  if (!Number.isInteger(orderId) || orderId < 1) {
    return res.status(400).json({ error: "Invalid order id" });
  }
  try {
    const order = await cancelOrder(userId, orderId, parseResult.data.reason);
    return res.status(200).json(order);
  } catch (err: unknown) {
    if (err instanceof OrderCancellationReturnConflictError) return sendApiError(res, 409, "ORDER_RETURN_CONFLICT", err.message);
    if (err instanceof OrderCancellationPaymentError) {
      return sendApiError(res, 409, err.paid ? "ORDER_ALREADY_PAID" : "ORDER_PAYMENT_UNRESOLVED", err.message);
    }
    if (err instanceof OrderNotFoundErrorCancel) {
      return res.status(404).json({ error: err.message });
    }
      if (err instanceof OrderNotCancellableError || err instanceof InsufficientReservedStockError) {
      return res.status(400).json({ error: err.message });
    }
    logOperationalError("Order cancellation error", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};

// ADMIN order return handler
export const processOrderReturnHandler = async (req: Request, res: Response) => {
  const userRole = (req.user as { role: string }).role;
  if (userRole !== "ADMIN") {
    return sendApiError(res, 403, "FORBIDDEN", "Forbidden: ADMIN only");
  }

  const parseResult = OrderReturnSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ error: parseResult.error.format() });
  }

  const orderId = Number(req.params.orderId);
  if (!Number.isInteger(orderId) || orderId < 1) {
    return res.status(400).json({ error: "Invalid order id" });
  }

  const performedByUserId = (req.user as { id: number }).id;
  const {
    orderItemId,
    quantity,
    reason,
    reasonNote,
    shippingPayer,
    returnShippingCost,
  } = parseResult.data;

  try {
    const orderReturn = await requestOrderReturn(
      orderId,
      orderItemId,
      quantity,
      reason,
      reasonNote,
      shippingPayer,
      returnShippingCost,
      performedByUserId,
    );
    return res.status(201).json(orderReturn);
  } catch (err: unknown) {
    if (err instanceof OrderReturnEligibilityError) return sendApiError(res, 409, "ORDER_RETURN_INELIGIBLE", err.message);
    if (
      err instanceof InvalidReturnQuantityError ||
      err instanceof InvalidReturnReasonError ||
      err instanceof InvalidReturnShippingPayerError ||
      err instanceof InvalidReturnShippingCostError ||
      err instanceof OrderReturnQuantityExceededError
    ) {
      return res.status(400).json({ error: err.message });
    }
    if (err instanceof OrderReturnOrderNotFoundError) {
      return res.status(404).json({ error: err.message });
    }
    if (err instanceof OrderItemNotFoundError) {
      return res.status(404).json({ error: err.message });
    }
    logOperationalError("Order return error", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};

// ADMIN order return authorization handler
export const authorizeOrderReturnHandler = async (req: Request, res: Response) => {
  const userRole = (req.user as { role: string }).role;
  if (userRole !== "ADMIN") {
    return sendApiError(res, 403, "FORBIDDEN", "Forbidden: ADMIN only");
  }

  const orderId = Number(req.params.orderId);
  if (!Number.isInteger(orderId) || orderId < 1) {
    return res.status(400).json({ error: "Invalid order id" });
  }

  const returnId = Number(req.params.returnId);
  if (!Number.isInteger(returnId) || returnId < 1) {
    return res.status(400).json({ error: "Invalid return id" });
  }

  try {
    const orderReturn = await authorizeOrderReturn(orderId, returnId);
    return res.status(200).json(orderReturn);
  } catch (err: unknown) {
    if (
      err instanceof OrderReturnOrderNotFoundError ||
      err instanceof OrderReturnNotFoundError
    ) {
      return res.status(404).json({ error: err.message });
    }
    if (err instanceof OrderReturnNotAuthorizableError) {
      return res.status(409).json({ error: err.message });
    }
    logOperationalError("Authorize order return error", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};

export const cancelOrderReturnHandler = async (req: Request, res: Response) => {
  const userRole = (req.user as { role: string }).role;
  if (userRole !== "ADMIN") return sendApiError(res, 403, "FORBIDDEN", "Forbidden: ADMIN only");
  const orderId = Number(req.params.orderId);
  const returnId = Number(req.params.returnId);
  if (!Number.isInteger(orderId) || orderId < 1) return res.status(400).json({ error: "Invalid order id" });
  if (!Number.isInteger(returnId) || returnId < 1) return res.status(400).json({ error: "Invalid return id" });
  try {
    return res.status(200).json(await cancelOrderReturn(orderId, returnId));
  } catch (err: unknown) {
    if (err instanceof OrderReturnOrderNotFoundError || err instanceof OrderReturnNotFoundError) return res.status(404).json({ error: err.message });
    if (err instanceof OrderReturnNotCancellableError || err instanceof OrderReturnQuantityExceededError) return res.status(409).json({ error: err.message });
    logOperationalError("Cancel order return error", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};

// ADMIN order return receipt handler
export const receiveOrderReturnHandler = async (req: Request, res: Response) => {
  const userRole = (req.user as { role: string }).role;
  if (userRole !== "ADMIN") {
    return sendApiError(res, 403, "FORBIDDEN", "Forbidden: ADMIN only");
  }

  const orderId = Number(req.params.orderId);
  if (!Number.isInteger(orderId) || orderId < 1) {
    return res.status(400).json({ error: "Invalid order id" });
  }

  const returnId = Number(req.params.returnId);
  if (!Number.isInteger(returnId) || returnId < 1) {
    return res.status(400).json({ error: "Invalid return id" });
  }

  try {
    const orderReturn = await receiveOrderReturn(orderId, returnId);
    return res.status(200).json(orderReturn);
  } catch (err: unknown) {
    if (
      err instanceof OrderReturnOrderNotFoundError ||
      err instanceof OrderReturnNotFoundError
    ) {
      return res.status(404).json({ error: err.message });
    }
    if (err instanceof OrderReturnNotReceivableError) {
      return res.status(409).json({ error: err.message });
    }
    logOperationalError("Receive order return error", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};

// ADMIN order return inspection handler
export const inspectOrderReturnHandler = async (req: Request, res: Response) => {
  const user = req.user as { id: number; role: string };
  if (user.role !== "ADMIN") {
    return sendApiError(res, 403, "FORBIDDEN", "Forbidden: ADMIN only");
  }

  const orderId = Number(req.params.orderId);
  if (!Number.isInteger(orderId) || orderId < 1) {
    return res.status(400).json({ error: "Invalid order id" });
  }

  const returnId = Number(req.params.returnId);
  if (!Number.isInteger(returnId) || returnId < 1) {
    return res.status(400).json({ error: "Invalid return id" });
  }

  const parseResult = OrderReturnInspectionSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ error: parseResult.error.format() });
  }

  try {
    const orderReturn = await inspectOrderReturn(
      orderId,
      returnId,
      parseResult.data.condition,
      parseResult.data.restockQuantity,
      parseResult.data.inspectionNote,
      user.id,
    );
    return res.status(200).json(orderReturn);
  } catch (err: unknown) {
    if (
      err instanceof InvalidReturnConditionError ||
      err instanceof InvalidInspectionRestockQuantityError ||
      err instanceof InvalidInspectionRestockConditionError
    ) {
      return res.status(400).json({ error: err.message });
    }
    if (
      err instanceof OrderReturnOrderNotFoundError ||
      err instanceof OrderReturnNotFoundError
    ) {
      return res.status(404).json({ error: err.message });
    }
    if (err instanceof OrderReturnNotInspectableError) {
      return res.status(409).json({ error: err.message });
    }
    logOperationalError("Inspect order return error", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};

// ADMIN order return completion handler
export const completeOrderReturnHandler = async (req: Request, res: Response) => {
  const user = req.user as { id: number; role: string };
  if (user.role !== "ADMIN") {
    return sendApiError(res, 403, "FORBIDDEN", "Forbidden: ADMIN only");
  }

  const orderId = Number(req.params.orderId);
  if (!Number.isInteger(orderId) || orderId < 1) {
    return res.status(400).json({ error: "Invalid order id" });
  }

  const returnId = Number(req.params.returnId);
  if (!Number.isInteger(returnId) || returnId < 1) {
    return res.status(400).json({ error: "Invalid return id" });
  }

  try {
    const orderReturn = await completeOrderReturn(
      orderId,
      returnId,
      user.id,
    );
    return res.status(200).json(orderReturn);
  } catch (err: unknown) {
    if (err instanceof OrderReturnEligibilityError) return sendApiError(res, 409, "ORDER_RETURN_INELIGIBLE", err.message);
    if (
      err instanceof OrderReturnOrderNotFoundError ||
      err instanceof OrderReturnNotFoundError
    ) {
      return res.status(404).json({ error: err.message });
    }
    if (
      err instanceof OrderReturnNotCompletableError ||
      err instanceof InvalidInspectionRestockQuantityError ||
      err instanceof InvalidInspectionRestockConditionError ||
      err instanceof OrderReturnQuantityExceededError ||
      err instanceof OrderReturnProductListingMissingError
    ) {
      return res.status(409).json({ error: err.message });
    }
    logOperationalError("Complete order return error", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};

  export const dispatchOrderHandler = async (req: Request, res: Response) => {
    const userRole = (req.user as { role: string }).role;
    if (userRole !== "ADMIN") {
      return sendApiError(res, 403, "FORBIDDEN", "Forbidden: ADMIN only");
    }
    const parseResult = DispatchOrderSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({ error: parseResult.error.format() });
    }
    const orderId = Number(req.params.orderId);
    if (!Number.isInteger(orderId) || orderId < 1) {
      return res.status(400).json({ error: "Invalid order id" });
    }
    try {
      const order = await dispatchOrder(
        orderId,
        parseResult.data.actualShippingCost,
        parseResult.data.shippingCarrier,
        parseResult.data.trackingNumber,
        (req.user as { id: number }).id,
      );
      // Omit actualShippingCost from the response as it's an internal field
      const { actualShippingCost, user: _user, ...rest } = order;
      return res.status(200).json(rest);
    } catch (err: unknown) {
      if (err instanceof OrderNotFoundErrorDispatch) {
        return res.status(404).json({ error: err.message });
      }
      if (err instanceof OrderNotDispatchableError) {
        return res.status(400).json({ error: err.message });
      }
      if (err instanceof FulfilmentPaymentNotVerifiedError) {
        return sendApiError(res, 409, err.reason === "REFUND_REVIEW_REQUIRED" ? "REFUND_REVIEW_REQUIRED" : "ORDER_PAYMENT_NOT_VERIFIED", err.message);
      }
      logOperationalError("Order dispatch error", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  };
