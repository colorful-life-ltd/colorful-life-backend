import {logOperationalError} from "../utils/operationalLog.js";
import type { Request, Response } from "express";
import { BusinessExpenseCreateSchema } from "../domain/businessExpenseValidator.js";
import { prisma } from "../prisma/runtime.js";
import { sendApiError } from "../utils/apiErrorResponse.js";

/**
 * POST /business-expenses
 * Create a new business expense. Only ADMIN users are allowed.
 */
export const createBusinessExpense = async (req: Request, res: Response) => {
  const userRole = (req.user as { role: string }).role;
  if (userRole !== "ADMIN") {
    return sendApiError(res, 403, "FORBIDDEN", "Forbidden: ADMIN only");
  }

  const parseResult = BusinessExpenseCreateSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ error: parseResult.error.format() });
  }

  const { category, amount, incurredAt, description } = parseResult.data;
  try {
    const expense = await prisma.businessExpense.create({
      data: {
        category,
        amount,
        incurredAt,
        description,
        sourceType: "MANUAL",
        sourceId: null,
      },
    });
    return res.status(201).json(expense);
  } catch (err: unknown) {
    logOperationalError("Business expense creation error", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};

/**
 * GET /business-expenses
 * List all business expenses ordered by incurredAt descending.
 */
export const listBusinessExpenses = async (req: Request, res: Response) => {
  const userRole = (req.user as { role: string }).role;
  if (userRole !== "ADMIN") {
    return sendApiError(res, 403, "FORBIDDEN", "Forbidden: ADMIN only");
  }
  try {
    const expenses = await prisma.businessExpense.findMany({
      orderBy: { incurredAt: "desc" },
    });
    return res.json(expenses);
  } catch (err: unknown) {
    logOperationalError("Business expense listing error", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};
