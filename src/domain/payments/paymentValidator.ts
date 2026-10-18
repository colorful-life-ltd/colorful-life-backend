import { z } from "zod"

// The POST body for creating a payment only requires the providerReference.
// orderId is part of the URL; we still expose it in the validator for clarity
// but it is not part of the body.

export const CreatePaymentSchema = z.object({
  reason:z.string().trim().min(10).max(1000).optional(),
  evidenceReference:z.string().trim().min(5).max(256).optional(),
  providerReference: z.string().trim().min(1, { message: "providerReference cannot be empty" }),
})

export type CreatePaymentInput = z.infer<typeof CreatePaymentSchema>
