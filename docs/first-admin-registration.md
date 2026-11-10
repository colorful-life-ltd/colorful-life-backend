# First Production Administrator from the Windows Admin app

Production has exactly one ADMIN. The owner creates it in the existing Admin app registration screen
(`remote-production` mode). No customer registration is opened and no public route is added.

## Security boundary (Production, `adminBootstrapMode` = `private`)

A first-Admin registration succeeds only when **all** of these hold:

1. **Direct loopback request.** The API refuses any request carrying `Forwarded`, `X-Forwarded-For`,
   `X-Forwarded-Host`, `X-Forwarded-Proto`, `X-Real-IP` or `Via` (the public Nginx always sets
   `X-Forwarded-For`), and any `Host` other than `localhost`, `127.0.0.1` or `[::1]`. The API port is published
   only on the host's `127.0.0.1:3002`; the Admin app reaches it through the owner's SSM port forward.
2. **Owner arming window.** Root on the Production host runs
   `bootstrapAdmin --arm-registration "<reason>" "<operator reference>"` (Infra:
   `production_first_admin.py --arm-registration`). This writes an immutable `FIRST_ADMIN_REGISTRATION_ARMED`
   audit row; registration is open for 15 minutes (database time). The SSM tunnel alone never authorizes setup.
3. **Single-use grant.** `POST /admin/bootstrap/authorization` issues a 5-minute, single-use, process-local
   grant bound to the caller address; `/register` consumes it before any database work.
4. **No ADMIN exists.** Checked under the same two advisory locks as the CLI paths, re-checking the arming
   window inside the transaction; the `User_single_admin_idx` unique index is the final guard.

The account is created with `emailVerified = true` on the owner's attestation (no email is sent) and a
`FIRST_ADMIN_BOOTSTRAP` audit row (`source: private-http-armed`, `armingAuditId`). Ordinary signup, email
verification for every other user, and payment switches are unchanged. `ADMIN_BOOTSTRAP_HTTP_ENABLED=false`
closes the routes completely; `true` never enables open registration in Production.

Staging and local development keep the original `open` behaviour (unverified account plus verification email).
