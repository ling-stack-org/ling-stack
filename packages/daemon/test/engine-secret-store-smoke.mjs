import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createEngineSecretStore } from "../dist/features/execution-engines/engine-secret-store.js";

// Explicit-only OS smoke. Never reads, lists or changes an existing credential.
const store = createEngineSecretStore();
const ref = `keychain:ling-engine-${randomUUID()}`;
const secret = `synthetic-smoke-${randomUUID()}`;
try {
  assert.equal(store.status(ref).configured, false);
  store.write(ref, secret);
  assert.equal(store.status(ref).configured, true);
  assert.equal(store.resolve(ref).value, secret);
  const reopened = createEngineSecretStore();
  assert.equal(reopened.resolve(ref).value, secret);
} finally {
  store.remove(ref);
  assert.equal(store.status(ref).configured, false);
}
console.log(JSON.stringify({ platform: process.platform, nativeCredentialStore: "pass", createdReadReopenedRemoved: true, usedRealAccount: false }));
