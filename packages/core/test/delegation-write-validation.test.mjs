import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { delegationAuthority, delegationJson, delegationRecord, delegationPreparedExecutionJson,
  delegationPreparedExecutionDigest } from "../dist/harness/delegation-write-validation.js";

function authority(changes = {}) {
  return { schemaVersion: 1, authoritySetId: "set", sourceRevision: "policy", workspaceId: "workspace",
    participantIds: ["engineer"], runnerIds: ["pi"], maxDepth: 3, sandbox: "workspace_write", mayEscalate: false,
    tools: ["read"], toolDecisions: { read: "allow" }, workspaceRoots: [{ path: "/tmp", access: "read" }],
    providers: [{ providerId: "fixture", baseUrl: "https://example.invalid/v1", api: "responses", model: "fixture" }],
    networkScopes: [], secretRefs: [], ...changes };
}

for (const field of ["workspaceRoots", "providers", "tools", "participantIds", "runnerIds", "networkScopes", "secretRefs"]) {
  test(`authority ${field} rejects accessor/sparse/custom arrays without running getters`, () => {
    let reads = 0;
    const accessor = [];
    Object.defineProperty(accessor, "0", { get() { reads++; throw new Error("getter ran"); }, enumerable: true });
    assert.throws(() => delegationAuthority(authority({ [field]: accessor })), { code: "delegation.authority_invalid" });
    assert.equal(reads, 0);
    assert.throws(() => delegationAuthority(authority({ [field]: new Array(1) })), { code: "delegation.authority_invalid" });
    const custom = [];
    Object.setPrototypeOf(custom, { custom: true });
    assert.throws(() => delegationAuthority(authority({ [field]: custom })), { code: "delegation.authority_invalid" });
  });
}

test("authority rejects proxy records and arrays without consulting proxy traps", () => {
  let calls = 0;
  const proxy = new Proxy({}, { getPrototypeOf() { calls++; throw new Error("trap ran"); } });
  assert.throws(() => delegationRecord(proxy, []), { code: "delegation.invalid_input" });
  const arrayProxy = new Proxy([], { get() { calls++; throw new Error("trap ran"); } });
  assert.throws(() => delegationAuthority(authority({ workspaceRoots: arrayProxy })), { code: "delegation.authority_invalid" });
  assert.equal(calls, 0);
});

test("canonical JSON rejects accessor and proxy arrays rather than executing them", () => {
  let calls = 0;
  const value = [];
  Object.defineProperty(value, "0", { get() { calls++; throw new Error("getter ran"); }, enumerable: true });
  assert.throws(() => delegationJson({ value }), { code: "delegation.invalid_input" });
  assert.throws(() => delegationJson(new Proxy([], {})), { code: "delegation.invalid_input" });
  assert.equal(calls, 0);
});

test("canonical JSON rejects nested proxy records before enumerating their keys", () => {
  let calls = 0;
  const proxy = new Proxy({}, { ownKeys() { calls++; throw new Error("must not enumerate"); } });
  for (const value of [proxy, { nested: proxy }]) {
    assert.throws(() => delegationJson(value), { code: "delegation.invalid_input" });
  }
  assert.equal(calls, 0);
});

test("prepared-only serialization preserves SDK fingerprint bytes without changing canonical ledger JSON", () => {
  const sdkBody = { schemaVersion: 1, boundary: "pi-model-context", taskId: "task", systemPrompt: "System",
    userPrompt: "User", model: { id: "model", provider: "provider", api: "responses" }, thinkingLevel: "off", tools: [] };
  const fingerprint = createHash("sha256").update(JSON.stringify(sdkBody)).digest("hex");
  const value = { schemaVersion: 1, kind: "delegation.execution.v1", runnerExecutionInput: { preparedInput: { ...sdkBody, fingerprint } } };
  const raw = delegationPreparedExecutionJson(value), restored = JSON.parse(raw).runnerExecutionInput.preparedInput;
  const { fingerprint: restoredHash, ...body } = restored;
  assert.equal(createHash("sha256").update(JSON.stringify(body)).digest("hex"), restoredHash);
  assert.equal(restoredHash, fingerprint);
  assert.equal(raw, JSON.stringify(value));
  assert.equal(delegationPreparedExecutionDigest(value), createHash("sha256").update(raw).digest("hex"));
  assert.notEqual(delegationJson(value), raw, "canonical budget/result representation remains independently sorted");
});

test("prepared-only serialization retains strict data-only rejection before JSON hooks can execute", () => {
  let reads = 0;
  const withGetter = {};
  Object.defineProperty(withGetter, "preparedInput", { enumerable: true, get() { reads++; throw new Error("must not read"); } });
  for (const value of [withGetter, { toJSON() { reads++; return {}; } }, new Proxy([], {})]) {
    assert.throws(() => delegationPreparedExecutionJson(value), { code: "delegation.invalid_input" });
  }
  assert.equal(reads, 0);
});
