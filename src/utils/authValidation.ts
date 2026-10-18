import { z } from "zod";

/**
 * Password validation rules:
 *   • Minimum 8 characters (enforced by Zod's .min(8))
 *   • At least one lowercase letter
 *   • At least one uppercase letter
 *   • At least one numeric digit
 *   • At least one special character
 *
 * The regex uses a positive‑lookahead for each requirement.  It is kept
 * intentionally simple and does not enforce any Unicode properties.
 */
export const passwordSchema = z
  .string()
  .min(8, { message: "Password must be at least 8 characters long" })
  .regex(/[a-z]/, { message: "Password must contain a lowercase letter" })
  .regex(/[A-Z]/, { message: "Password must contain an uppercase letter" })
  .regex(/[0-9]/, { message: "Password must contain a digit" })
  .regex(/[^A-Za-z0-9]/, { message: "Password must contain a special character" })
  .refine(password => Buffer.byteLength(password, "utf8") <= 72, {
    message: "Password must not exceed 72 UTF-8 bytes",
  });

/**
 * Signup request validation schema.
 */
  export const signupSchema = z.object({
    // Normalize by trimming whitespace and converting to lowercase *before*
    // email validation. Zod applies transforms prior to refinement.
    email: z
      .string()
      .trim()
      .toLowerCase()
      .email(),
    password: passwordSchema,
  });

export const verifyEmailSchema = z.object({
  token: z.string().trim().min(1),
});

export const forgotPasswordSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
});

export const changeEmailSchema = z.object({
  password: z.string().max(72).optional(),
  email: z.string().trim().toLowerCase().email(),
});

export const resetPasswordSchema = z.object({
  token: z.string().trim().min(1),
  newPassword: passwordSchema,
});

/**
 * Login request validation schema.
 */
  export const loginSchema = z.object({
    email: z
      .string()
      .trim()
      .toLowerCase()
      .email(),
    password: z.string(),
  });
