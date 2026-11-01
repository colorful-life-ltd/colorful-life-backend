BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL timezone = 'UTC';

-- Keep deleted Admins in the invariant: soft deletion must never reopen setup.
-- Existing duplicate Admin rows cause this migration to fail without changing them.
CREATE UNIQUE INDEX "User_single_admin_idx"
  ON "User" ("role")
  WHERE "role" = 'ADMIN';

COMMIT;
