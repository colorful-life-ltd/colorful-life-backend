import { z } from "zod";

const positiveInteger = (max: number) => z.preprocess(
  (value) => typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value,
  z.number().int().positive().max(max),
);

export const AdminProductListingQuerySchema = z.object({
  page: positiveInteger(10_000).default(1),
  pageSize: positiveInteger(50).default(20),
  // Optional set-number or title search for operator workflows; matches inactive listings too.
  q: z.string().trim().min(1).max(100).optional(),
}).strict();

export type AdminProductListingQuery = z.infer<typeof AdminProductListingQuerySchema>;
