import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { z } from "zod";
import { prisma } from "../../prisma/runtime.js";
import type { Prisma } from "../../generated/prisma-client/client.js";
import {
  ReturnReason,
  ReturnShippingPayer,
} from "../../generated/prisma-client/enums.js";
import {
  lockReturnScope,
  assertReturnInventoryEligible,
  assertNewReturnAdmission,
  hasConfirmedReturnDispatch,
  OrderReturnEligibilityError,
} from "./returnInventorySafety.js";
import {
  requestOrderReturn,
  authorizeOrderReturn,
  receiveOrderReturn,
  cancelOrderReturn,
  inspectOrderReturn,
  completeOrderReturn,
} from "./orderReturnService.js";
import { OrderReturnInspectionSchema } from "./orderReturnInspectionValidator.js";

export const RETURN_ADDRESS = [
  "Colorful Life Ltd",
  "3 Hawthorne Drive",
  "Bolton upon Dearne",
  "S63 8NS",
  "United Kingdom",
];
export const DEFAULT_RETURN_INSTRUCTIONS =
  "Pack the goods securely and include your return reference and the items being returned. Keep proof of postage. Contact support@build-and-bloom.co.uk if you need help. Your statutory rights are unaffected.";
export const submissionSchema = z
  .object({
    idempotencyKey: z.string().uuid(),
    lines: z
      .array(
        z
          .object({
            orderItemId: z.number().int().positive(),
            quantity: z.number().int().positive().max(10000),
            reason: z.nativeEnum(ReturnReason).default("CHANGE_OF_MIND"),
            reasonNote: z.string().trim().max(2000).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict()
  .refine(
    (input) =>
      new Set(input.lines.map((l) => l.orderItemId)).size ===
      input.lines.length,
    "Select each order item once",
  );
export const authorizationSchema = z
  .object({
    shippingPayer: z.nativeEnum(ReturnShippingPayer),
    postageInstructions: z.string().trim().min(10).max(2000),
    instructions: z
      .string()
      .trim()
      .min(10)
      .max(4000)
      .default(DEFAULT_RETURN_INSTRUCTIONS),
    rightsReviewed: z.literal(true),
  })
  .strict();
export const rejectionSchema = z
  .object({
    ground: z.enum([
      "OUTSIDE_CANCELLATION_PERIOD",
      "NO_NONCONFORMITY",
      "CUSTOMER_DAMAGE",
      "OTHER",
    ]),
    note: z.string().trim().min(10).max(2000),
    rightsReviewed: z.literal(true),
  })
  .strict();
export const receiptSchema = z
  .object({
    receivedAt: z.iso.datetime(),
    note: z.string().trim().min(1).max(2000),
  })
  .strict();
export const cancellationSchema = z
  .object({ note: z.string().trim().min(1).max(2000) })
  .strict();
export class ReturnManagementError extends Error {
  constructor(
    public code: string,
    public status = 409,
  ) {
    super(code);
  }
}
const caseInclude = {
  submissions: {
    orderBy: [{ requestedAt: "asc" }, { id: "asc" }],
    include: { lines: { orderBy: { id: "asc" } } },
  },
} satisfies Prisma.ReturnCaseInclude;
async function ownedOrder(
  tx: Prisma.TransactionClient,
  orderId: number,
  userId?: number,
) {
  const order = await tx.order.findFirst({
    where: { id: orderId, ...(userId !== undefined ? { userId } : {}) },
    include: {
      user: {
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          deletedAt: true,
          emailVerified: true,
        },
      },
      orderItems: {
        include: { productListing: { include: { legoProduct: true } } },
      },
    },
  });
  if (!order || (userId !== undefined && order.user.deletedAt))
    throw new ReturnManagementError("ORDER_NOT_FOUND", 404);
  return order;
}
async function ensureCase(tx: Prisma.TransactionClient, orderId: number) {
  return (
    (await tx.returnCase.findUnique({ where: { orderId } })) ??
    tx.returnCase.create({ data: { orderId, reference: `BB-R-${orderId}` } })
  );
}
async function audit(
  tx: Prisma.TransactionClient,
  orderId: number,
  actorId: number,
  action: string,
  details: Prisma.InputJsonObject,
) {
  await tx.operationalAudit.create({
    data: { kind: `RETURN_${action}`, orderId, actorId, details },
  });
}
/** Caller holds Order first. Snapshot contains customer-visible data only, never operator notes/IDs. */
export async function readReturnCase(
  tx: Prisma.TransactionClient,
  orderId: number,
  userId?: number,
) {
  const order = await ownedOrder(tx, orderId, userId);
  const returnCase = await tx.returnCase.findUnique({
    where: { orderId },
    include: caseInclude,
  });
  const items = [];
  for (const item of order.orderItems) {
    let eligible = true;
    try {
      await assertNewReturnAdmission(tx, orderId);
      await assertReturnInventoryEligible(tx, orderId, item.id);
    } catch (e) {
      if (!(e instanceof OrderReturnEligibilityError)) throw e;
      eligible = false;
    }
    items.push({
      id: item.id,
      name:
        item.invoiceDescriptionSnapshot ||
        item.productListing.legoProduct.title,
      quantity: item.quantity,
      remainingQuantity: eligible
        ? Math.max(
            0,
            item.quantity - item.returnedQuantity - item.reservedReturnQuantity,
          )
        : 0,
      condition: item.conditionSnapshot,
    });
  }
  const notifications =
    userId === undefined
      ? await tx.orderConfirmationJob.findMany({
          where: { orderId, type: "RETURN_AUTHORIZATION" },
          select: { eventKey: true, state: true, lastErrorCode: true },
        })
      : [];
  const submissions =
    returnCase?.submissions.map((s) => ({
      id: s.id,
      requestedAt: s.requestedAt,
      lines: s.lines.map((l) => ({
        id: l.id,
        orderItemId: l.orderItemId,
        quantity: l.quantity,
        reason: l.reason,
        reasonNote: l.reasonNote,
        status: l.status,
        requestedAt: l.requestedAt,
        authorizedAt: l.authorizedAt,
        receivedAt: l.receivedAt,
        inspectedAt: l.inspectedAt,
        completedAt: l.completedAt,
        rejectedAt: l.rejectedAt,
        cancelledAt: l.cancelledAt,
        rejectionNote: l.rejectionNote,
        shippingPayer: l.shippingPayer,
        instructions: l.instructions,
        ...(userId === undefined
          ? {
              notification:
                notifications.find((n) => n.eventKey === `return:${l.id}`) ??
                null,
              receiptNote: l.receiptNote,
              receivedByUserId: l.receivedByUserId,
              decisionByUserId: l.decisionByUserId,
              inspectionNote: l.inspectionNote,
              condition: l.condition,
              restockQuantity: l.restockQuantity,
            }
          : {}),
      })),
    })) ?? [];
  return {
    orderId,
    reference: returnCase?.reference ?? null,
    caseId: returnCase?.id ?? null,
    items,
    submissions,
    ...(userId === undefined
      ? {
          customer: order.user.deletedAt
            ? {
                id: order.user.id,
                email: null,
                firstName: null,
                lastName: null,
                deleted: true,
              }
            : {
                id: order.user.id,
                email: order.user.email,
                firstName: order.user.firstName,
                lastName: order.user.lastName,
                deleted: false,
              },
          defaultInstructions: {
            address: RETURN_ADDRESS,
            instructions: DEFAULT_RETURN_INSTRUCTIONS,
          },
        }
      : {}),
  };
}
export async function customerReturnCase(orderId: number, userId: number) {
  return prisma.$transaction((tx) => readReturnCase(tx, orderId, userId), {
    isolationLevel: "RepeatableRead",
  });
}
export async function adminReturnCase(orderId: number) {
  return prisma.$transaction((tx) => readReturnCase(tx, orderId), {
    isolationLevel: "RepeatableRead",
  });
}
export async function submitReturns(
  orderId: number,
  actorId: number,
  input: z.infer<typeof submissionSchema>,
  admin = false,
) {
  return prisma.$transaction(async (tx) => {
    await lockReturnScope(tx, orderId);
    const order = await ownedOrder(tx, orderId, admin ? undefined : actorId);
    if (order.user.deletedAt)
      throw new ReturnManagementError("ACCOUNT_DELETED");
    if (!hasConfirmedReturnDispatch(order))
      throw new ReturnManagementError("DISPATCH_REQUIRED_USE_CANCELLATION");
    await assertNewReturnAdmission(tx, orderId);
    const returnCase = await ensureCase(tx, orderId);
    const requestHash = createHash("sha256")
      .update(
        JSON.stringify({
          actorId,
          lines: [...input.lines].sort((a, b) => a.orderItemId - b.orderItemId),
        }),
      )
      .digest("hex");
    const prior = await tx.returnSubmission.findUnique({
      where: {
        caseId_idempotencyKey: {
          caseId: returnCase.id,
          idempotencyKey: input.idempotencyKey,
        },
      },
    });
    if (prior) {
      if (prior.requestHash !== requestHash)
        throw new ReturnManagementError("IDEMPOTENCY_KEY_REUSED");
      return readReturnCase(tx, orderId, admin ? undefined : actorId);
    }
    const submission = await tx.returnSubmission.create({
      data: {
        caseId: returnCase.id,
        idempotencyKey: input.idempotencyKey,
        requestHash,
      },
    });
    for (const line of [...input.lines].sort(
      (a, b) => a.orderItemId - b.orderItemId,
    ))
      await requestOrderReturn(
        orderId,
        line.orderItemId,
        line.quantity,
        line.reason,
        line.reasonNote,
        null,
        undefined,
        actorId,
        tx,
        submission.id,
      );
    await audit(tx, orderId, actorId, "REQUESTED", {
      submissionId: submission.id,
      lineCount: input.lines.length,
    });
    return readReturnCase(tx, orderId, admin ? undefined : actorId);
  });
}
export async function returnAction(
  orderId: number,
  lineId: number,
  actorId: number,
  action: string,
  body: unknown,
  customer = false,
) {
  return prisma.$transaction(async (tx) => {
    await lockReturnScope(tx, orderId, lineId);
    const order = await ownedOrder(tx, orderId, customer ? actorId : undefined);
    const line = await tx.orderReturn.findFirst({
      where: { id: lineId, orderItem: { orderId } },
      include: { submission: { include: { returnCase: true } } },
    });
    if (!line) throw new ReturnManagementError("RETURN_NOT_FOUND", 404);
    if (action !== "cancel") await assertNewReturnAdmission(tx, orderId);
    if (customer && action !== "cancel")
      throw new ReturnManagementError("FORBIDDEN", 403);
    let auditDetails: Prisma.InputJsonObject = { lineId };
    if (action === "authorize") {
      const input = authorizationSchema.parse(body);
      if (order.user.deletedAt)
        throw new ReturnManagementError("ACCOUNT_DELETED");
      if (
        ["DAMAGED", "DEFECTIVE", "WRONG_ITEM", "NOT_AS_DESCRIBED"].includes(
          line.reason,
        ) &&
        input.shippingPayer !== "SELLER"
      )
        throw new ReturnManagementError("SELLER_POSTAGE_REQUIRED");
      const instructions = {
        address: RETURN_ADDRESS,
        instructions: input.instructions,
        postageInstructions: input.postageInstructions,
        shippingPayer: input.shippingPayer,
        reference: line.submission?.returnCase.reference ?? `BB-R-${orderId}`,
      };
      if (line.status === "AUTHORIZED") {
        if (!isDeepStrictEqual(line.instructions, instructions))
          throw new ReturnManagementError("AUTHORIZATION_ALREADY_RECORDED");
        return readReturnCase(tx, orderId, customer ? actorId : undefined);
      }
      await authorizeOrderReturn(orderId, lineId, tx);
      await tx.orderReturn.update({
        where: { id: lineId },
        data: {
          instructions,
          shippingPayer: input.shippingPayer,
          decisionByUserId: actorId,
        },
      });
      const source = {
        version: 1,
        orderId,
        returnId: lineId,
        recipientEmail: order.user.emailVerified ? order.user.email : null,
        quantity: line.quantity,
        itemName:
          order.orderItems.find((i) => i.id === line.orderItemId)!
            .invoiceDescriptionSnapshot ||
          order.orderItems.find((i) => i.id === line.orderItemId)!
            .productListing.legoProduct.title,
        ...instructions,
      };
      await tx.orderConfirmationJob.create({
        data: {
          orderId,
          type: "RETURN_AUTHORIZATION",
          eventKey: `return:${lineId}`,
          source,
          state: source.recipientEmail ? "PENDING" : "BLOCKED",
          lastErrorCode: source.recipientEmail ? null : "RECIPIENT_UNAVAILABLE",
        },
      });
    } else if (action === "reject") {
      const input = rejectionSchema.parse(body);
      if (
        input.ground === "OUTSIDE_CANCELLATION_PERIOD" &&
        line.reason !== "CHANGE_OF_MIND"
      )
        throw new ReturnManagementError(
          "FAULT_CLAIM_REQUIRES_INDEPENDENT_REVIEW",
        );
      const note = `${input.ground}: ${input.note}`;
      if (line.status === "REJECTED" && line.rejectionNote === note)
        return readReturnCase(tx, orderId);
      if (line.status !== "REQUESTED")
        throw new ReturnManagementError("RETURN_NOT_REJECTABLE");
      await cancelOrderReturn(orderId, lineId, tx);
      await tx.orderReturn.update({
        where: { id: lineId },
        data: {
          status: "REJECTED",
          cancelledAt: null,
          rejectedAt: new Date(),
          rejectionNote: note,
          decisionByUserId: actorId,
        },
      });
      auditDetails = { ...auditDetails, ground: input.ground };
    } else if (action === "receive") {
      const input = receiptSchema.parse(body),
        receivedAt = new Date(input.receivedAt);
      if (receivedAt > new Date() || receivedAt < order.createdAt)
        throw new ReturnManagementError("INVALID_RECEIPT_DATE", 400);
      if (
        line.status === "RECEIVED" &&
        line.receivedAt?.getTime() === receivedAt.getTime() &&
        line.receiptNote === input.note
      )
        return readReturnCase(tx, orderId);
      await receiveOrderReturn(orderId, lineId, tx);
      await tx.orderReturn.update({
        where: { id: lineId },
        data: {
          receivedAt,
          receiptNote: input.note,
          receivedByUserId: actorId,
        },
      });
    } else if (action === "cancel") {
      const input = cancellationSchema.parse(body);
      if (line.status === "CANCELLED")
        return readReturnCase(tx, orderId, customer ? actorId : undefined);
      await cancelOrderReturn(orderId, lineId, tx);
      auditDetails = { ...auditDetails, note: input.note };
    } else if (action === "inspect") {
      const input = OrderReturnInspectionSchema.parse(body);
      if (
        line.status === "INSPECTED" &&
        line.condition === input.condition &&
        line.restockQuantity === input.restockQuantity &&
        line.inspectionNote === (input.inspectionNote?.trim() || null)
      )
        return readReturnCase(tx, orderId);
      await inspectOrderReturn(
        orderId,
        lineId,
        input.condition,
        input.restockQuantity,
        input.inspectionNote,
        actorId,
        tx,
      );
    } else if (action === "complete") {
      z.object({}).strict().parse(body);
      if (line.status === "COMPLETED") return readReturnCase(tx, orderId);
      await completeOrderReturn(orderId, lineId, actorId, tx);
    } else throw new ReturnManagementError("INVALID_ACTION", 400);
    await audit(tx, orderId, actorId, action.toUpperCase(), auditDetails);
    return readReturnCase(tx, orderId, customer ? actorId : undefined);
  });
}
export async function listReturnCases(
  status: string | undefined,
  page: number,
  pageSize: number,
) {
  return prisma.$transaction(
    async (tx) => {
      const where: Prisma.ReturnCaseWhereInput = status
        ? {
            submissions: {
              some: {
                lines: {
                  some: {
                    status:
                      status as Prisma.EnumOrderReturnStatusFilter["equals"],
                  },
                },
              },
            },
          }
        : {};
      const [total, cases] = await Promise.all([
        tx.returnCase.count({ where }),
        tx.returnCase.findMany({
          where,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          skip: (page - 1) * pageSize,
          take: pageSize,
          include: {
            order: {
              select: {
                id: true,
                createdAt: true,
                user: {
                  select: {
                    email: true,
                    firstName: true,
                    lastName: true,
                    deletedAt: true,
                  },
                },
              },
            },
            submissions: { include: { lines: { select: { status: true } } } },
          },
        }),
      ]);
      return {
        page,
        pageSize,
        total,
        cases: cases.map((c) => ({
          orderId: c.orderId,
          reference: c.reference,
          createdAt: c.createdAt,
          customer: c.order.user.deletedAt ? null : c.order.user,
          statuses: [
            ...new Set(
              c.submissions.flatMap((s) => s.lines.map((l) => l.status)),
            ),
          ],
        })),
      };
    },
    { isolationLevel: "RepeatableRead" },
  );
}
