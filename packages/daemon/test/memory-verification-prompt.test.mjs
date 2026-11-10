import assert from "node:assert/strict";
import test from "node:test";
import { memoryEligibilityForView, recalledMemoryToContextSource } from "../dist/features/channels/context-processing/memory.js";
import { assertPreselectedMemoryCurrent, createMemorySourceRevisions, renderUsedMemoryPrompt, renderUsedMemoryPromptForView } from "../dist/features/memory/prompt.js";

function item(overrides = {}) {
  return {
    memory: { id: "synthetic_memory", workspaceId: "workspace_default", scopeType: "channel", ownerId: "channel_a",
      title: "Runtime observation", body: "Synthetic service location", tags: [], sourceRefs: [{ type: "run-event", id: "event" }],
      reviewState: "active", enabled: true, sensitivity: "normal", verifyBeforeUse: true,
      createdAt: "2026-09-07T00:00:00Z", updatedAt: "2026-09-07T00:00:00Z", ...overrides },
    score: 10, matchedTerms: ["service"], excerpt: "Synthetic service location",
  };
}

test("verification-required memories cannot be public quote sources", () => {
  const source = recalledMemoryToContextSource({ item: item() });
  const eligibility = memoryEligibilityForView(source, "ling_agent_channel_view");
  assert.equal(eligibility.mode, "influence_only");
  assert.equal(eligibility.quotePolicy, "influence_only");
  assert.equal(source.metadata.verifyBeforeUse, true);
});

test("ordinary run prompts explicitly require verification before factual use", () => {
  const prompt = renderUsedMemoryPrompt([item()]);
  assert.match(prompt, /Verification: required/);
  assert.match(prompt, /not execution evidence/);
  assert.match(prompt, /Synthetic service location/);
});

test("shared view prompts preserve verification status and source identity", () => {
  for (const viewKind of ["ling_agent_channel_view", "private_chat_view", "workflow_step_view"]) {
    const result = renderUsedMemoryPromptForView({ memories: [item()], viewKind, recallPolicyVersion: "synthetic-policy" });
    assert.match(result.prompt, /Verification: required/);
    assert.match(result.prompt, /influence_only/);
    assert.deepEqual(result.memoryIds, ["synthetic_memory"]);
  }
});

test("verification does not bypass private, secret or selector filtering", () => {
  const privateItem = item({ scopeType: "teammate", ownerId: "agent_a", sensitivity: "private" });
  for (const options of [
    { viewKind: "ling_agent_channel_view", consumerTeammateId: "agent_a" },
    { viewKind: "private_chat_view", consumerTeammateId: "agent_b" },
    { viewKind: "selector_view", consumerTeammateId: "agent_a" },
  ]) {
    const result = renderUsedMemoryPromptForView({ memories: [privateItem], recallPolicyVersion: "test", ...options });
    assert.equal(result.prompt, undefined);
    assert.deepEqual(result.memoryIds, []);
  }
  assert.equal(renderUsedMemoryPromptForView({ memories: [item({ sensitivity: "secret-adjacent" })],
    viewKind: "ling_agent_channel_view", recallPolicyVersion: "test" }).prompt, undefined);
});

test("matching private consumer keeps the clue but never public quotation", () => {
  const result = renderUsedMemoryPromptForView({
    memories: [item({ scopeType: "teammate", ownerId: "agent_a", sensitivity: "private" })],
    viewKind: "private_chat_view", consumerTeammateId: "agent_a", recallPolicyVersion: "test",
  });
  assert.match(result.prompt, /Verification: required/);
  assert.match(result.prompt, /influence_only/);
});

test("verified current memory retains existing public-quote policy", () => {
  const recalled = item({ verifyBeforeUse: false });
  const source = recalledMemoryToContextSource({ item: recalled });
  assert.equal(memoryEligibilityForView(source, "ling_agent_channel_view").mode, "public_quote");
  assert.doesNotMatch(renderUsedMemoryPrompt([recalled]), /Verification: required/);
});

test("verification-required does not weaken an existing inspect-only restriction", () => {
  const source = recalledMemoryToContextSource({ item: item() });
  const restricted = { ...source, metadata: { ...source.metadata, quotePolicy: "inspect_only" } };
  assert.equal(memoryEligibilityForView(restricted, "ling_agent_channel_view").mode, "inspect_only");
});

test("ordinary run prompts keep matching private memory influence-only even when verification is not required", () => {
  const prompt = renderUsedMemoryPrompt([item({ scopeType: "teammate", ownerId: "agent_a", sensitivity: "private", verifyBeforeUse: false })]);
  assert.match(prompt, /Quote policy: influence_only/);
  assert.match(prompt, /do not quote or present as public memory/);
});

test("Memory source revision is key-order stable, ignores last use, and binds every semantic source field", () => {
  const memory = item().memory;
  const baseline = createMemorySourceRevisions([memory]);
  assert.match(baseline[0].semanticHash, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(createMemorySourceRevisions([{ ...memory, lastUsedAt: "2026-10-24T00:00:00Z" }]), baseline);
  assert.deepEqual(createMemorySourceRevisions([Object.fromEntries(Object.entries(memory).reverse())]), baseline);
  for (const patch of [{ body: "different" }, { title: "different" }, { updatedAt: "2026-10-24T00:00:00Z" },
    { sourceRefs: [{ type: "run-event", id: "different" }] }, { reviewState: "archived" }, { enabled: false },
    { sensitivity: "private" }, { verifyBeforeUse: false }, { scopeType: "teammate" }, { ownerId: "different" },
    { workspaceId: "different" }, { tags: ["different"] }]) {
    assert.notDeepEqual(createMemorySourceRevisions([{ ...memory, ...patch }]), baseline, JSON.stringify(patch));
  }
});

test("first-hydration Memory guard accepts only exact bound sources and current scope without fresh recall", () => {
  const memory = item().memory;
  const selected = { memoryIds: [memory.id], recallQuery: "service", policyVersion: "fixture",
    renderedPrompt: renderUsedMemoryPrompt([item()]), sourceRevisions: createMemorySourceRevisions([memory]) };
  const request = { teammateId: "agent_a", task: { id: "task_a", channelId: "channel_a" }, preselectedMemoryUse: selected };
  let current = memory, eligible = [memory.id], bodyReads = 0;
  const store = { readSnapshot: callback => callback(),
    getEligibleMemoryIdsForRecall(scope, ids) {
      assert.equal(scope.teammateId, request.teammateId);
      assert.equal(scope.taskId, request.task.id);
      assert.equal(scope.channelId, request.task.channelId);
      assert.equal(scope.intent, "task-run");
      assert.deepEqual(ids, selected.memoryIds);
      return eligible;
    },
    getMemoryObject(id) { assert.equal(id, memory.id); bodyReads++; return current; },
    recallMemory() { throw new Error("validation must not reselect Memory"); } };
  assert.doesNotThrow(() => assertPreselectedMemoryCurrent(store, request));
  current = { ...memory, lastUsedAt: "2026-10-24T00:00:00Z" };
  assert.doesNotThrow(() => assertPreselectedMemoryCurrent(store, request));
  current = { ...memory, body: "changed before hydration" };
  assert.throws(() => assertPreselectedMemoryCurrent(store, request), { code: "prepared_memory_unavailable" });
  eligible = [];
  const before = bodyReads;
  assert.throws(() => assertPreselectedMemoryCurrent(store, request), { code: "prepared_memory_unavailable" });
  assert.equal(bodyReads, before, "foreign or revoked sources must fail before body decoding");
});

test("first-hydration Memory guard rejects missing, partial, duplicate, foreign and malformed revisions", () => {
  const memory = item().memory;
  const selected = { memoryIds: [memory.id], recallQuery: "service", policyVersion: "fixture",
    renderedPrompt: "private rendered clue", sourceRevisions: createMemorySourceRevisions([memory]) };
  const request = { task: { id: "task_a" }, preselectedMemoryUse: selected };
  const store = { readSnapshot() { throw new Error("malformed selection must fail before reads"); } };
  for (const sourceRevisions of [undefined, [], [selected.sourceRevisions[0], selected.sourceRevisions[0]],
    [{ ...selected.sourceRevisions[0], memoryId: "foreign" }], [{ ...selected.sourceRevisions[0], semanticHash: "not-a-digest" }],
    [{ ...selected.sourceRevisions[0], extra: "not-authority" }]]) {
    assert.throws(() => assertPreselectedMemoryCurrent(store,
      { ...request, preselectedMemoryUse: { ...selected, sourceRevisions } }), { code: "prepared_memory_unavailable" });
  }
  assert.doesNotThrow(() => assertPreselectedMemoryCurrent(store, { task: request.task }));
});
