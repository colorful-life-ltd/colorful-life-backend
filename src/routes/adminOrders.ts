import {logOperationalError} from "../utils/operationalLog.js";
import {prisma} from "../prisma/runtime.js";
import {z} from "zod";
import {cancelFullyRefundedOrder,requestPaidCancellation,withdrawPaidCancellation} from "../domain/orders/paidCancellation.js";
import {RefundIntentError} from "../domain/refunds/refundLifecycleService.js";
import { Router, type Request, type Response } from "express";
import { authMiddleware } from "../middleware/auth.js";
import { sendApiError } from "../utils/apiErrorResponse.js";
import { AdminOrderIdSchema, AdminOrderQuerySchema } from "../domain/orders/adminOrderValidator.js";
import { getAdminOrder, listAdminOrders } from "../domain/orders/orderReadService.js";
import { DispatchShipmentSchema, StartPreparingSchema } from "../domain/fulfilment/fulfilmentValidator.js";
import { dispatchShipment, startPreparing } from "../domain/fulfilment/fulfilmentService.js";
import {
  FulfilmentOrderNotFoundError,
  FulfilmentPaymentNotVerifiedError,
  FulfilmentTransitionError,
  OrderAlreadyDispatchedError,
} from "../domain/fulfilment/fulfilmentErrors.js";

const router = Router();
router.use(authMiddleware, (req, res, next) => {
  if (req.user?.role !== "ADMIN") return sendApiError(res, 403, "FORBIDDEN", "Forbidden: ADMIN only");
  next();
});
router.post('/:orderId/request-paid-cancellation',async(req,res)=>{
 const id=AdminOrderIdSchema.safeParse(req.params.orderId);const body=z.object({reason:z.string().trim().min(10).max(1000)}).strict().safeParse(req.body);
 if(!id.success||!body.success)return res.status(400).json({error:'INVALID_CANCELLATION'});
 try{res.json(await requestPaidCancellation(req.user!.id,id.data,body.data.reason,req.get('Idempotency-Key')??''));}
 catch(e){if(e instanceof RefundIntentError)return res.status(e.httpStatus).json({error:e.code});res.status(503).json({error:'CANCELLATION_UNAVAILABLE'});}
});
router.post('/:orderId/withdraw-paid-cancellation',async(req,res)=>{
 const id=AdminOrderIdSchema.safeParse(req.params.orderId);
 const body=z.object({requestId:z.string().regex(/^[1-9][0-9]{0,18}$/),reason:z.string().trim().min(10).max(1000)}).strict().safeParse(req.body);
 if(!id.success||!body.success)return res.status(400).json({error:'INVALID_CANCELLATION'});
 try{res.json(await withdrawPaidCancellation(req.user!.id,id.data,body.data.requestId,body.data.reason,req.get('Idempotency-Key')??''));}
 catch(e){if(e instanceof RefundIntentError)return res.status(e.httpStatus).json({error:e.code});res.status(503).json({error:'CANCELLATION_UNAVAILABLE'});}
});
router.post('/:orderId/cancel-refunded',async(req,res)=>{
 const id=AdminOrderIdSchema.safeParse(req.params.orderId);const body=z.object({reason:z.string().trim().min(10).max(1000)}).strict().safeParse(req.body);
 if(!id.success||!body.success)return res.status(400).json({error:'INVALID_CANCELLATION'});
 try{res.json(await cancelFullyRefundedOrder(req.user!.id,id.data,body.data.reason,req.get('Idempotency-Key')??''));}
 catch(e){if(e instanceof RefundIntentError)return res.status(e.httpStatus).json({error:e.code});res.status(503).json({error:'CANCELLATION_UNAVAILABLE'});}
});
router.get("/", async (req, res) => {
  const query = AdminOrderQuerySchema.safeParse(req.query);
  if (!query.success) return res.status(400).json({ error: query.error.format() });
  try {
    return res.json(await listAdminOrders(query.data));
  } catch (error) {
    logOperationalError("Admin order listing error", error);
    return sendApiError(res, 500, "INTERNAL_SERVER_ERROR", "Internal server error");
  }
});
router.get('/:orderId/audit',async(req,res)=>{
 const id=AdminOrderIdSchema.safeParse(req.params.orderId);
 if(!id.success)return res.status(400).json({error:'INVALID_ORDER_ID'});
 try{if(!await prisma.order.findUnique({where:{id:id.data},select:{id:true}}))return res.status(404).json({error:'ORDER_NOT_FOUND'});
  res.json(await prisma.$queryRaw`SELECT id::text,kind,"actorId","refundId",revision,details,"createdAt" FROM "OperationalAudit" WHERE "orderId"=${id.data} ORDER BY id DESC LIMIT 100`);
 }catch{res.status(503).json({error:'AUDIT_UNAVAILABLE'});}
});
router.get("/:orderId", async (req, res) => {
  const id = AdminOrderIdSchema.safeParse(req.params.orderId);
  if (!id.success) return res.status(400).json({ error: "Invalid order id" });
  if (Object.keys(req.query).length) return res.status(400).json({ error: "Unexpected query parameters" });
  try {
    const order = await getAdminOrder(id.data);
    if (!order) return res.status(404).json({ error: "Order not found" });
    return res.json(order);
  } catch (error) {
    logOperationalError("Admin order read error", error);
    return sendApiError(res, 500, "INTERNAL_SERVER_ERROR", "Internal server error");
  }
});
function sendFulfilmentError(res: Response, error: unknown, operation: string) {
  if (error instanceof FulfilmentOrderNotFoundError) return res.status(404).json({ error: "Order not found" });
  if (error instanceof FulfilmentPaymentNotVerifiedError) return sendApiError(res, 409, error.reason === "REFUND_REVIEW_REQUIRED" ? "REFUND_REVIEW_REQUIRED" : "ORDER_PAYMENT_NOT_VERIFIED", error.message);
  if (error instanceof FulfilmentTransitionError) return sendApiError(res, 409, "FULFILMENT_TRANSITION_INVALID", error.message);
  if (error instanceof OrderAlreadyDispatchedError) return sendApiError(res, 409, "ORDER_ALREADY_DISPATCHED", error.message);
  logOperationalError(`Admin fulfilment ${operation} error`);
  return sendApiError(res, 500, "INTERNAL_SERVER_ERROR", "Internal server error");
}

// CONFIRMED -> PREPARING. Repeats are idempotent and return the current order.
router.post("/:orderId/fulfilment/preparing", async (req: Request, res: Response) => {
  const id = AdminOrderIdSchema.safeParse(req.params.orderId);
  if (!id.success) return res.status(400).json({ error: "Invalid order id" });
  const body = StartPreparingSchema.safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ error: body.error.format() });
  try {
    await startPreparing(req.user!.id, id.data);
    return res.json(await getAdminOrder(id.data));
  } catch (error) {
    return sendFulfilmentError(res, error, "preparing");
  }
});

// CONFIRMED/PREPARING -> DISPATCHED with one trusted-carrier shipment.
router.post("/:orderId/fulfilment/dispatch", async (req: Request, res: Response) => {
  const id = AdminOrderIdSchema.safeParse(req.params.orderId);
  if (!id.success) return res.status(400).json({ error: "Invalid order id" });
  const body = DispatchShipmentSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.format() });
  try {
    await dispatchShipment(req.user!.id, id.data, body.data);
    const order = await getAdminOrder(id.data);
    return res.json(order);
  } catch (error) {
    return sendFulfilmentError(res, error, "dispatch");
  }
});

export default router;
