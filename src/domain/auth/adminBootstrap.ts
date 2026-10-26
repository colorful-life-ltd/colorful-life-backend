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
/** One-off, privileged CLI operation; never exposed as HTTP. Ends temporary administrator access: the
 * role is read from the database on every request, and credential rotation and session revocation
 * invalidate existing tokens. Serialized with bootstrap so a promotion and demotion cannot interleave. */
export async function demoteAdmin(userId: number, reason: string, operatorReference: string, db: Pick<typeof prisma, '$transaction'> = prisma) {
    if (!Number.isSafeInteger(userId) || userId < 1 || reason.trim().length < 10 || reason.length > 500 || operatorReference.length < 5 || operatorReference.length > 128)
        throw Error('User ID, reason and operator reference required');
    return db.$transaction(async (tx) => {
        await tx.$executeRaw `SELECT pg_advisory_xact_lock(hashtextextended('first-admin-bootstrap',0))`;
        const updated = await tx.user.updateMany({ where: { id: userId, deletedAt: null, role: 'ADMIN' }, data: { role: 'CUSTOMER', credentialVersion: randomUUID() } });
        if (updated.count !== 1)
            throw Error('An active administrator is required');
        await tx.refreshSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
        await tx.$executeRaw `INSERT INTO "OperationalAudit" (kind,"actorId",details) VALUES ('ADMIN_DEMOTED',${userId},${JSON.stringify({ source: 'one-off-cli', reason, operatorReference })}::jsonb)`;
    });
}
