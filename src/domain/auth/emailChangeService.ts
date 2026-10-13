import { Prisma } from "../../generated/prisma-client/client.js";
import { prisma } from "../../prisma/runtime.js";
import { createOrReplaceEmailVerificationToken } from "./emailVerificationService.js";
import {
  EmailChangeDuplicateEmailError,
  EmailChangeSameEmailError,
  EmailChangeUserNotFoundError,
  EmailChangeVerifiedUserError,
} from "./emailChangeErrors.js";

export async function changeUnverifiedUserEmail(userId: number, normalizedEmail: string, now = new Date()) {
  try {
    return await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: number }>>`
        SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE
      `;
      if (locked.length !== 1) throw new EmailChangeUserNotFoundError();

      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { id: true, email: true, emailVerified: true },
      });
      if (!user) throw new EmailChangeUserNotFoundError();
      if (user.emailVerified) throw new EmailChangeVerifiedUserError();
      if (user.email === normalizedEmail) throw new EmailChangeSameEmailError();

      // Reset links sent to the previous address must not retain authority after a change.
      await tx.passwordResetToken.deleteMany({ where: { userId } });
      await tx.user.update({ where: { id: userId }, data: { email: normalizedEmail } });
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
