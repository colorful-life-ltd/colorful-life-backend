import { prisma } from '../prisma/runtime.js';
import { bootstrapFirstAdmin } from '../domain/auth/adminBootstrap.js';
try {
    await bootstrapFirstAdmin(Number(process.argv[2]), process.argv[3] ?? '', process.argv[4] ?? '');
    console.log('First administrator bootstrap recorded; sign in again');
}
catch {
    console.error('Bootstrap refused: require verified user ID, audit reason, operator reference and no existing active ADMIN');
    process.exitCode = 1;
}
finally {
    await prisma.$disconnect();
}
