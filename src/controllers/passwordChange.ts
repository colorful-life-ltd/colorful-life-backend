import { logOperationalError } from "../utils/operationalLog.js";
import type { Request, Response } from 'express';
import bcrypt from 'bcrypt';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { passwordSchema } from '../utils/authValidation.js';
import { reauthenticate, ReauthenticationRequired } from '../domain/auth/reauthentication.js';
import { prisma } from '../prisma/runtime.js';
export async function changePassword(req: Request, res: Response) {
    const input = z.object({ currentPassword: z.string().min(1).max(72), newPassword: passwordSchema }).strict().safeParse(req.body);
    if (!input.success)
        return res.status(400).json({ error: 'INVALID_PASSWORD_CHANGE' });
    try {
        const userId = req.user!.id;
        const previous = await reauthenticate(userId, input.data.currentPassword);
        const passwordHash = await bcrypt.hash(input.data.newPassword, 12);
        await prisma.$transaction(async (tx) => {
            await tx.$queryRaw `SELECT id FROM "User" WHERE id=${userId} FOR UPDATE`;
            const changed = await tx.user.updateMany({ where: { id: userId, passwordHash: previous, deletedAt: null }, data: { passwordHash, credentialVersion: randomUUID() } });
            if (changed.count !== 1)
                throw new ReauthenticationRequired();
            await tx.refreshSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
            await tx.passwordResetToken.deleteMany({ where: { userId } });
            await tx.$executeRaw `INSERT INTO "OperationalAudit" (kind,"actorId",details) VALUES ('PASSWORD_CHANGED',${userId},'{"source":"reauthenticated-self-service"}'::jsonb)`;
        });
        return res.status(204).send();
    }
    catch (error) {
        if (error instanceof ReauthenticationRequired)
            return res.status(403).json({ error: 'REAUTHENTICATION_REQUIRED' });
        logOperationalError('Password change failed', error);
        return res.status(503).json({ error: 'PASSWORD_CHANGE_UNAVAILABLE' });
    }
}
