import {logOperationalError} from "../utils/operationalLog.js";
import { reauthenticate, ReauthenticationRequired } from "../domain/auth/reauthentication.js";
import type { Request, Response } from "express";
import { deleteCustomerAccount } from "../domain/auth/accountDeletionService.js";
import {
  AccountDeletionAdminNotAllowedError,
  AccountDeletionUserNotFoundError,
} from "../domain/auth/accountDeletionErrors.js";
import { sendApiError } from "../utils/apiErrorResponse.js";

export const deleteCurrentUserAccount = async (req: Request, res: Response) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const hash=await reauthenticate(userId,req.body?.password);
    await deleteCustomerAccount(userId,new Date(),hash);
    return res.status(204).send();
  } catch (error) {
    if(error instanceof ReauthenticationRequired)return res.status(403).json({error:"REAUTHENTICATION_REQUIRED"});
    if (error instanceof AccountDeletionUserNotFoundError) {
      return res.status(404).json({ error: "User not found" });
    }
    if (error instanceof AccountDeletionAdminNotAllowedError) {
      return sendApiError(res, 403, "FORBIDDEN", "Not allowed");
    }
    logOperationalError("Account deletion error", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};
