import { prisma } from '../prisma/runtime.js';
import { bootstrapFirstAdmin } from '../domain/auth/adminBootstrap.js';
import { runCreateFirstAdmin } from '../domain/auth/firstAdminCli.js';
import { runArmFirstAdminRegistration } from '../domain/auth/firstAdminRegistrationArming.js';
// `--create "<reason>" "<operator reference>"` with email and password on stdin creates the first ADMIN
// on an empty database. `--arm-registration "<reason>" "<operator reference>"` opens the 15-minute window for
// first-Admin registration from the private Admin connection (Production). Without either flag, the
// original verified-customer promotion runs unchanged.
if (process.argv[2] === '--arm-registration') {
    try {
        process.exitCode = await runArmFirstAdminRegistration({ args: process.argv.slice(3), stdout: line => console.log(line), stderr: line => console.error(line) });
    }
    finally {
        await prisma.$disconnect();
    }
}
else if (process.argv[2] === '--create') {
    try {
        process.exitCode = await runCreateFirstAdmin({ args: process.argv.slice(3), input: process.stdin, stdout: line => console.log(line), stderr: line => console.error(line) });
    }
    finally {
        await prisma.$disconnect();
    }
}
else {
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
}
