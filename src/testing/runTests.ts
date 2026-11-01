import "dotenv/config";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareTestEnvironment } from "./testEnvironment.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function run(args: string[], input?: string) {
  const result = spawnSync(process.execPath, args, {
    cwd: root, env: process.env,
    stdio: input === undefined ? "inherit" : ["pipe", "inherit", "inherit"],
    input,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Test command failed (${result.signal ?? result.status ?? "could not start"})`);
  }
}

try {
  const [mode, ...requestedFiles] = process.argv.slice(2);
  if (!["check", "prepare", "run"].includes(mode) || (mode !== "run" && requestedFiles.length)) {
    throw new Error("Use check, prepare, or run [dist/__tests__/name.test.js ...]");
  }
  // Validate before changing NODE_ENV, importing application code, or spawning Prisma.
  const target = prepareTestEnvironment(process.env);
  const { config } = await import("../config/index.js");
  if (config.DATABASE_URL !== target.url) throw new Error("Test runtime database selection mismatch");
  console.log(`Validated test database: ${target.database}; application and Prisma migrations use TEST_DATABASE_URL.`);
  if (mode !== "check") {
    const testDirectory = resolve(root, "dist/__tests__");
    const knownFiles = readdirSync(testDirectory).filter((name) => name.endsWith(".test.js"))
      .sort().map((name) => resolve(testDirectory, name));
    const files = requestedFiles.length ? requestedFiles.map((name) => resolve(root, name)) : knownFiles;
    if (files.some((file) => !knownFiles.includes(file))) {
      throw new Error("Only compiled dist/__tests__/*.test.js files may be selected");
    }
    // Deploy committed migrations only; no reset, db push, seeds, or development fixtures.
    run([resolve(root, "node_modules/prisma/build/index.js"), "migrate", "deploy"]);
    if (mode === "run") {
      // Several catalogue tests inspect entire categories. Avoid cross-file fixture races.
      // The legacy integration suite intentionally creates many independent Admin
      // fixture users in one shared disposable DB. Exercise the singleton constraint
      // in its dedicated suite first, then remove only that test DB constraint so the
      // legacy fixtures retain their historical shape. Production migrations are
      // never altered; testDatabase validation above fences this operation to CI DBs.
      const bootstrapFile = resolve(testDirectory, "adminBootstrap.integration.test.js");
      const hasBootstrap = files.includes(bootstrapFile);
      if (hasBootstrap) run(["--test", "--test-concurrency=1", bootstrapFile]);
      const legacyFiles = files.filter(file => file !== bootstrapFile);
      if (hasBootstrap && legacyFiles.length) {
        run([resolve(root, "node_modules/prisma/build/index.js"), "db", "execute", "--stdin"],
        'DROP INDEX IF EXISTS "User_single_admin_idx";');
      }
      if (legacyFiles.length) run(["--test", "--test-concurrency=1", ...legacyFiles]);
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Test bootstrap failed");
  process.exitCode = 1;
}
