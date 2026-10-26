import { prisma } from '../prisma/runtime.js';
import { demoteAdmin } from '../domain/auth/adminBootstrap.js';
try {
    await demoteAdmin(Number(process.argv[2]), process.argv[3] ?? '', process.argv[4] ?? '');
    console.log('Administrator demoted; existing sessions revoked');
}
catch {
    console.error('Demotion refused: require an active ADMIN user ID, audit reason and operator reference');
    process.exitCode = 1;
}
finally {
    await prisma.$disconnect();
}
