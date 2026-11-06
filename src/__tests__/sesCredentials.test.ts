import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { chmodSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { spawnSync } from "node:child_process";
import { SESClient, SendRawEmailCommand } from "@aws-sdk/client-ses";
import {
  SES_SESSION_FILE_NAME, SesCredentialsUnavailableError, loadSesSession, parseSesSession, resetSesCredentialObservationForTests,
  sesCredentialReadiness, sesSessionCredentialProvider, type SesSessionSource,
} from "../services/sesCredentials.js";
import { classifySesError } from "../domain/orderConfirmation/delivery.js";

// Synthetic values only. Distinctive markers let the leak checks search every output.
const SOURCE = "arn:aws:sts::000000000000:federated-user/colorful-production-mail";
const T0 = Date.parse("2026-11-05T12:00:00Z");
const HOUR = 3_600_000;
const keyOf = (tag: string) => `ASIA${tag.padEnd(16, "0").slice(0, 16)}`;
const session = (tag: string, expiresAt = T0 + 6 * HOUR, extra: Record<string, unknown> = {}) => ({
  Credentials: { AccessKeyId: keyOf(tag), SecretAccessKey: `SECRETMARKER-${tag}`, SessionToken: `TOKENMARKER-${tag}`,
    Expiration: new Date(expiresAt).toISOString() },
  FederatedUser: { Arn: SOURCE, FederatedUserId: "000000000000:colorful-production-mail" }, PackedPolicySize: 9, ...extra,
});

let dir: string;
let source: SesSessionSource;
let logs: string[];
const originals = { info: console.info, error: console.error, warn: console.warn, log: console.log };

/** Atomic replacement exactly as Infra performs it: temp file in the same directory, then rename. */
function install(record: unknown, mode = 0o600) {
  const temp = join(dir, `.ses-session-${Math.random().toString(36).slice(2)}`);
  writeFileSync(temp, typeof record === "string" ? record : JSON.stringify(record), { mode });
  chmodSync(temp, mode);
  renameSync(temp, join(dir, SES_SESSION_FILE_NAME));
}
async function reason(promise: Promise<unknown>) {
  try { await promise; } catch (error) {
    assert.ok(error instanceof SesCredentialsUnavailableError);
    return error.reason;
  }
  assert.fail("expected credentials to be refused");
}
function assertNoSecrets(...values: unknown[]) {
  const text = [...values, ...logs].map(value => typeof value === "string" ? value : inspect(value, { depth: 8 })).join("\n");
  for (const marker of ["SECRETMARKER", "TOKENMARKER", "ASIAROT", "ASIAVALID", dir]) assert.equal(text.includes(marker), false, `leaked ${marker}`);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ses-session-"));
  chmodSync(dir, 0o700);
  source = { directory: dir, expectedSourceArn: SOURCE };
  logs = [];
  resetSesCredentialObservationForTests();
  for (const name of ["info", "error", "warn", "log"] as const) console[name] = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
});
afterEach(() => {
  Object.assign(console, originals);
  rmSync(dir, { recursive: true, force: true });
});

describe("SES session record validation", () => {
  it("accepts a valid temporary session from the known source", async () => {
    install(session("VALID"));
    const loaded = await loadSesSession(source, T0);
    assert.equal(loaded.accessKeyId, keyOf("VALID"));
    assert.equal(loaded.sessionToken, "TOKENMARKER-VALID");
    assert.equal(loaded.expiration.getTime(), T0 + 6 * HOUR);
    // Assumed-role sessions are the other STS shape Infra may adopt for Production.
    const role = session("VALID"); delete (role as any).FederatedUser;
    install({ ...role, AssumedRoleUser: { Arn: SOURCE } });
    assert.equal((await loadSesSession(source, T0)).accessKeyId, keyOf("VALID"));
  });

  it("refuses missing credentials: no directory, no file, or a removed file", async () => {
    assert.equal(await reason(loadSesSession({ directory: join(dir, "absent"), expectedSourceArn: SOURCE }, T0)), "missing");
    assert.equal(await reason(loadSesSession(source, T0)), "missing");
    install(session("VALID")); rmSync(join(dir, SES_SESSION_FILE_NAME));
    assert.equal(await reason(loadSesSession(source, T0)), "missing");
  });

  it("refuses expired and nearly expired credentials, including expiry after process start", async () => {
    install(session("VALID", T0 - 1));
    assert.equal(await reason(loadSesSession(source, T0)), "expired");
    install(session("VALID", T0 + 4 * 60_000));
    assert.equal(await reason(loadSesSession(source, T0)), "expired");
    install(session("VALID", T0 + HOUR));
    await loadSesSession(source, T0);
    assert.equal(await reason(loadSesSession(source, T0 + HOUR - 60_000)), "expired");
  });

  it("refuses malformed bundles without echoing their content", async () => {
    const valid = session("VALID");
    const cases: unknown[] = [
      '{"Credentials":{"SecretAccessKey":"SECRETMARKER-broken"', "[]", "null", "", {},
      { ...valid, Credentials: { ...valid.Credentials, AccessKeyId: keyOf("VALID").replace("ASIA", "AKIA") } }, // long-term key
      { ...valid, Credentials: { ...valid.Credentials, SessionToken: "" } },
      { ...valid, Credentials: { ...valid.Credentials, SecretAccessKey: undefined } },
      { ...valid, Credentials: { ...valid.Credentials, SecretAccessKey: "SECRETMARKER has space" } },
      { ...valid, Credentials: { ...valid.Credentials, Expiration: "2026-11-05T18:00:00" } }, // no timezone
      { ...valid, Credentials: { ...valid.Credentials, Expiration: "not a date Z" } },
      { ...valid, Credentials: { ...valid.Credentials, Expiration: new Date(T0 + 40 * HOUR).toISOString() } }, // beyond STS maximum
      "x".repeat(17 * 1024),
    ];
    for (const record of cases) {
      if (record === "") writeFileSync(join(dir, SES_SESSION_FILE_NAME), "", { mode: 0o600 }); else install(record);
      const error = await loadSesSession(source, T0).catch(e => e);
      assert.ok(error instanceof SesCredentialsUnavailableError, JSON.stringify(record).slice(0, 80));
      assert.equal(error.reason, "malformed");
      assert.equal("cause" in error, false);
      assertNoSecrets(error, error.stack, error.message);
    }
  });

  it("refuses credentials from an unknown or ambiguous source", async () => {
    install(session("VALID", T0 + HOUR, { FederatedUser: { Arn: "arn:aws:sts::000000000000:federated-user/someone-else" } }));
    assert.equal(await reason(loadSesSession(source, T0)), "unknown_source");
    const unsourced = session("VALID"); delete (unsourced as any).FederatedUser; install(unsourced);
    assert.equal(await reason(loadSesSession(source, T0)), "unknown_source");
    install(session("VALID", T0 + HOUR, { AssumedRoleUser: { Arn: SOURCE } }));
    assert.equal(await reason(loadSesSession(source, T0)), "unknown_source");
  });

  it("refuses readable-by-others files, symlinks and writable directories", async () => {
    install(session("VALID"), 0o640);
    assert.equal(await reason(loadSesSession(source, T0)), "unsafe_file");
    const elsewhere = mkdtempSync(join(tmpdir(), "ses-elsewhere-"));
    try {
      writeFileSync(join(elsewhere, "record.json"), JSON.stringify(session("VALID")), { mode: 0o600 });
      rmSync(join(dir, SES_SESSION_FILE_NAME));
      symlinkSync(join(elsewhere, "record.json"), join(dir, SES_SESSION_FILE_NAME));
      assert.equal(await reason(loadSesSession(source, T0)), "unsafe_file");
    } finally { rmSync(elsewhere, { recursive: true, force: true }); }
    rmSync(join(dir, SES_SESSION_FILE_NAME)); install(session("VALID"));
    chmodSync(dir, 0o777);
    assert.equal(await reason(loadSesSession(source, T0)), "unsafe_file");
  });

  it("parses the pure record independently of the filesystem", () => {
    assert.equal(parseSesSession(JSON.stringify(session("VALID")), SOURCE, T0).secretAccessKey, "SECRETMARKER-VALID");
    assert.throws(() => parseSesSession(JSON.stringify(session("VALID")), SOURCE, T0 + 7 * HOUR), SesCredentialsUnavailableError);
  });
});

describe("SES credential provider rotation", () => {
  it("re-reads a rotated session and caps the reported expiry to the re-read interval", async () => {
    let now = T0;
    const provider = sesSessionCredentialProvider(source, { now: () => now, rereadMs: 60_000 });
    install(session("ROTA"));
    const first = await provider();
    assert.equal(first.accessKeyId, keyOf("ROTA"));
    // The SDK refreshes 5 minutes before the reported expiry: re-read after 60s, not after 6h.
    assert.equal(first.expiration!.getTime(), T0 + 5 * 60_000 + 60_000);
    install(session("ROTB", T0 + 10 * HOUR));
    now += 61_000;
    const second = await provider();
    assert.deepEqual([second.accessKeyId, second.sessionToken], [keyOf("ROTB"), "TOKENMARKER-ROTB"]);
    // A session shorter than the cap reports its real expiry.
    install(session("ROTC", now + 5 * 60_000 + 10_000));
    assert.equal((await provider()).expiration!.getTime(), now + 5 * 60_000 + 10_000);
    // Removal or expiry after start rejects instead of retaining the last good session.
    rmSync(join(dir, SES_SESSION_FILE_NAME));
    assert.equal(await reason(provider()), "missing");
    install(session("ROTD", now + HOUR));
    now += HOUR;
    assert.equal(await reason(provider()), "expired");
    assertNoSecrets();
  });

  it("logs sanitized state transitions once, never values or paths", async () => {
    const provider = sesSessionCredentialProvider(source, { now: () => T0 });
    await provider().catch(() => undefined); await provider().catch(() => undefined);
    install(session("ROTA")); await provider(); await provider();
    install(session("ROTB", T0 + 7 * HOUR)); await provider();
    assert.deepEqual(logs.map(line => JSON.parse(line)), [
      { event: "ses_credentials_unavailable", reason: "missing" },
      { event: "ses_credentials_ready", expiresAt: new Date(T0 + 6 * HOUR).toISOString() },
      { event: "ses_credentials_ready", expiresAt: new Date(T0 + 7 * HOUR).toISOString() },
    ]);
    assertNoSecrets();
  });
});

describe("SES SDK client with the runtime provider (no network)", () => {
  type Signed = { keyId: string; token: string };
  function capturingClient(rereadMs: number) {
    const signed: Signed[] = [];
    const client = new SESClient({
      region: "eu-west-2", maxAttempts: 1, credentials: sesSessionCredentialProvider(source, { rereadMs }),
      // Records what was signed, then refuses: nothing leaves the process.
      requestHandler: { handle: async (request: { headers: Record<string, string> }) => {
        const keyId = /Credential=([^/]+)\//.exec(request.headers.authorization ?? "")?.[1] ?? "";
        signed.push({ keyId, token: request.headers["x-amz-security-token"] ?? "" });
        throw Object.assign(new Error("synthetic transport refusal"), { name: "SyntheticTransportRefusal" });
      } } as any,
    });
    const send = () => client.send(new SendRawEmailCommand({ RawMessage: { Data: Buffer.from("synthetic") } }));
    return { client, signed, send };
  }
  const tagOf = (s: Signed) => s.keyId.slice(4, 8);

  it("signs with the rotated session after the re-read interval, without a restart", async () => {
    install(session("ROTA", Date.now() + 6 * HOUR));
    const { client, signed, send } = capturingClient(50);
    try {
      await assert.rejects(send(), /synthetic transport refusal/);
      install(session("ROTB", Date.now() + 6 * HOUR));
      await new Promise(resolve => setTimeout(resolve, 80));
      await assert.rejects(send(), /synthetic transport refusal/);
      assert.deepEqual(signed.map(tagOf), ["ROTA", "ROTB"]);
      assert.deepEqual(signed.map(s => s.token), ["TOKENMARKER-ROTA", "TOKENMARKER-ROTB"]);
    } finally { client.destroy(); }
  });

  it("keeps every concurrent request on one complete credential tuple during rotation", async () => {
    install(session("ROTA", Date.now() + 6 * HOUR));
    const { client, signed, send } = capturingClient(0); // re-read on every resolution
    try {
      const inFlight: Promise<unknown>[] = [];
      for (let round = 0; round < 10; round++) {
        for (let i = 0; i < 5; i++) inFlight.push(send().catch(error => error));
        install(session(round % 2 ? "ROTA" : "ROTB", Date.now() + 6 * HOUR));
        // The SDK memoizes per millisecond of remaining lifetime; let the clock move between rounds.
        await new Promise(resolve => setTimeout(resolve, 3));
      }
      const outcomes = await Promise.all(inFlight);
      // Every request was signed (none failed on a half-written record) ...
      assert.equal(signed.length, 50);
      assert.ok(outcomes.every(o => o instanceof Error && o.name === "SyntheticTransportRefusal"));
      // ... and never mixed one session's key id with another session's token.
      for (const s of signed) assert.equal(s.token, `TOKENMARKER-${tagOf(s)}`);
      assert.ok(new Set(signed.map(tagOf)).size === 2, `both sessions were observed: ${signed.map(tagOf).join(",")}`);
    } finally { client.destroy(); }
  });

  it("refuses to sign once the session expires after start, as a retryable pre-send failure", async () => {
    install(session("ROTA", Date.now() + 5 * 60_000 + 150));
    const { client, signed, send } = capturingClient(10);
    try {
      await assert.rejects(send(), /synthetic transport refusal/);
      await new Promise(resolve => setTimeout(resolve, 200));
      const error = await send().catch(e => e);
      assert.ok(error instanceof SesCredentialsUnavailableError);
      assert.equal(error.reason, "expired");
      assert.equal(signed.length, 1, "nothing was signed with expired credentials");
      // Durable email jobs treat this as proven pre-send: safe to retry after renewal.
      assert.equal(classifySesError(error)?.retryable, true);
      assertNoSecrets(error, error.stack);
    } finally { client.destroy(); }
  });
});

describe("SES credential readiness", () => {
  const dirConfig = () => ({ SES_SESSION_DIRECTORY: dir, SES_SESSION_SOURCE_ARN: SOURCE });

  it("is ready only for a valid session when a session directory is configured", async () => {
    const opts = { production: true, requireVerifiableExpiry: true, now: T0 };
    assert.deepEqual(await sesCredentialReadiness(dirConfig(), opts), { ready: false, reason: "missing" });
    install(session("VALID"));
    assert.deepEqual(await sesCredentialReadiness(dirConfig(), opts), { ready: true, source: "session-directory" });
    assert.deepEqual(await sesCredentialReadiness(dirConfig(), { ...opts, now: T0 + 6 * HOUR }), { ready: false, reason: "expired" });
    install('{"Credentials":');
    assert.deepEqual(await sesCredentialReadiness(dirConfig(), opts), { ready: false, reason: "malformed" });
    assertNoSecrets();
  });

  it("keeps Sandbox/development environment credentials, but production signup needs a verifiable expiry", async () => {
    assert.deepEqual(await sesCredentialReadiness({}, { production: false, requireVerifiableExpiry: true }), { ready: true, source: "sdk-default" });
    assert.deepEqual(await sesCredentialReadiness({}, { production: true, requireVerifiableExpiry: false }), { ready: true, source: "sdk-default" });
    assert.deepEqual(await sesCredentialReadiness({}, { production: true, requireVerifiableExpiry: true }), { ready: false, reason: "unverifiable_source" });
  });
});

describe("SES session configuration", () => {
  const configUrl = new URL("../config/index.js", import.meta.url).href;
  function load(extra: Record<string, string | undefined>) {
    const cwd = mkdtempSync(join(tmpdir(), "ses-config-"));
    try {
      return spawnSync(process.execPath, ["--input-type=module", "-e", `const {config}=await import(${JSON.stringify(configUrl)});console.log(JSON.stringify([config.SES_SESSION_DIRECTORY??null,config.SES_SESSION_SOURCE_ARN??null]));`], {
        cwd, encoding: "utf8", timeout: 10_000,
        // NODE_ENV=development: test mode would (correctly) blank these variables.
        env: { PATH: process.env.PATH, HOME: cwd, NODE_ENV: "development", DATABASE_URL: "postgresql://unused@127.0.0.1:1/never_connect", JWT_SECRET: "synthetic-jwt", PAYMENT_ABUSE_HMAC_SECRET: "synthetic-shared-abuse-secret-at-least-32", CLIENT_IP_MODE: "direct", ...extra },
      });
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  }
  it("accepts both values together and rejects partial or unsafe configuration", () => {
    const ok = load({ SES_SESSION_DIRECTORY: "/run/colorful/ses", SES_SESSION_SOURCE_ARN: SOURCE });
    assert.equal(ok.status, 0, ok.stderr);
    assert.deepEqual(JSON.parse(ok.stdout.trim().split("\n").at(-1)!), ["/run/colorful/ses", SOURCE]);
    assert.equal(load({}).status, 0);
    for (const extra of [{ SES_SESSION_DIRECTORY: "/run/colorful/ses" }, { SES_SESSION_SOURCE_ARN: SOURCE },
      { SES_SESSION_DIRECTORY: "relative/ses", SES_SESSION_SOURCE_ARN: SOURCE }, { SES_SESSION_DIRECTORY: "/run/colorful/../ses", SES_SESSION_SOURCE_ARN: SOURCE },
      { SES_SESSION_DIRECTORY: "/run/colorful/ses", SES_SESSION_SOURCE_ARN: "arn:aws:iam::000000000000:user/admin" }]) {
      assert.equal(load(extra).status, 1, JSON.stringify(extra));
    }
  });
  it("the automated test runner blanks inherited session configuration", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ses-config-test-"));
    try {
      const child = spawnSync(process.execPath, ["--input-type=module", "-e", `const {config}=await import(${JSON.stringify(configUrl)});if(config.SES_SESSION_DIRECTORY||config.SES_SESSION_SOURCE_ARN)process.exit(3);`], {
        cwd, encoding: "utf8", timeout: 10_000,
        env: { PATH: process.env.PATH, HOME: cwd, NODE_ENV: "test", DATABASE_URL: "postgresql://unused@127.0.0.1:1/development", TEST_DATABASE_URL: "postgresql://unused@127.0.0.1:1/colorful_life_test",
          JWT_SECRET: "synthetic-jwt", SES_SESSION_DIRECTORY: "/run/colorful/ses", SES_SESSION_SOURCE_ARN: SOURCE },
      });
      assert.equal(child.status, 0, child.stderr);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
});

describe("SES SDK signing never uses expired or near-expiry cached credentials (mocked clock)", () => {
  const MIN = 60_000;
  type Signed = { keyId: string; token: string; at: number };
  const amzDate = (v: string) => Date.parse(v.replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/, "$1-$2-$3T$4:$5:$6Z"));
  function client() {
    const signed: Signed[] = [];
    // Production defaults: Date.now clock and the 60 s re-read interval.
    const c = new SESClient({ region: "eu-west-2", maxAttempts: 1, credentials: sesSessionCredentialProvider(source), requestHandler: { handle: async (request: { headers: Record<string, string> }) => {
      signed.push({ keyId: /Credential=([^/]+)\//.exec(request.headers.authorization ?? "")?.[1] ?? "", token: request.headers["x-amz-security-token"] ?? "", at: amzDate(request.headers["x-amz-date"] ?? "") });
      throw Object.assign(new Error("synthetic transport refusal"), { name: "SyntheticTransportRefusal" });
    } } as any });
    const send = () => c.send(new SendRawEmailCommand({ RawMessage: { Data: Buffer.from("synthetic") } })).then(() => "sent", (e: Error) => e.name);
    return { c, signed, send };
  }
  const expiries = new Map<string, number>();
  function installTagged(tag: string, expiresAt: number) { expiries.set(keyOf(tag), expiresAt); install(session(tag, expiresAt)); }
  function assertInvariant(signed: Signed[]) {
    for (const s of signed) {
      assert.equal(s.token, `TOKENMARKER-${s.keyId.slice(4, 8)}`, "complete tuple");
      assert.ok(expiries.get(s.keyId)! - s.at >= 5 * MIN, `signed with ${(expiries.get(s.keyId)! - s.at) / 1000}s of real lifetime left`);
    }
  }
  beforeEach(() => { expiries.clear(); mock.timers.enable({ apis: ["Date"], now: T0 }); });
  afterEach(() => mock.timers.reset());

  it("stops signing before the 5-minute margin even while a cached identity is inside its 60 s interval", async () => {
    installTagged("EXPA", T0 + 5 * MIN + 30_000);
    const { c, signed, send } = client();
    try {
      assert.equal(await send(), "SyntheticTransportRefusal");          // T+0: resolves A
      mock.timers.tick(20_000); assert.equal(await send(), "SyntheticTransportRefusal"); // cached, 310 s left
      mock.timers.tick(11_000);                                           // 299 s left: inside the interval
      assert.equal(await send(), "CredentialsProviderError");
      for (let i = 0; i < 6; i++) { mock.timers.tick(10_000); assert.equal(await send(), "CredentialsProviderError"); }
      assert.equal(signed.length, 2); assertInvariant(signed);
      // Renewal recovers without a restart.
      installTagged("EXPB", Date.now() + 60 * MIN);
      assert.equal(await send(), "SyntheticTransportRefusal");
      assert.equal(signed.at(-1)!.keyId, keyOf("EXPB")); assertInvariant(signed);
    } finally { c.destroy(); }
  });

  it("uses a superseded session for at most the 60 s interval, and only while it is still valid", async () => {
    installTagged("ROTA", T0 + 2 * 60 * MIN);
    const { c, signed, send } = client();
    try {
      await send();
      mock.timers.tick(10_000); installTagged("ROTB", T0 + 3 * 60 * MIN);
      for (let t = 10_000; t < 120_000; t += 5_000) { await send(); mock.timers.tick(5_000); }
      const lastA = Math.max(...signed.filter(s => s.keyId === keyOf("ROTA")).map(s => s.at));
      assert.ok(lastA - T0 <= 60_000, "stale session bounded by the re-read interval");
      assert.equal(signed.at(-1)!.keyId, keyOf("ROTB"));
      assertInvariant(signed);
    } finally { c.destroy(); }
  });

  it("fails closed when a cached valid session is replaced by a near-expiry one", async () => {
    installTagged("ROTA", T0 + 2 * 60 * MIN);
    const { c, signed, send } = client();
    try {
      await send();
      installTagged("ROTC", T0 + 4 * MIN);   // renewal produced an unusable session
      mock.timers.tick(61_000);
      assert.equal(await send(), "CredentialsProviderError");
      assert.equal(signed.length, 1); assertInvariant(signed);
    } finally { c.destroy(); }
  });

  it("concurrent requests at the refresh boundary all refuse an expiring session and never sign", async () => {
    installTagged("ROTA", T0 + 5 * MIN + 61_000);
    const { c, signed, send } = client();
    try {
      await send();
      mock.timers.tick(62_000);               // interval elapsed and real lifetime now < 5 min
      const outcomes = await Promise.all(Array.from({ length: 20 }, () => send()));
      assert.deepEqual(new Set(outcomes), new Set(["CredentialsProviderError"]));
      assert.equal(signed.length, 1); assertInvariant(signed);
    } finally { c.destroy(); }
  });
});
