import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import test from "node:test";
import { createDelegationHostAuthority } from "../dist/features/harness/delegations/host-authority.js";
import { createDelegationLifecycleAuthority } from "../dist/features/harness/delegations/lifecycle-authority.js";
import { createDelegationPriceRegistry } from "../dist/features/harness/delegations/price-registry.js";

const fence = { workUnitId: "unit", attemptId: "attempt", runtimeInstanceId: "runtime", fencingToken: "fence" };
const provider = { providerId: "qa", baseUrl: "https://provider.invalid/v1", api: "openai-responses", model: "qa-model" };
const authority = () => ({ schemaVersion: 1, authoritySetId: "set", sourceRevision: "revision", workspaceId: "workspace",
  participantIds: ["engineer"], runnerIds: ["pi"], maxDepth: 2, sandbox: "workspace_write", mayEscalate: false,
  tools: ["read"], toolDecisions: { read: "allow" }, workspaceRoots: [{ path: realpathSync.native(process.cwd()), access: "write" }],
  providers: [{ ...provider }], networkScopes: ["provider.invalid"], secretRefs: ["env:QA_KEY"] });
function fixture() {
  const original = { rootRunId: "root", runId: "root", sourceFence: { ...fence }, authority: authority(),
    budget: { tokenBudget: 100 }, currency: "USD", provider: { ...provider }, runnerId: "pi" };
  const usages = new WeakMap(), completions = new WeakMap();
  const issue = (map, payload) => { const reference = {}; map.set(reference, payload); return reference; };
  const verified = (map, reference) => {
    assert.ok(map.has(reference), "only the original adapter reference authenticates");
    return map.get(reference);
  };
  const host = createDelegationHostAuthority({ readRootAdmissionScope: () => original,
    readChildLaunchScope: (_run, _fence, participantId) => ({ ...original, authority: { ...original.authority, participantId } }),
    readCurrentExecutionAuthority: () => original.authority,
    readProviderUsageObservation: reference => verified(usages, reference),
    readChildCompletionObservation: reference => verified(completions, reference) });
  return { original, host, usage: value => issue(usages, value), completion: value => issue(completions, value) };
}

test("Host capture custody rejects serialized/copied DTOs and snapshots mutable source policy", () => {
  const f = fixture(), token = f.host.captureRoot("root", fence);
  const captured = f.host.readers.readCapture(token);
  assert.throws(() => f.host.readers.readCapture(f.original), { code: "delegation.authority_invalid" });
  assert.throws(() => f.host.readers.readCapture({ ...token }), { code: "delegation.authority_invalid" });
  assert.throws(() => f.host.readers.readCapture(JSON.parse(JSON.stringify(token))), { code: "delegation.authority_invalid" });
  f.original.authority.tools.push("write");
  f.original.budget.tokenBudget = 999;
  assert.deepEqual(captured.authority.tools, ["read"]);
  assert.equal(captured.budget.tokenBudget, 100);
  assert.throws(() => f.host.captureRoot("other-run", fence), { code: "delegation.authority_invalid" });
  assert.throws(() => f.host.captureRoot("root", { ...fence, attemptId: "other" }), { code: "delegation.authority_invalid" });
});

test("Host usage and child settlement receipts require original observations and capture by value", () => {
  const f = fixture();
  const usage = { kind: "measured", runId: "root", attemptId: "attempt", invocationId: "call", inputTokens: 10, cachedInputTokens: 0, outputTokens: 5 };
  const token = f.host.captureUsageReceipt(f.usage(usage));
  usage.inputTokens = 1000;
  assert.equal(f.host.readers.readUsageReceipt(token).inputTokens, 10);
  assert.throws(() => f.host.captureUsageReceipt({ ...usage }), /original adapter reference/);
  assert.throws(() => f.host.readers.readUsageReceipt({ ...token }), { code: "delegation.authority_invalid" });
  const child = { kind: "verified_usage", childRunId: "child", sourceFence: { ...fence } };
  const receipt = f.host.captureChildReceipt(f.completion(child));
  child.sourceFence.attemptId = "changed";
  assert.equal(f.host.readers.readChildReceipt(receipt).sourceFence.attemptId, "attempt");
  assert.throws(() => f.host.readers.readChildReceipt(child), { code: "delegation.authority_invalid" });
});

test("Runner start custody rejects ready text and copied observations, and retains original acceptance", () => {
  const reference = {}, observation = { childRunId: "child", sourceFence: { ...fence }, runnerId: "pi",
    observationId: "adapter-accepted", observedAt: "2026-10-19T00:00:00.000Z" };
  const host = createDelegationLifecycleAuthority({ readAcceptedRunnerStart: value => {
    assert.equal(value, reference, "acceptance belongs to the real adapter"); return observation;
  } });
  assert.throws(() => host.captureStart("I will execute"), /real adapter/);
  const token = host.captureStart(reference);
  observation.sourceFence.attemptId = "changed";
  assert.equal(host.readRunnerStartObservation(token).sourceFence.attemptId, "attempt");
  assert.throws(() => host.readRunnerStartObservation({ ...token }), { code: "delegation.authority_invalid" });
  assert.throws(() => host.readRunnerStartObservation(observation), { code: "delegation.authority_invalid" });
});

test("price registry freezes precise Provider/model/currency scope, never guesses a fallback", () => {
  const price = { schemaVersion: 1, version: "revision-1", currency: "USD", scope: { ...provider },
    inputMicrosPerMillionTokens: 1_000_000, cachedInputMicrosPerMillionTokens: 500_000, outputMicrosPerMillionTokens: 2_000_000 };
  const registry = createDelegationPriceRegistry([price]);
  price.outputMicrosPerMillionTokens = 999;
  price.scope.model = "changed";
  assert.equal(registry.lookup(provider, "USD").outputMicrosPerMillionTokens, 2_000_000);
  for (const field of ["providerId", "baseUrl", "api", "model"]) assert.equal(registry.lookup({ ...provider, [field]: "other" }, "USD"), undefined);
  assert.equal(registry.lookup(provider, "EUR"), undefined);
  const original = registry.lookup(provider, "USD");
  assert.throws(() => createDelegationPriceRegistry([original, original]), /price_registry_scope_duplicate/);
});
