import { prisma } from '../../prisma/runtime.js';
import { AUDIT_REASON, OPERATOR_REFERENCE, FirstAdminCreateError } from './adminBootstrap.js';

/**
 * Production first-Administrator registration through the private Admin connection is possible only
 * while an arming record younger than this window exists and no ADMIN exists. Arming needs root on the
 * Production host (it runs inside the API container); the SSM tunnel alone never authorizes setup.
 */
export const FIRST_ADMIN_REGISTRATION_WINDOW_SECONDS = 15 * 60;
export const FIRST_ADMIN_REGISTRATION_ARMED = 'FIRST_ADMIN_REGISTRATION_ARMED';

type Db = Pick<typeof prisma, '$queryRaw'>;

/** The newest unused arming record still inside the window, judged by database time. */
export async function activeRegistrationArming(db: Db = prisma, windowSeconds = FIRST_ADMIN_REGISTRATION_WINDOW_SECONDS): Promise<bigint | null> {
    const rows = await db.$queryRaw<Array<{ id: bigint }>>`
      SELECT armed.id FROM "OperationalAudit" armed
      WHERE armed.kind = ${FIRST_ADMIN_REGISTRATION_ARMED} AND armed."createdAt" > clock_timestamp() - make_interval(secs => ${windowSeconds})
        -- Single use: any first-Admin creation after the arming (by any path) closes it, even if that Admin is removed later.
        AND NOT EXISTS (SELECT 1 FROM "OperationalAudit" used WHERE used.kind = 'FIRST_ADMIN_BOOTSTRAP' AND used.id > armed.id)
      ORDER BY armed.id DESC LIMIT 1`;
    return rows[0]?.id ?? null;
}

/** Owner-run (CLI, root on the host): opens the window. Refuses once any ADMIN row exists. */
export async function armFirstAdminRegistration(input: { reason: string; operatorReference: string }, db: Pick<typeof prisma, '$transaction'> = prisma): Promise<{ id: bigint; expiresAt: Date }> {
    const reason = input.reason.trim();
    if (!AUDIT_REASON.test(reason) || !OPERATOR_REFERENCE.test(input.operatorReference))
        throw new FirstAdminCreateError('INVALID_AUDIT');
    return db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('first-admin-bootstrap',0))`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('colorful-life-single-admin-bootstrap', 0))`;
        if (await tx.user.count({ where: { role: 'ADMIN' } }))
            throw new FirstAdminCreateError('ADMIN_EXISTS');
        const details = JSON.stringify({ reason, operatorReference: input.operatorReference, windowSeconds: FIRST_ADMIN_REGISTRATION_WINDOW_SECONDS });
        const [row] = await tx.$queryRaw<Array<{ id: bigint; createdAt: Date }>>`
          INSERT INTO "OperationalAudit" (kind, details) VALUES (${FIRST_ADMIN_REGISTRATION_ARMED}, ${details}::jsonb) RETURNING id, "createdAt"`;
        return { id: row.id, expiresAt: new Date(row.createdAt.getTime() + FIRST_ADMIN_REGISTRATION_WINDOW_SECONDS * 1000) };
    });
}

const ARM_REFUSALS = {
    USAGE: 'Bootstrap refused: usage is bootstrapAdmin --arm-registration "<audit reason>" "<operator reference>"',
    INVALID_AUDIT: 'Bootstrap refused: audit reason (10-500 printable characters) and operator reference (5-128 of A-Z a-z 0-9 . _ : / -) required',
    ADMIN_EXISTS: 'Bootstrap refused: an administrator already exists',
} as const;

/** `bootstrapAdmin --arm-registration`: returns the process exit code. Output is fixed text plus the expiry time only. */
export async function runArmFirstAdminRegistration({ args, stdout, stderr, db }: { args: string[]; stdout: (line: string) => void; stderr: (line: string) => void; db?: Pick<typeof prisma, '$transaction'> }): Promise<number> {
    if (args.length !== 2) { stderr(ARM_REFUSALS.USAGE); return 1; }
    try {
        const { expiresAt } = await armFirstAdminRegistration({ reason: args[0], operatorReference: args[1] }, db);
        stdout(`First-admin registration open until ${expiresAt.toISOString()}; register from the private Admin connection`);
        return 0;
    }
    catch (error) {
        if (error instanceof FirstAdminCreateError && (error.code === 'INVALID_AUDIT' || error.code === 'ADMIN_EXISTS')) stderr(ARM_REFUSALS[error.code]);
        else stderr('Bootstrap failed: registration was not opened; check database connectivity and retry');
        return 1;
    }
}
