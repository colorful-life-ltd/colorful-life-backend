import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import type { SESClientConfig } from "@aws-sdk/client-ses";

type AwsCredentialIdentityProvider = Extract<NonNullable<SESClientConfig["credentials"]>, (...args: never[]) => unknown>;

/**
 * Runtime SES credentials (Infra PR #56 contract).
 *
 * The owner mounts a private *directory* and atomically replaces `ses-session.json`
 * inside it (write temp file, fsync, rename). A directory bind sees the new inode,
 * so a running process picks up a renewed session without a restart. The record is
 * the STS response shape Infra already produces for Sandbox sessions:
 *   { "Credentials": { "AccessKeyId", "SecretAccessKey", "SessionToken", "Expiration" },
 *     "FederatedUser": { "Arn" } | "AssumedRoleUser": { "Arn" }, ...other STS fields }
 *
 * Errors and logs carry only a reason code: never a path, key id, secret, token or file
 * content (JSON.parse messages quote their input, so they are never propagated).
 */
export const SES_SESSION_FILE_NAME = "ses-session.json";
/** Credentials this close to expiry are treated as unavailable for new work. */
export const SES_MIN_REMAINING_MS = 5 * 60_000;
/** Longest STS session AWS issues (GetFederationToken 36h); anything longer is not a real record. */
const SES_MAX_REMAINING_MS = 36 * 60 * 60_000 + 60_000;
/** Upper bound on how long a running SDK client may keep using a superseded session. */
export const SES_SESSION_REREAD_MS = 60_000;
/** The AWS SDK re-resolves credentials once fewer than 5 minutes remain before `expiration`. */
const SDK_REFRESH_WINDOW_MS = 300_000;
const MAX_RECORD_BYTES = 16 * 1024;

export const SES_SOURCE_ARN_PATTERN = /^arn:aws:sts::\d{12}:(federated-user|assumed-role)\/[\w+=,.@/-]{1,256}$/;
const TEMPORARY_ACCESS_KEY_ID = /^ASIA[A-Z0-9]{16}$/;
const PRINTABLE_SECRET = /^[\x21-\x7e]+$/;
const TIMEZONE_SUFFIX = /(Z|[+-]\d\d:\d\d)$/;

export type SesCredentialProblem = "missing" | "unsafe_file" | "malformed" | "unknown_source" | "expired" | "unverifiable_source";

/** Named like the SDK's own provider error so delivery classification treats it as a proven pre-send failure. */
export class SesCredentialsUnavailableError extends Error {
  constructor(readonly reason: SesCredentialProblem) {
    super(`SES credentials unavailable: ${reason}`);
    this.name = "CredentialsProviderError";
  }
}

export type SesSessionSource = { directory: string; expectedSourceArn: string };
export type SesSession = { accessKeyId: string; secretAccessKey: string; sessionToken: string; expiration: Date };

const unavailable = (reason: SesCredentialProblem): never => { throw new SesCredentialsUnavailableError(reason); };

async function readPrivateRecord(directory: string): Promise<string> {
  let handle;
  try {
    const dir = await lstat(directory);
    if (!dir.isDirectory() || (dir.mode & 0o022)) unavailable("unsafe_file");
    // O_NOFOLLOW: a planted symlink cannot redirect the read.
    handle = await open(join(directory, SES_SESSION_FILE_NAME), constants.O_RDONLY | constants.O_NOFOLLOW);
    const file = await handle.stat();
    if (!file.isFile() || (file.mode & 0o077)) unavailable("unsafe_file");
    if (file.size === 0 || file.size > MAX_RECORD_BYTES) unavailable("malformed");
    return await handle.readFile("utf8");
  } catch (error) {
    if (error instanceof SesCredentialsUnavailableError) throw error;
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return unavailable(code === "ELOOP" ? "unsafe_file" : "missing");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Pure validation of a session record. Exported for tests. */
export function parseSesSession(raw: string, expectedSourceArn: string, now: number): SesSession {
  let record: unknown;
  try { record = JSON.parse(raw); } catch { return unavailable("malformed"); }
  if (!record || typeof record !== "object" || Array.isArray(record)) return unavailable("malformed");
  const r = record as Record<string, any>;
  const c = r.Credentials;
  if (!c || typeof c !== "object"
    || typeof c.AccessKeyId !== "string" || !TEMPORARY_ACCESS_KEY_ID.test(c.AccessKeyId)
    || typeof c.SecretAccessKey !== "string" || !PRINTABLE_SECRET.test(c.SecretAccessKey)
    || typeof c.SessionToken !== "string" || !PRINTABLE_SECRET.test(c.SessionToken)
    || typeof c.Expiration !== "string" || !TIMEZONE_SUFFIX.test(c.Expiration)) return unavailable("malformed");
  const expiresAt = Date.parse(c.Expiration);
  if (!Number.isFinite(expiresAt)) return unavailable("malformed");
  const sources = [r.FederatedUser?.Arn, r.AssumedRoleUser?.Arn].filter(value => value !== undefined);
  if (sources.length !== 1 || sources[0] !== expectedSourceArn) return unavailable("unknown_source");
  const remaining = expiresAt - now;
  if (remaining > SES_MAX_REMAINING_MS) return unavailable("malformed");
  if (remaining < SES_MIN_REMAINING_MS) return unavailable("expired");
  return { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken, expiration: new Date(expiresAt) };
}

export async function loadSesSession(source: SesSessionSource, now = Date.now()): Promise<SesSession> {
  return parseSesSession(await readPrivateRecord(source.directory), source.expectedSourceArn, now);
}

/**
 * AWS SDK credential provider that re-reads the session record on each SDK refresh.
 * The reported expiration is capped so the SDK's memoization re-resolves at most every
 * `rereadMs`, bounding use of a superseded session; a missing, malformed or expiring
 * record rejects the request before anything is signed or sent.
 */
export function sesSessionCredentialProvider(source: SesSessionSource, options: { now?: () => number; rereadMs?: number } = {}): AwsCredentialIdentityProvider {
  const now = options.now ?? Date.now;
  const rereadMs = options.rereadMs ?? SES_SESSION_REREAD_MS;
  return async () => {
    const at = now();
    const session = await observe(loadSesSession(source, at));
    return { ...session, expiration: new Date(Math.min(session.expiration.getTime(), at + SDK_REFRESH_WINDOW_MS + rereadMs)) };
  };
}

export type SesSourceConfig = { SES_SESSION_DIRECTORY?: string; SES_SESSION_SOURCE_ARN?: string };
export function sesSessionSource(c: SesSourceConfig): SesSessionSource | undefined {
  return c.SES_SESSION_DIRECTORY && c.SES_SESSION_SOURCE_ARN
    ? { directory: c.SES_SESSION_DIRECTORY, expectedSourceArn: c.SES_SESSION_SOURCE_ARN } : undefined;
}

export type EmailReadiness = { ready: true; source: "session-directory" | "sdk-default" } | { ready: false; reason: SesCredentialProblem };

/**
 * Credential readiness, not delivery: `ready` means a usable, unexpired credential exists
 * right now. It never implies SES will accept, or a mailbox will receive, a message.
 *
 * `requireVerifiableExpiry` (signup in production) refuses the SDK default chain, whose
 * environment credentials cannot reveal their expiry and keep being used after it.
 */
export async function sesCredentialReadiness(c: SesSourceConfig, opts: { production: boolean; requireVerifiableExpiry: boolean; now?: number }): Promise<EmailReadiness> {
  const source = sesSessionSource(c);
  if (!source) {
    if (opts.production && opts.requireVerifiableExpiry) return { ready: false, reason: "unverifiable_source" };
    return { ready: true, source: "sdk-default" };
  }
  try {
    await observe(loadSesSession(source, opts.now ?? Date.now()));
    return { ready: true, source: "session-directory" };
  } catch (error) {
    if (error instanceof SesCredentialsUnavailableError) return { ready: false, reason: error.reason };
    return { ready: false, reason: "missing" };
  }
}

// Log only transitions (including each newly installed session), so a long outage is one
// line rather than one per request.
let lastObserved: string | undefined;
async function observe(load: Promise<SesSession>): Promise<SesSession> {
  try {
    const session = await load;
    transition(`ready:${session.expiration.toISOString()}`, { event: "ses_credentials_ready", expiresAt: session.expiration.toISOString() });
    return session;
  } catch (error) {
    const reason = error instanceof SesCredentialsUnavailableError ? error.reason : "missing";
    transition(`unavailable:${reason}`, { event: "ses_credentials_unavailable", reason });
    throw error instanceof SesCredentialsUnavailableError ? error : new SesCredentialsUnavailableError("missing");
  }
}
function transition(state: string, line: Record<string, string>) {
  if (state === lastObserved) return;
  lastObserved = state;
  (state.startsWith("ready") ? console.info : console.error)(JSON.stringify(line));
}
export function resetSesCredentialObservationForTests() { lastObserved = undefined; }
