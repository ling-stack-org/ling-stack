import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore } from "@ling-stack/core";
import { memoryEligibilityForView, recalledMemoryToContextSource } from "../dist/features/channels/context-processing/memory.js";
import { buildChannelContextView } from "../dist/features/channels/context-processing/views.js";
import { renderUsedMemoryPrompt, renderUsedMemoryPromptForView } from "../dist/features/memory/prompt.js";

const scope = { workspaceId: "workspace_default", channelId: "channel_a" };
const workingViews = ["ling_agent_channel_view", "private_chat_view", "workflow_step_view", "specialist_task_view"];
function recalled(overrides = {}) {
  return {
    memory: { id: "synthetic_shared", workspaceId: scope.workspaceId, scopeType: "channel", ownerId: scope.channelId,
      title: "Shared project rule", body: "Synthetic shared project rule", tags: [], sourceRefs: [],
      reviewState: "active", enabled: true, sensitivity: "private", verifyBeforeUse: false,
      createdAt: "2026-09-08T00:00:00Z", updatedAt: "2026-09-08T00:00:00Z", ...overrides },
    score: 10, matchedTerms: ["project"], excerpt: "Synthetic shared project rule",
  };
}
function prompt(memories, overrides = {}) {
  return renderUsedMemoryPromptForView({ ...scope, memories, viewKind: "ling_agent_channel_view",
    recallPolicyVersion: "test", ...overrides });
}

test("authorized shared private memory reaches every working view without a teammate identity", () => {
  for (const memory of [recalled(), recalled({ scopeType: "workspace", ownerId: scope.workspaceId })]) {
    for (const viewKind of workingViews) {
      const result = prompt([memory], { viewKind });
      assert.deepEqual(result.memoryIds, [memory.memory.id], `${memory.memory.scopeType}/${viewKind}`);
      assert.match(result.prompt, /Synthetic shared project rule/);
      assert.match(result.prompt, /influence_only/);
      assert.match(result.prompt, /Do not infer permissions/);
    }
  }
});

test("shared memory eligibility is not overridden by the generic private-source gate", () => {
  for (const kind of workingViews) {
    const source = recalledMemoryToContextSource({ item: recalled(), ...scope });
    const view = buildChannelContextView({ ...scope, kind, sources: [source], sections: [], sourceRefs: [] });
    assert.deepEqual(view.sources.map((entry) => entry.id), [source.id]);
    assert.deepEqual(view.dropped, []);
  }
});

test("a consumer workspace cannot relabel a memory owned by another workspace", () => {
  const memory = recalled({ workspaceId: "other_workspace", scopeType: "workspace", ownerId: "other_workspace" });
  const source = recalledMemoryToContextSource({ item: memory, ...scope });
  assert.equal(source.workspaceId, "other_workspace");
  assert.equal(prompt([memory]).prompt, undefined);
  assert.deepEqual(prompt([memory]).memoryIds, []);
});

test("shared private context requires the actual workspace/channel binding, not matching text or an inspection flag", () => {
  for (const memory of [
    recalled({ ownerId: "another_channel" }),
    recalled({ workspaceId: "other_workspace" }),
    recalled({ scopeType: "workspace", ownerId: "other_workspace" }),
    recalled({ scopeType: "teammate", ownerId: "agent_b" }),
    recalled({ sensitivity: "secret-adjacent" }),
  ]) {
    const result = prompt([memory], { consumerTeammateId: "agent_a" });
    assert.equal(result.prompt, undefined);
    assert.deepEqual(result.memoryIds, []);
    assert.deepEqual(result.sources, [], "rejected bodies cannot be carried into downstream context sources");
    const view = buildChannelContextView({ ...scope, kind: "workflow_step_view", consumerTeammateId: "agent_a",
      sources: [recalledMemoryToContextSource({ item: memory })], sections: [], sourceRefs: [] });
    assert.deepEqual(view.sources, []);
  }
  assert.equal(prompt([recalled()], { channelId: undefined }).prompt, undefined);
  assert.equal(prompt([recalled()], { workspaceId: undefined }).prompt, undefined);
  const source = recalledMemoryToContextSource({ item: recalled() });
  assert.equal(memoryEligibilityForView(source, "ling_agent_channel_view").mode, "excluded");
});

test("shared context does not open selector/proposal context or promote a private source to public quotation", () => {
  for (const viewKind of ["selector_view", "workflow_proposal_view", "evidence_inspect_view"]) {
    assert.equal(prompt([recalled()], { viewKind }).prompt, undefined);
  }
  const source = recalledMemoryToContextSource({ item: recalled() });
  assert.equal(memoryEligibilityForView(source, "ling_agent_channel_view", undefined, scope).quotePolicy, "influence_only");
  const inspectOnly = { ...source, metadata: { ...source.metadata, quotePolicy: "inspect_only" } };
  assert.equal(memoryEligibilityForView(inspectOnly, "ling_agent_channel_view", undefined, scope).mode, "inspect_only");
});

test("SQL recall and both prompt paths share working context while keeping peer private content isolated", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-shared-memory-integration-"));
  const store = createSqliteRunStore(cwd);
  t.after(async () => { store.close(); await rm(cwd, { recursive: true, force: true }); });
  for (const [id, scopeType, ownerId, sensitivity] of [
    ["workspace", "workspace", scope.workspaceId, "private"],
    ["channel", "channel", scope.channelId, "private"],
    ["mine", "teammate", "agent_a", "private"],
    ["peer", "teammate", "agent_b", "private"],
    ["other_channel", "channel", "other_channel", "private"],
    ["secret", "workspace", scope.workspaceId, "secret-adjacent"],
  ]) store.createMemoryObject({ id, scopeType, ownerId, sensitivity, title: `project ${id}`, body: `Synthetic body ${id}` }, "2026-09-08T00:00:00Z");
  for (const [intent, viewKind] of [["channel-reply", "ling_agent_channel_view"], ["private-chat", "private_chat_view"], ["task-run", "workflow_step_view"]]) {
    const recall = store.recallMemory({ ...scope, teammateId: "agent_a", intent, query: "project" });
    assert.deepEqual(new Set(recall.memories.map((entry) => entry.memory.id)), new Set(["workspace", "channel", "mine"]));
    const rendered = prompt(recall.memories, { viewKind, consumerTeammateId: "agent_a" });
    const expected = viewKind === "ling_agent_channel_view" ? ["workspace", "channel"] : ["workspace", "channel", "mine"];
    assert.deepEqual(new Set(rendered.memoryIds), new Set(expected));
    assert.match(rendered.prompt, /Synthetic body workspace/);
    assert.match(rendered.prompt, /Synthetic body channel/);
    assert.doesNotMatch(rendered.prompt, /Synthetic body (peer|other_channel|secret)/);
    const ordinary = renderUsedMemoryPrompt(recall.memories);
    assert.match(ordinary, /Synthetic body workspace/);
    assert.match(ordinary, /Quote policy: influence_only/);
    assert.doesNotMatch(ordinary, /Synthetic body (peer|other_channel|secret)/);
  }
  store.updateMemoryObject("channel", { enabled: false }, "2026-09-08T00:01:00Z");
  const revoked = store.recallMemory({ ...scope, intent: "channel-reply", query: "project" });
  assert.deepEqual(prompt(revoked.memories).memoryIds, ["workspace"]);
});
