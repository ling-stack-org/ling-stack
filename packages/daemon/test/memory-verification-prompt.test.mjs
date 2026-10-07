import assert from "node:assert/strict";
import test from "node:test";
import { memoryEligibilityForView, recalledMemoryToContextSource } from "../dist/features/channels/context-processing/memory.js";
import { renderUsedMemoryPrompt, renderUsedMemoryPromptForView } from "../dist/features/memory/prompt.js";

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
