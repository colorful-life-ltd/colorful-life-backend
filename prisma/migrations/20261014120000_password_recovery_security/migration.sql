BEGIN;
-- Fail rather than waiting indefinitely for the brief User ALTER TABLE lock.
SET LOCAL lock_timeout = '5s';
ALTER TABLE "User" ADD COLUMN "credentialVersion" TEXT;
CREATE TABLE "PasswordRecoveryLimit" (
  "key" VARCHAR(64) PRIMARY KEY,
  "windowStartedAt" TIMESTAMPTZ(3) NOT NULL,
  "count" INTEGER NOT NULL CHECK ("count" > 0)
);
CREATE INDEX "PasswordRecoveryLimit_windowStartedAt_idx" ON "PasswordRecoveryLimit" ("windowStartedAt");
COMMIT;
