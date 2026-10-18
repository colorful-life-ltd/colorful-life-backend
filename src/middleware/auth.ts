import {logOperationalError} from "../utils/operationalLog.js";
import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { config } from "../config/index.js";
import { prisma } from "../prisma/runtime.js";
import { sendApiError } from "../utils/apiErrorResponse.js";

type AuthenticatedUser = { id: number; role: string; credentialVersion?: string | null; deletedAt: Date | null };
type AuthenticatedUserLookup = (userId: number) => Promise<AuthenticatedUser | null>;

const databaseUserLookup: AuthenticatedUserLookup = (userId) =>
  prisma.user.findUnique({ where: { id: userId }, select: { id: true, role: true, deletedAt: true, credentialVersion: true } });

let lookupUser: AuthenticatedUserLookup = databaseUserLookup;

export const authMiddleware = async (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers["authorization"];
  const bearerMatch = authHeader?.match(/^Bearer\s+(\S+)$/i);
  if (!bearerMatch) {
    return sendApiError(res, 401, "AUTH_REQUIRED", "Missing or invalid authorization header");
  }

  let payload: unknown;
  try {
    payload = jwt.verify(bearerMatch[1], config.JWT_SECRET);
  } catch (_error) {
    return sendApiError(res, 401, "SESSION_INVALID", "Invalid or expired token");
  }

  const userId = typeof payload === "object" && payload !== null && "id" in payload
    ? (payload as { id?: unknown }).id
    : undefined;
  if (typeof userId !== "number" || !Number.isInteger(userId) || userId < 1) {
    return sendApiError(res, 401, "SESSION_INVALID", "Invalid or expired token");
  }

  let user: AuthenticatedUser | null;
  try {
    user = await lookupUser(userId);
  } catch (error) {
    logOperationalError("Authentication user lookup failed", error);
    return sendApiError(res, 500, "INTERNAL_SERVER_ERROR", "Internal server error");
  }

  if (!user || user.deletedAt !== null) {
    return sendApiError(res, 401, "SESSION_INVALID", "Invalid or expired token");
  }

  const version = typeof payload === "object" && payload !== null && "credentialVersion" in payload
    ? (payload as { credentialVersion?: unknown }).credentialVersion : null;
  if ((version ?? null) !== (user.credentialVersion ?? null)) {
    return sendApiError(res, 401, "SESSION_INVALID", "Invalid or expired token");
  }

  // The database is authoritative: JWT role claims can become stale after a role change.
  req.user = { id: user.id, role: user.role };
  return next();
};

export function setAuthenticatedUserLookupForTests(testLookup: AuthenticatedUserLookup): () => void {
  const previous = lookupUser;
  lookupUser = testLookup;
  return () => { lookupUser = previous; };
}
