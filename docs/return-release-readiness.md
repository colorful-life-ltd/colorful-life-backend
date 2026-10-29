# Return-authorisation mail release correction

This is a narrow stacked follow-up to Backend #221; it does not modify its reviewed
head, schema migration, grant contract, return behavior or payment providers.

`RETURN_AUTHORIZATION` (the persisted event name for return-authorised mail) now
has its own default-off `RETURN_AUTHORIZATION_EMAIL_ENABLED` switch and fixed
`RETURN_AUTHORIZATION_EMAIL_ACTIVE_FROM` UTC cutoff. Enabling dispatch no longer
enables return mail; enabling return mail never enables order/dispatch mail.
The SES transport permits this independent channel after the existing Worker
readiness check succeeds. The approved business bundle remains
`ORDER_CONFIRMATION_BUSINESS_JSON`; its name does not enable invoice delivery.

The existing schema/approved-business/sender/quota checks, event-key idempotency,
leases, retries and UNKNOWN acceptance review are unchanged. The new regression
exercises the production type filter with an injected in-memory transport: return
mail sends once, and unrelated confirmation/dispatch rows remain byte-for-byte
unchanged. Missing/invalid/future return cutoffs and invalid business data fail
closed. Provider outages retain durable jobs and do not remove account return
instructions. Before-cutoff returns are suppressed; no backlog replay is enabled.

No live setting, credential, email, account or order was changed. The new switch
is false by default and no cutoff/business example is silently supplied.

Full migration/proxy/mail activation ordering and application-first rollback are
in the separate `colorful-life-infra` PR, document
`docs/releases/return-v1-controlled-release.md`. It is the authoritative release
plan. In particular, merge this stacked change only after owner approval alongside
#221, require green CI on the final main SHA, and deploy neither early. Admin #53
and Frontend #94 remain unchanged. Frontend main publishes automatically and must
be last.

Prepared activation prerequisites: approved legal/sender/monitored reply-to bundle;
verified SES sender and account readiness using the actual Worker credentials;
fixed deliberate return cutoff; independent scoped Worker credentials and owner
renewal plan; synthetic owner-inbox acceptance approval. Leave both existing email
channels disabled. Account-level admin observations are not proof of Worker
permissions or actual inbox delivery.

The existing Docker PostgreSQL is the serving database; do not guess a separate
RDS target. The infrastructure change never applies SQL: migration/grants require
separate owner approval and the repository's secured cl_migrator procedure.
The exact previous image/schema-74 functional rehearsal is mandatory before its
migration-aware rollout/rollback exception can be used.

Pre-dispatch selected-item/quantity cancellation/refund support remains a separate
gap and is not implemented here.
