import { databaseUrl } from "./database.js";
import { validateProduction } from "./production.js";
import { isolateTestAwsEnvironment, testEmailMode } from "./testEmail.js";
import { validateAbuseStartup } from "./paymentAbuse.js";
import { isIP } from "node:net";
import { z } from "zod";
import { config as dotenvConfig } from "dotenv";
import { isTestExecution, resolveDatabaseUrl } from "./testDatabase.js";
import { parsePublicSiteOrigin } from "../domain/seo/publicSiteOrigin.js";
import { SES_SOURCE_ARN_PATTERN } from "../services/sesCredentials.js";
import { isAbsolute, normalize } from "node:path";

// Load environment variables from .env if present
dotenvConfig();
if (testEmailMode()) isolateTestAwsEnvironment(process.env);

// Fixed epoch: future email cutoffs remain invalid for this process until a reviewed restart.
export const emailConfigurationLoadedAt = Date.now();

// Schema for configuration validation
const configSchema = z.object({
  CORS_ALLOWED_ORIGINS: z.string().default("http://localhost:5173"),
  BACKGROUND_WORKERS_ENABLED: z.enum(["true","false"]).default("true").transform(v=>v==="true"),
  RETURN_AUTHORIZATION_EMAIL_ENABLED: z.enum(["true", "false"]).default("false").transform(value => value === "true"),
  RETURN_AUTHORIZATION_EMAIL_ACTIVE_FROM: z.string().optional(),
  DISPATCH_CONFIRMATION_EMAIL_ENABLED: z.enum(["true", "false"]).default("false").transform(value => value === "true"),
  // Email cutoff validation is worker-local; invalid cutoffs must not terminate the API.
  DISPATCH_CONFIRMATION_EMAIL_ACTIVE_FROM: z.string().optional(),
  ORDER_CONFIRMATION_EMAIL_ACTIVE_FROM: z.string().optional(),
  ORDER_CONFIRMATION_EMAIL_ENABLED: z.enum(["true", "false"]).default("false").transform(value => value === "true"),
  // Approval bundle is separately validated by the confirmation worker; invalid/missing data blocks delivery.
  ORDER_CONFIRMATION_BUSINESS_JSON: z.string().optional(),
  REFUND_RECONCILIATION_ENABLED: z.enum(["true", "false"]).default("false").transform(value => value === "true"),
  CARRIER_TRACKING_POLLING_ENABLED: z.enum(["true", "false"]).default("false").transform(value => value === "true"),
  PAYMENT_RESOLUTION_ENABLED: z.enum(["true", "false"]).default("false").transform(value => value === "true"),
  // Public self-registration. Closed by default so pre-launch environments cannot collect accounts.
  REGISTRATION_ENABLED: z.enum(["true", "false"]).default("false").transform(v => v === "true"),
  // HTTP first-Administrator registration; see config/adminBootstrap.ts. Never honoured in production.
  ADMIN_BOOTSTRAP_HTTP_ENABLED: z.enum(["true", "false"]).optional(),
  PAYMENT_STRIPE_INITIATION_ENABLED: z.enum(["true", "false"]).default("false").transform(v => v === "true"),
  CLIENT_IP_MODE: z.enum(["direct", "proxy"]).optional(),
  PAYMENT_ABUSE_HMAC_SECRET: z.string().min(32).optional(),
  PAYMENT_ABUSE_LIMITS_JSON: z.string().optional(),
  PAYMENT_CHALLENGE_ENABLED: z.enum(["true", "false"]).default("false").transform(v => v === "true"),
  TURNSTILE_SECRET_KEY: z.string().optional(),
  TURNSTILE_HOSTNAME: z.string().optional(),
  PORT: z
    .preprocess((val) => (val ? Number(val) : 3000),
      z.number().int().positive()
    ),
    DATABASE_URL: z.string().nonempty(),
    // Only explicit IP addresses/CIDRs; never trust arbitrary forwarded headers.
    TRUSTED_PROXY_CIDRS: z.string().optional().refine(value => !value || value.split(",").every(entry => {
      const parts = entry.trim().split("/");
      const [address, bits] = parts;
      const family = isIP(address);
      return parts.length <= 2 && family !== 0 && (bits === undefined || (/^\d+$/.test(bits) && Number(bits) <= (family === 4 ? 32 : 128)));
    }), "Expected comma-separated proxy IPs/CIDRs"),
    JWT_SECRET: z.string().nonempty(),
    JWT_EXPIRES_IN: z.string().nonempty().default("1h"),
    REFRESH_SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
    AWS_REGION: z.string().nonempty().default("eu-west-2"),
    SES_FROM_EMAIL: z.string().email().default("noreply@example.com"),
    // Optional runtime SES session (see docs/operations/ses-runtime-credentials.md). When set, SES
    // clients read the mounted, renewable record instead of process environment keys.
    // Empty is treated as unset, so the test runner can blank inherited values.
    SES_SESSION_DIRECTORY: z.preprocess(v => v === "" ? undefined : v, z.string().refine(v => isAbsolute(v) && normalize(v) === v && v !== "/",
      "Expected a normalized absolute directory").optional()),
    SES_SESSION_SOURCE_ARN: z.preprocess(v => v === "" ? undefined : v, z.string().regex(SES_SOURCE_ARN_PATTERN, "Expected an STS federated-user or assumed-role ARN").optional()),
    FRONTEND_URL: z.string().url().default("http://localhost:3000"),
    // Canonical public storefront origin for sitemap URLs. Deliberately separate from
    // FRONTEND_URL and never derived from the API host; the sitemap is disabled when unset.
    PUBLIC_SITE_URL: z.string().optional().refine(value => !value || parsePublicSiteOrigin(value) !== null,
      "Expected an http(s) origin with no path, query, fragment or credentials"),
    IDEAL_POSTCODES_API_KEY: z.string().nonempty().optional(),
    STRIPE_SECRET_KEY: z.string().nonempty().optional(),
    STRIPE_WEBHOOK_SECRET: z.string().nonempty().optional(),
    CLOUDINARY_CLOUD_NAME: z.string().nonempty().optional(),
    CLOUDINARY_API_KEY: z.string().nonempty().optional(),
    CLOUDINARY_API_SECRET: z.string().nonempty().optional(),
  }).refine(c => !c.SES_SESSION_DIRECTORY === !c.SES_SESSION_SOURCE_ARN, {
    message: "SES_SESSION_DIRECTORY and SES_SESSION_SOURCE_ARN must be set together", path: ["SES_SESSION_SOURCE_ARN"],
  });

const parsed = configSchema.safeParse({
  ...process.env,
  DATABASE_URL: isTestExecution(process.env) ? resolveDatabaseUrl(process.env) : databaseUrl(process.env),
});
if (!parsed.success) {
  console.error("❌ Invalid environment configuration:", parsed.error.format());
  process.exit(1);
}

try { if(process.env.NODE_ENV&&!["development","test","production"].includes(process.env.NODE_ENV))throw new Error("NODE_ENV must be development, test or production"); validateAbuseStartup(parsed.data, process.env.NODE_ENV); validateProduction(parsed.data,process.env); }
catch (error) {
  console.error("Invalid security startup configuration:", error instanceof Error ? error.message : "configuration unavailable");
  process.exit(1);
}
export const config = parsed.data;
