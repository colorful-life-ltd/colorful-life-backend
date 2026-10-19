import bcrypt from "bcrypt";
import { randomUUID } from "node:crypto";
import { ReauthenticationRequired } from "./reauthentication.js";
import { Prisma } from "../../generated/prisma-client/client.js";
import { prisma } from "../../prisma/runtime.js";
import { createOrReplaceEmailVerificationToken } from "./emailVerificationService.js";
import {
  EmailChangeDuplicateEmailError,
  EmailChangeSameEmailError,
  EmailChangeUserNotFoundError,
  EmailChangeVerifiedUserError,
} from "./emailChangeErrors.js";

export async function changeUnverifiedUserEmail(userId: number, normalizedEmail: string, now = new Date(), password?:string) {
  try {
    return await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: number }>>`
        SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE
      `;
      if (locked.length !== 1) throw new EmailChangeUserNotFoundError();

      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { id: true, email: true, emailVerified: true, passwordHash:true },
      });
      if (!user) throw new EmailChangeUserNotFoundError();
      if(user.emailVerified&&!password)throw new EmailChangeVerifiedUserError();
      if(user.emailVerified&&!await bcrypt.compare(password!,user.passwordHash))throw new ReauthenticationRequired();
      if (user.email === normalizedEmail) throw new EmailChangeSameEmailError();

      // Reset links sent to the previous address must not retain authority after a change.
      await tx.passwordResetToken.deleteMany({ where: { userId } });
      await tx.user.update({ where: { id: userId }, data: { email: normalizedEmail, emailVerified:false, ...(user.emailVerified?{credentialVersion:randomUUID()}:{}) } });
      if(user.emailVerified)await tx.refreshSession.updateMany({where:{userId,revokedAt:null},data:{revokedAt:now}});
      await tx.$executeRaw`INSERT INTO "OperationalAudit" (kind,"actorId",details) VALUES ('EMAIL_CHANGE_REQUESTED',${userId},${JSON.stringify({previouslyVerified:user.emailVerified})}::jsonb)`;
      const verification = await createOrReplaceEmailVerificationToken(userId, now, tx);
      if (!verification.created) throw new EmailChangeVerifiedUserError();
      return { email: normalizedEmail, rawToken: verification.rawToken, expiresAt: verification.expiresAt };
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new EmailChangeDuplicateEmailError();
    }
    throw error;
  }
}
