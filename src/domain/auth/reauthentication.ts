import bcrypt from 'bcrypt';
import { prisma } from '../../prisma/runtime.js';
export class ReauthenticationRequired extends Error {
    constructor() { super('REAUTHENTICATION_REQUIRED'); }
}
export async function reauthenticate(userId: number, password: unknown) {
    if (typeof password !== 'string' || Buffer.byteLength(password) > 72 || !password)
        throw new ReauthenticationRequired();
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.deletedAt || !await bcrypt.compare(password, user.passwordHash))
        throw new ReauthenticationRequired();
    return user.passwordHash;
}
