import { isIP } from "node:net";
import { z } from "zod";
import { config as dotenvConfig } from "dotenv";
import { resolveDatabaseUrl } from "./testDatabase.js";
import { parsePublicSiteOrigin } from "../domain/seo/publicSiteOrigin.js";

// Load environment variables from .env if present
dotenvConfig();

// Fixed epoch: future email cutoffs remain invalid for this process until a reviewed restart.
export const emailConfigurationLoadedAt = Date.now();

// Schema for configuration validation
const configSchema = z.object({
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
    FRONTEND_URL: z.string().url().default("http://localhost:3000"),
    // Canonical public storefront origin for sitemap URLs. Deliberately separate from
    // FRONTEND_URL and never derived from the API host; the sitemap is disabled when unset.
    PUBLIC_SITE_URL: z.string().optional().refine(value => !value || parsePublicSiteOrigin(value) !== null,
      "Expected an http(s) origin with no path, query, fragment or credentials"),
    IDEAL_POSTCODES_API_KEY: z.string().nonempty().optional(),
    STRIPE_SECRET_KEY: z.string().nonempty().optional(),
    STRIPE_WEBHOOK_SECRET: z.string().nonempty().optional(),
    PAYPAL_CLIENT_ID: z.string().nonempty().optional(),
    PAYPAL_CLIENT_SECRET: z.string().nonempty().optional(),
  PAYPAL_BASE_URL: z.string().url().default("https://api-m.sandbox.paypal.com"),
    PAYPAL_WEBHOOK_ID: z.string().optional(),
    CLOUDINARY_CLOUD_NAME: z.string().nonempty().optional(),
    CLOUDINARY_API_KEY: z.string().nonempty().optional(),
    CLOUDINARY_API_SECRET: z.string().nonempty().optional(),
  });

const parsed = configSchema.safeParse({
  ...process.env,
  DATABASE_URL: resolveDatabaseUrl(process.env),
});
if (!parsed.success) {
  console.error("❌ Invalid environment configuration:", parsed.error.format());
  process.exit(1);
}

export const config = parsed.data;
