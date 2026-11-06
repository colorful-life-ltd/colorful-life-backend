import { randomUUID } from 'node:crypto';
import { prisma } from '../../prisma/runtime.js';
/** One-off, privileged CLI operation; never exposed as HTTP. */
export async function bootstrapFirstAdmin(userId: number, reason: string, operatorReference: string, db: Pick<typeof prisma, '$transaction'> = prisma) {
    if (!Number.isSafeInteger(userId) || userId < 1 || reason.trim().length < 10 || reason.length > 500 || operatorReference.length < 5 || operatorReference.length > 128)
        throw Error('Verified user ID, reason and operator reference required');
    return db.$transaction(async (tx) => {
        await tx.$executeRaw `SELECT pg_advisory_xact_lock(hashtextextended('first-admin-bootstrap',0))`;
        if (await tx.user.count({ where: { role: 'ADMIN', deletedAt: null } }))
            throw Error('An active administrator already exists');
        const updated = await tx.user.updateMany({ where: { id: userId, deletedAt: null, emailVerified: true, role: 'CUSTOMER' }, data: { role: 'ADMIN', credentialVersion: randomUUID() } });
        if (updated.count !== 1)
            throw Error('An active verified customer is required');
        await tx.refreshSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
        await tx.$executeRaw `INSERT INTO "OperationalAudit" (kind,"actorId",details) VALUES ('FIRST_ADMIN_BOOTSTRAP',${userId},${JSON.stringify({ source: 'one-off-cli', reason, operatorReference })}::jsonb)`;
    });
}
