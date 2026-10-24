import type { RequestHandler } from "express";
import { config } from "../config/index.js";
import { sendApiError } from "../utils/apiErrorResponse.js";

/**
 * Public self-registration is closed unless REGISTRATION_ENABLED=true. Runs before abuse
 * protection so a closed signup writes nothing (no account, token or rate-limit row).
 * Existing accounts can still sign in and recover passwords.
 */
export const registrationOpen: RequestHandler = (_req, res, next) => {
  if (!config.REGISTRATION_ENABLED) {
    return sendApiError(res, 403, "REGISTRATION_DISABLED", "Account registration is not open yet.");
  }
  next();
};
