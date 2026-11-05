# SES runtime credentials and signup guard

Backend side of the Infra PR #56 contract ("Separate Backend task"). The Backend
accepts no credential format of its own: the record is the STS response shape
Infra already writes for Sandbox sessions (`ops/ec2/sandbox-ses-session.mjs`).

## Root cause

SES credentials reached the process only as `AWS_ACCESS_KEY_ID` /
`AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` environment variables, fixed at
process start. Temporary sessions expire (≤ 12 h), the environment cannot be
updated, and the SDK keeps signing with the dead session. Meanwhile signup stayed
open: it created the account and token, the verification send failed, and the
failure was only logged. Resend reported success even when its send failed.

## Credential source

| Variable | Meaning |
| --- | --- |
| `SES_SESSION_DIRECTORY` | Absolute, normalized path of a **directory** bind mount (e.g. `/run/colorful/ses`). |
| `SES_SESSION_SOURCE_ARN` | Exact expected STS principal, `arn:aws:sts::<account>:federated-user/<name>` or `…:assumed-role/<role>/<session>`. |

Both or neither: a partial or malformed pair stops startup (configuration error,
names only, never values). With neither set, SES clients use the SDK default chain
exactly as before: Sandbox and current Production behaviour are unchanged. With
both set, **environment AWS keys are never used for SES**.

File: `<SES_SESSION_DIRECTORY>/ses-session.json`

```jsonc
{
  "Credentials": {
    "AccessKeyId": "ASIA…",            // temporary key only (ASIA + 16)
    "SecretAccessKey": "…",
    "SessionToken": "…",
    "Expiration": "2026-11-05T21:00:00Z" // ISO 8601 with Z or ±hh:mm
  },
  "FederatedUser": { "Arn": "<SES_SESSION_SOURCE_ARN>" }
  // or "AssumedRoleUser": { "Arn": … } — exactly one; other STS fields are ignored
}
```

Rejected as unavailable (reason code only, never values or paths):
`missing` (no directory/file, unreadable), `unsafe_file` (file readable or
writable by group/other, a symlink, directory writable by group/other),
`malformed` (invalid JSON, incomplete tuple, long-term `AKIA` key, expiry without
timezone, lifetime beyond the 36 h STS maximum, record over 16 KiB),
`unknown_source` (ARN mismatch, absent, or both principal shapes), `expired`
(fewer than 5 minutes remaining).

### Permissions

- Directory: owned by the container user (UID 1000) or root, no group/other write
  (`0700` recommended); bind-mounted read-only.
- File: readable by UID 1000, **no group/other bits** (`0600` owned by 1000).
- Never a symlink. Not part of `runtime.json`; not in the Compose environment.

## Refresh and rotation semantics

- One long-lived SES client uses a credential-provider function. The SDK re-resolves
  it at most every **60 s** (the reported expiry is capped), and each resolution
  re-reads and re-validates the file. A renewed session is used within 60 s,
  **without a restart**.
- Rotation must be atomic: write a temp file in the same directory, `fsync`,
  `rename` over `ses-session.json`, `fsync` the directory. A directory mount sees
  the new inode; a single-file bind mount would not, so do not use one.
- A superseded but still-valid session may be used for up to 60 s. A removed,
  malformed or expiring record makes the next resolution fail **before signing**:
  nothing is sent with expired credentials.
- Concurrent requests coalesce onto one resolution and always sign with one
  complete tuple (tested with rotations mid-flight).
- The provider error is named `CredentialsProviderError`, so durable email jobs
  (order/dispatch/return) classify it as a proven pre-send failure and retry
  after renewal instead of marking acceptance uncertain.
- Restart-based recovery (Infra `production_recover.py`) remains valid and
  complementary; it is no longer required merely to pick up renewed SES credentials.

## Readiness and guarded flows

Readiness means "a usable, unexpired credential exists now". It is **not** a delivery
guarantee; every send is still treated as fallible.

| Flow | Credentials unavailable | Send fails after readiness |
| --- | --- | --- |
| `POST /auth/signup` | 503 `REGISTRATION_TEMPORARILY_UNAVAILABLE`, `Retry-After: 300`, checked after the registration switch and **before** abuse protection or any account/token write. Same answer for existing emails (no enumeration). | 201; unverified account and token kept; customer can resend. Duplicate signup remains 409. |
| `POST /auth/resend-verification` | 503 `EMAIL_DELIVERY_UNAVAILABLE`; existing token untouched. | 503 `EMAIL_DELIVERY_UNAVAILABLE` (no longer reports "has been sent"); retry is safe. |
| `PATCH /users/me/email` | 503 `EMAIL_DELIVERY_UNAVAILABLE`; address unchanged. | unchanged: 200, change committed, resend available. |
| `POST /auth/forgot-password` | generic 200 after the usual 2 s padding, checked before account lookup; **no token replaced**, so a previously emailed link stays valid. | unchanged generic 200. |
| Login, refresh, verify-email, reset-password | unaffected | — |

Production signup additionally requires a verifiable expiry: with
`NODE_ENV=production` and no session directory, signup readiness is
`unverifiable_source` (closed), since environment keys cannot report expiry.
Account flows keep using the existing transport there. Non-production keeps
environment credentials (Sandbox unchanged).

Verification/reset sends now use a single SDK attempt (no automatic resend after
an ambiguous failure) and bounded timeouts (verification 5 s, reset 1.5 s).

`GET /ready/email` returns `200 {"status":"ready"}` or `503 {"status":"unavailable"}`
(signup readiness, `Cache-Control: no-store`, no reason or configuration). It is
deliberately separate from `/ready`, so an SES outage never fails API recovery or
deploy health.

Logs: one JSON line per state transition, `{"event":"ses_credentials_ready","expiresAt":…}`
(also on each newly installed session) or `{"event":"ses_credentials_unavailable","reason":…}`.
No key ids, secrets, tokens, paths or file content (JSON parse errors are never
propagated because they quote their input).

## Operator recovery

1. Symptom: `/ready/email` 503, `ses_credentials_unavailable` log line, signup 503.
2. Read the `reason`: `missing`/`expired` → renew; `malformed`/`unknown_source` →
   fix the renewal output or the expected ARN; `unsafe_file` → fix ownership/mode.
3. Mint a new scoped session through the approved owner mechanism and replace the
   file atomically, as above. Do not log or print it.
4. Within about 60 s `/ready/email` returns 200 and the log shows `ses_credentials_ready` with the new
   expiry. No restart is required; a controlled restart is also safe.
5. Customers who signed up during a send failure use "resend verification".

## Infra changes required (for Sol; not made here)

1. Production Compose (API, and Worker if it sends email): bind-mount a private
   host directory read-only at `/run/colorful/ses` and pass
   `SES_SESSION_DIRECTORY=/run/colorful/ses` and `SES_SESSION_SOURCE_ARN=<approved principal>`.
   These are non-secret and can be fixed in the wrapper/Compose environment.
2. `secret-bootstrap.mjs`: allow those two keys (or set them in the wrapper), and
   stop requiring/passing `AWS_ACCESS_KEY_ID/SECRET/SESSION_TOKEN` in `runtime.json`
   once the directory is used, so no stale environment session exists.
3. Renewal: write `ses-session.json` (mode 0600, UID 1000) by temp-file + fsync +
   rename + directory fsync, under `deploy.lock`. `credentialsExpireAt` in the
   recovery bundle can remain for boot validation.
4. Monitoring: probe `/ready/email` inside the API container with the existing
   five-minute monitor and route failures to the SES renewal/expiry alert.
5. Registration remains closed (`REGISTRATION_ENABLED=false`) until the owner
   separately approves enabling it; this change does not open it.
