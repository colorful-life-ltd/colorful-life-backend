import { z } from "zod";

const positiveInteger = (max: number) => z.preprocess(
  (value) => typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value,
  z.number().int().positive().max(max),
);

export const AdminOrderQuerySchema = z.object({
  page: positiveInteger(10_000).default(1),
  pageSize: positiveInteger(50).default(20),
}).strict();
export const AdminOrderIdSchema = z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().positive().max(2_147_483_647));
export type AdminOrderQuery = z.infer<typeof AdminOrderQuerySchema>;
