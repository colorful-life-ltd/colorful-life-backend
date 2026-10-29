import {
  Router,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth.js";
import { requireVerifiedEmail } from "../middleware/requireVerifiedEmail.js";
import { OrderReturnStatus } from "../generated/prisma-client/enums.js";
import {
  ReturnManagementError,
  submissionSchema,
  submitReturns,
  customerReturnCase,
  adminReturnCase,
  listReturnCases,
  returnAction,
} from "../domain/orders/returnManagement.js";
const id = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);
function handler(run: (req: Request, res: Response) => Promise<unknown>) {
  return async (req: Request, res: Response) => {
    try {
      await run(req, res);
    } catch (error) {
      if (error instanceof z.ZodError)
        return res.status(400).json({ error: "INVALID_RETURN_INPUT" });
      if (error instanceof ReturnManagementError)
        return res.status(error.status).json({ error: error.code });
      const name = error instanceof Error ? error.name : "";
      if (name === "OrderReturnEligibilityError")
        return res.status(409).json({ error: "ORDER_RETURN_INELIGIBLE" });
      if (
        [
          "OrderNotFoundError",
          "OrderItemNotFoundError",
          "OrderReturnNotFoundError",
        ].includes(name)
      )
        return res.status(404).json({ error: "RETURN_NOT_FOUND" });
      if (name.startsWith("Invalid"))
        return res.status(400).json({ error: "INVALID_RETURN_INPUT" });
      if (name.startsWith("OrderReturn"))
        return res.status(409).json({ error: "RETURN_TRANSITION_REFUSED" });
      console.error(
        JSON.stringify({
          event: "return_operation_failed",
          category: "UNEXPECTED",
        }),
      );
      return res.status(503).json({ error: "RETURN_UNAVAILABLE" });
    }
  };
}
export const customerReturns = Router();
customerReturns.get(
  "/:orderId/return-case",
  authMiddleware,
  requireVerifiedEmail,
  handler(async (req, res) =>
    res.json(
      await customerReturnCase(id.parse(req.params.orderId), req.user!.id),
    ),
  ),
);
customerReturns.post(
  "/:orderId/return-requests",
  authMiddleware,
  requireVerifiedEmail,
  handler(async (req, res) =>
    res
      .status(201)
      .json(
        await submitReturns(
          id.parse(req.params.orderId),
          req.user!.id,
          submissionSchema.parse(req.body),
        ),
      ),
  ),
);
customerReturns.post(
  "/:orderId/return-requests/:returnId/cancel",
  authMiddleware,
  requireVerifiedEmail,
  handler(async (req, res) =>
    res.json(
      await returnAction(
        id.parse(req.params.orderId),
        id.parse(req.params.returnId),
        req.user!.id,
        "cancel",
        req.body,
        true,
      ),
    ),
  ),
);
export const adminReturns = Router();
adminReturns.use(
  authMiddleware,
  (req: Request, res: Response, next: NextFunction) => {
    if (req.user?.role !== "ADMIN")
      return res.status(403).json({ error: "FORBIDDEN" });
    next();
  },
);
adminReturns.get(
  "/",
  handler(async (req, res) => {
    const q = z
      .object({
        status: z.nativeEnum(OrderReturnStatus).optional(),
        page: z.coerce.number().int().min(1).max(100000).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(25),
      })
      .strict()
      .parse(req.query);
    return res.json(await listReturnCases(q.status, q.page, q.pageSize));
  }),
);
adminReturns.get(
  "/:orderId",
  handler(async (req, res) =>
    res.json(await adminReturnCase(id.parse(req.params.orderId))),
  ),
);
adminReturns.post(
  "/:orderId/requests",
  handler(async (req, res) =>
    res
      .status(201)
      .json(
        await submitReturns(
          id.parse(req.params.orderId),
          req.user!.id,
          submissionSchema.parse(req.body),
          true,
        ),
      ),
  ),
);
adminReturns.post(
  "/:orderId/lines/:returnId/:action",
  handler(async (req, res) =>
    res.json(
      await returnAction(
        id.parse(req.params.orderId),
        id.parse(req.params.returnId),
        req.user!.id,
        z
          .enum([
            "authorize",
            "reject",
            "receive",
            "cancel",
            "inspect",
            "complete",
          ])
          .parse(req.params.action),
        req.body,
      ),
    ),
  ),
);

/** Preserve legacy admin URLs/line responses, but never bypass the audited notification workflow. */
export const legacyReturnActions = Router();
legacyReturnActions.post(
  "/:orderId/returns/:returnId/:action",
  authMiddleware,
  (req: Request, res: Response, next: NextFunction) => {
    if (req.user?.role !== "ADMIN")
      return res.status(403).json({ error: "FORBIDDEN" });
    next();
  },
  handler(async (req, res) => {
    const orderId = id.parse(req.params.orderId),
      lineId = id.parse(req.params.returnId),
      action = z
        .enum([
          "authorize",
          "reject",
          "receive",
          "cancel",
          "inspect",
          "complete",
        ])
        .parse(req.params.action);
    // Legacy transition endpoints retain their existing duplicate-transition response contract.
    const { prisma } = await import("../prisma/runtime.js");
    const before = await prisma.orderReturn.findFirst({
      where: { id: lineId, orderItem: { orderId } },
      select: { status: true },
    });
    if (
      before &&
      ((action === "authorize" && before.status === "AUTHORIZED") ||
        (action === "receive" && before.status === "RECEIVED") ||
        (action === "inspect" && before.status === "INSPECTED") ||
        (action === "complete" && before.status === "COMPLETED"))
    )
      throw new ReturnManagementError("RETURN_TRANSITION_REFUSED");
    await returnAction(orderId, lineId, req.user!.id, action, req.body ?? {});
    return res.json(
      await prisma.orderReturn.findUniqueOrThrow({ where: { id: lineId } }),
    );
  }),
);
