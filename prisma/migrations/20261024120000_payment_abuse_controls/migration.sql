BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
-- Shared token buckets use database time and transaction-scoped locks. No raw identities.
CREATE TABLE "AbuseBucket" (
  "key" TEXT PRIMARY KEY,
  "tokens" DOUBLE PRECISION NOT NULL CHECK ("tokens" >= 0),
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "expiresAt" TIMESTAMPTZ(3) NOT NULL
);
CREATE INDEX "AbuseBucket_expiresAt_idx" ON "AbuseBucket" ("expiresAt");
CREATE TABLE "PaymentInitiationPolicy" (
  "provider" TEXT PRIMARY KEY CHECK ("provider" IN ('STRIPE','PAYPAL')),
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "capacity" INTEGER CHECK ("capacity" BETWEEN 1 AND 1000000),
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);
-- Environment switches default OFF and take precedence over these operational switches.
INSERT INTO "PaymentInitiationPolicy" ("provider") VALUES ('STRIPE'), ('PAYPAL');
CREATE TABLE "PaymentAdmission" (
  "identity" TEXT PRIMARY KEY,
  "attemptIdentity" TEXT NOT NULL,
  "orderId" INTEGER NOT NULL REFERENCES "Order"(id) ON DELETE CASCADE ON UPDATE CASCADE,
  "provider" TEXT NOT NULL CHECK ("provider" IN ('STRIPE','PAYPAL')),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);
CREATE INDEX "PaymentAdmission_orderId_createdAt_idx" ON "PaymentAdmission" ("orderId", "createdAt");
CREATE TABLE "PaymentSecurityEvent" (
  "id" BIGSERIAL PRIMARY KEY,
  "kind" TEXT NOT NULL,
  "provider" TEXT,
  "orderId" INTEGER,
  "actorId" INTEGER,
  "reason" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);
CREATE INDEX "PaymentSecurityEvent_createdAt_idx" ON "PaymentSecurityEvent" ("createdAt");
CREATE TABLE "PaymentFulfilmentReview" (
  "orderId" INTEGER PRIMARY KEY REFERENCES "Order"(id) ON DELETE CASCADE ON UPDATE CASCADE,
  "reason" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "releasedAt" TIMESTAMPTZ(3),
  "releasedBy" INTEGER,
  "releaseNote" TEXT,
  CONSTRAINT "review_release_complete" CHECK (("releasedAt" IS NULL AND "releasedBy" IS NULL AND "releaseNote" IS NULL)
    OR ("releasedAt" IS NOT NULL AND "releasedBy" IS NOT NULL AND "releaseNote" IS NOT NULL AND length("releaseNote") BETWEEN 10 AND 500))
);
CREATE TABLE "PaymentChallengeUse" (
  "digest" TEXT PRIMARY KEY,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL
);
CREATE INDEX "PaymentChallengeUse_expiresAt_idx" ON "PaymentChallengeUse" ("expiresAt");

COMMIT;
