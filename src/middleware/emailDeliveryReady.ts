import type { RequestHandler } from "express";
import { emailCredentialReadiness } from "../services/sesRuntime.js";
import { sendApiError } from "../utils/apiErrorResponse.js";

/**
 * Refuses signup before abuse protection or any account/token write when SES credentials
 * are unavailable or expired. Customers receive a generic retryable message; the reason
 * code is logged by the credential layer only. Passing this check is credential readiness,
 * not a delivery guarantee: the handler still treats the send itself as fallible.
 */
export const signupEmailReady: RequestHandler = async (_req, res, next) => {
  try {
    if ((await emailCredentialReadiness("signup")).ready) return next();
  } catch { /* fail closed below */ }
  res.setHeader("Retry-After", "300");
  return sendApiError(res, 503, "REGISTRATION_TEMPORARILY_UNAVAILABLE",
    "Account registration is temporarily unavailable. Please try again later.");
};

/** Authenticated account email flows (verification resend, email change): no enumeration surface. */
export const accountEmailReady: RequestHandler = async (_req, res, next) => {
  try {
    if ((await emailCredentialReadiness("account")).ready) return next();
  } catch { /* fail closed below */ }
  return sendEmailUnavailable(res);
};

export function sendEmailUnavailable(res: Parameters<RequestHandler>[1]) {
  res.setHeader("Retry-After", "300");
  return sendApiError(res, 503, "EMAIL_DELIVERY_UNAVAILABLE",
    "We can't send account emails right now. Please try again later.");
}
