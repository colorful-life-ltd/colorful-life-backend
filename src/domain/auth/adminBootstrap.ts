import { randomUUID } from 'node:crypto';
import bcrypt from 'bcrypt';
import { Prisma } from '../../generated/prisma-client/client.js';
import { prisma } from '../../prisma/runtime.js';
import { signupSchema } from '../../utils/authValidation.js';
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

export type FirstAdminCreateFailure = 'INVALID_AUDIT' | 'INVALID_CREDENTIALS' | 'ADMIN_EXISTS' | 'EMAIL_IN_USE' | 'CONFLICT';
/** Carries only a fixed code: never the email, password, reason or a database message. */
export class FirstAdminCreateError extends Error {
    constructor(readonly code: FirstAdminCreateFailure) { super(code); this.name = 'FirstAdminCreateError'; }
}
const OPERATOR_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{4,127}$/;
// Printable text only (no control characters), so audit rows and terminals stay unambiguous.
const AUDIT_REASON = /^[^\p{Cc}]{10,500}$/u;

/**
 * One-off, privileged CLI operation for an empty Production database, never exposed as HTTP.
 * Creates the first ADMIN directly. The owner attests the mailbox (no email delivery is possible
 * before registration opens), so the account is created verified; the audit records that basis.
 * The password is hashed here and appears in no return value, error or audit field.
 */
export async function createFirstAdmin(input: { email: string; password: string; reason: string; operatorReference: string }, db: Pick<typeof prisma, '$transaction'> = prisma): Promise<{ id: number }> {
    const reason = input.reason.trim();
    if (!AUDIT_REASON.test(reason) || !OPERATOR_REFERENCE.test(input.operatorReference))
        throw new FirstAdminCreateError('INVALID_AUDIT');
    const parsed = signupSchema.safeParse({ email: input.email, password: input.password });
    if (!parsed.success)
        throw new FirstAdminCreateError('INVALID_CREDENTIALS');
    const passwordHash = await bcrypt.hash(parsed.data.password, 12);
    try {
        return await db.$transaction(async (tx) => {
            // Serialize with both existing first-Admin paths (this CLI's promotion and the HTTP route).
            await tx.$executeRaw `SELECT pg_advisory_xact_lock(hashtextextended('first-admin-bootstrap',0))`;
            await tx.$executeRaw `SELECT pg_advisory_xact_lock(hashtextextended('colorful-life-single-admin-bootstrap', 0))`;
            // Any ADMIN row, deleted or not, occupies the User_single_admin_idx singleton.
            if (await tx.user.count({ where: { role: 'ADMIN' } }))
                throw new FirstAdminCreateError('ADMIN_EXISTS');
            if (await tx.user.findUnique({ where: { email: parsed.data.email }, select: { id: true } }))
                throw new FirstAdminCreateError('EMAIL_IN_USE');
            const user = await tx.user.create({ data: { email: parsed.data.email, passwordHash, role: 'ADMIN', emailVerified: true, credentialVersion: randomUUID() }, select: { id: true } });
            await tx.$executeRaw `INSERT INTO "OperationalAudit" (kind,"actorId",details) VALUES ('FIRST_ADMIN_BOOTSTRAP',${user.id},${JSON.stringify({ source: 'one-off-cli-create', emailVerification: 'owner-attested', reason, operatorReference: input.operatorReference })}::jsonb)`;
            return user;
        });
    }
    catch (error) {
        if (error instanceof FirstAdminCreateError) throw error;
        // A unique-constraint race outside these locks (singleton Admin index or email) is still a refusal.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
            throw new FirstAdminCreateError('CONFLICT');
        throw error;
    }
}
