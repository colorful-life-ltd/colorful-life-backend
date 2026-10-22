import { PrismaClient } from "../generated/prisma-client/client.js";
import { databasePoolOptions } from "../config/database.js";
import { PrismaPg } from "@prisma/adapter-pg";
// Import configuration with explicit .js extension to satisfy Node's ESM resolver.
// The original source omitted the extension which works when bundled, but
// fails when running the compiled JavaScript directly. Using the .js
// suffix ensures compatibility when the project is executed with `node`.
import { config } from "../config/index.js";

// The pg adapter datetime codec requires UTC sessions for exact TIMESTAMPTZ round trips.
// This also keeps immutable payment verification/deadline timestamps independent of host/server DST.
const adapter = new PrismaPg(databasePoolOptions(config.DATABASE_URL, process.env));
export const prisma = new PrismaClient({ adapter });