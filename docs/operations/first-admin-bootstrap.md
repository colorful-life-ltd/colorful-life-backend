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

## Owner invocation (after approval)

Run on the host as an operator with Docker access. `read -s` keeps the password off the screen. `printf`
is a shell builtin, so the password does not appear in any process's arguments, and an unexported
shell variable is not passed into the container's environment.

```bash
api=$(sudo docker ps -q --filter label=com.docker.compose.project=colorful-life-production --filter label=com.docker.compose.service=api)
read -r -p 'Admin email: ' ADMIN_EMAIL; read -r -s -p 'Admin password: ' ADMIN_PASSWORD; echo
printf '%s\n%s\n' "$ADMIN_EMAIL" "$ADMIN_PASSWORD" | sudo docker exec -i "$api" \
  node dist/scripts/bootstrapAdmin.js --create "<audit reason>" "<operator reference>"
unset ADMIN_EMAIL ADMIN_PASSWORD
```

Success prints only the new user ID. Then sign in through the private Admin connection. An "outcome unknown"
failure means the database could not be reached reliably: check whether an Administrator exists before retrying.
