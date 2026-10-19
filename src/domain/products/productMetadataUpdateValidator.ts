import { z } from "zod";

export const productMetadataUpdateFields = {
  setNumber: z.string().nonempty({ message: "setNumber cannot be empty" }),
  title: z.string().nonempty({ message: "title cannot be empty" }),
  description: z.string(),
  theme: z.string().nonempty({ message: "theme cannot be empty" }),
  ageRecommendation: z.string().nonempty({ message: "ageRecommendation cannot be empty" }),
  pieceCount: z.number().int().positive({ message: "pieceCount must be a positive integer" }),
  isRetired: z.boolean(),
  isPublished: z.boolean(),
  permanentDiscontinuationConfirmed: z.boolean(),
  restockExpectationConfirmed: z.boolean(),
  discontinuationReversalConfirmed: z.boolean(),
  availabilityReason: z.string().trim().min(10).max(1000),
  availabilityState: z.enum(["STANDARD", "MORE_ON_THE_WAY", "DISCONTINUED"]),
  categoryId: z.number().int().positive(),
};

export const ProductMetadataUpdateSchema = z.object(productMetadataUpdateFields).partial().strict();

export type ProductMetadataUpdate = z.infer<typeof ProductMetadataUpdateSchema>;
