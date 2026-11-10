# First Administrator bootstrap (owner-run CLI)

There is no HTTP route for creating an Administrator in Production (`httpAdminBootstrapEnabled` is always
false there). The owner provisions the first ADMIN with the one-off CLI built into the API image,
`dist/scripts/bootstrapAdmin.js`. Running it against Production is a separately approved action.

## Modes

| Mode | Use | Effect |
| --- | --- | --- |
| `bootstrapAdmin <userId> "<reason>" "<operator reference>"` | An existing verified customer should become the Administrator (unchanged original mode) | Promotes the customer, rotates `credentialVersion`, revokes refresh sessions |
| `bootstrapAdmin --create "<reason>" "<operator reference>"` | Empty database: no customer exists and registration/email are not open | Creates the ADMIN directly |

`--create` reads exactly two lines from **piped stdin**: the email, then the password. It refuses an
interactive terminal (which would echo the password), extra arguments, and any other input shape. The password
is never accepted from arguments or environment variables and appears in no output, error or audit field.

Both modes take the same transaction-scoped advisory lock (`--create` also takes the HTTP route's lock) and
refuse when an ADMIN already exists; `User_single_admin_idx` remains the final guarantee. `--create` also
refuses an email that is already registered, and applies the account password policy and bcrypt cost 12.

The created account has `emailVerified=true`. No verification email can be delivered before email sending is
live, so verification rests on the owner's attestation that they control the mailbox. The
`FIRST_ADMIN_BOOTSTRAP` audit row records `source: one-off-cli-create`, `emailVerification: owner-attested`,
the reason and the operator reference (5–128 characters of `A-Z a-z 0-9 . _ : / -`). It does not record
the email or any password material.

## Production invocation (after approval)

**Do not run the CLI with a plain `docker exec` in the Production API container.** That container's own
environment holds no database or JWT settings. The Infra entrypoint `secret-bootstrap.mjs` builds them from the
mounted runtime file only for `node dist/index.js` or `node dist/worker.js`, and it refuses any other command.
`docker exec … node dist/scripts/bootstrapAdmin.js` therefore fails on configuration validation before reaching
the database (verified in a rehearsal on the `dfe6118` image; nothing is written).

Use the reviewed Infra operator script `ops/ec2/production_first_admin.py`, documented in Infra
`docs/production-first-admin.md`:

```bash
# Read-only preflight: no prompt, no credentials, no database access.
sudo python3 /opt/colorful-life-infra/ops/ec2/production_first_admin.py --check

# Creation: interactive terminal only (ssh -t). Email by prompt; password twice, never echoed.
sudo python3 /opt/colorful-life-infra/ops/ec2/production_first_admin.py \
  --reason "<audit reason>" --operator-reference "<operator reference>"
```

The script first verifies the host, the recorded release and a single healthy Production API container running
an image that contains this CLI. It then runs `bootstrapAdmin --create` with the environment the reviewed
entrypoint builds for the API (same `cl_runtime` database role). It sends the email and password only over
`docker exec -i` stdin: never in arguments, environment variables, logs or files.

Success prints only the new user ID. Then sign in from the Admin application in Production mode. An "outcome
unknown" result means the result could not be confirmed: check whether an Administrator exists before
retrying. A second Administrator is refused in any case.

Outside Production (a local or test environment whose shell already provides the database settings), run the
compiled CLI directly and pipe the two lines on stdin, for example from `read -s` variables passed through
`printf`.
