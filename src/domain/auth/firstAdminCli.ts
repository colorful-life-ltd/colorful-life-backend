import { createFirstAdmin, FirstAdminCreateError, type FirstAdminCreateFailure } from './adminBootstrap.js';
import type { prisma } from '../../prisma/runtime.js';

/** Upper bound for the two stdin lines (an email plus a password of at most 72 UTF-8 bytes). */
export const MAX_CREDENTIAL_INPUT_BYTES = 1024;

const REFUSALS: Record<FirstAdminCreateFailure | 'USAGE' | 'INPUT', string> = {
    USAGE: 'Bootstrap refused: usage is bootstrapAdmin --create "<audit reason>" "<operator reference>", with the email and password on stdin',
    INPUT: 'Bootstrap refused: pipe exactly two lines on stdin (email, then password); an interactive terminal is not accepted',
    INVALID_AUDIT: 'Bootstrap refused: audit reason (10-500 printable characters) and operator reference (5-128 of A-Z a-z 0-9 . _ : / -) required',
    INVALID_CREDENTIALS: 'Bootstrap refused: a valid email and a password meeting the account password policy are required',
    ADMIN_EXISTS: 'Bootstrap refused: an administrator already exists',
    EMAIL_IN_USE: 'Bootstrap refused: that email is already registered',
    CONFLICT: 'Bootstrap refused: the account conflicts with an existing account or administrator',
};

export type CreateCliIo = {
    /** Arguments after `--create`. */
    args: string[];
    input: AsyncIterable<Buffer | string> & { isTTY?: boolean };
    stdout: (line: string) => void;
    stderr: (line: string) => void;
    db?: Pick<typeof prisma, '$transaction'>;
};

/** Reads `email\npassword\n` (a final newline and CRLF endings are accepted); null on any other shape. */
export async function readCredentialLines(input: CreateCliIo['input']): Promise<{ email: string; password: string } | null> {
    if (input.isTTY) return null; // Never read a password from a terminal that would echo it.
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of input) {
        const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        size += buffer.length;
        if (size > MAX_CREDENTIAL_INPUT_BYTES) return null;
        chunks.push(buffer);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    const lines = text.split('\n').map(line => line.endsWith('\r') ? line.slice(0, -1) : line);
    if (lines.length === 3 && lines[2] === '') lines.pop();
    if (lines.length !== 2 || !lines[0] || !lines[1]) return null;
    return { email: lines[0], password: lines[1] };
}

/** `bootstrapAdmin --create`: returns the process exit code. Output is fixed text plus the new user ID only. */
export async function runCreateFirstAdmin({ args, input, stdout, stderr, db }: CreateCliIo): Promise<number> {
    if (args.length !== 2) { stderr(REFUSALS.USAGE); return 1; }
    const credentials = await readCredentialLines(input);
    if (!credentials) { stderr(REFUSALS.INPUT); return 1; }
    try {
        const user = await createFirstAdmin({ ...credentials, reason: args[0], operatorReference: args[1] }, db);
        stdout(`First administrator created (user ID ${user.id}); sign in through the private Admin connection`);
        return 0;
    }
    catch (error) {
        stderr(error instanceof FirstAdminCreateError ? REFUSALS[error.code] : 'Bootstrap failed: outcome unknown; check database connectivity and whether an administrator exists before retrying');
        return 1;
    }
}
