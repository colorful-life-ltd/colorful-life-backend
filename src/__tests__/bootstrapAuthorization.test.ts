import assert from "node:assert/strict";
import { it } from "node:test";
import { BootstrapAuthorizationStore, BOOTSTRAP_AUTHORIZATION_TTL_MS } from "../domain/auth/bootstrapAuthorization.js";

it("issues owner-bound, single-use authorizations that expire after five minutes", () => {
  const store = new BootstrapAuthorizationStore();
  const token = store.issue("owner-ip", 10_000);
  assert.ok(token);
  assert.equal(token.length, 43);
  assert.equal(store.consume(token, "other-ip", 10_001), false);
  assert.equal(store.consume(token, "owner-ip", 10_001), false, "wrong-owner attempt consumes the grant");
  const reused = store.issue("owner-ip", 20_000)!;
  assert.equal(store.consume(reused, "owner-ip", 20_000 + BOOTSTRAP_AUTHORIZATION_TTL_MS), false);
  assert.equal(store.consume(reused, "owner-ip", 20_000 + BOOTSTRAP_AUTHORIZATION_TTL_MS + 1), false);
  const valid = store.issue("owner-ip", 30_000)!;
  assert.equal(store.consume(valid, "owner-ip", 30_001), true);
  assert.equal(store.consume(valid, "owner-ip", 30_002), false, "a consumed grant cannot be replayed");
});
