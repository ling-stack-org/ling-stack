import assert from "node:assert/strict";
import test from "node:test";
import { recallMemory, resolveAutomaticMemoryRecallScope } from "../dist/features/memory/recall-service.js";

function fixture(overrides = {}) {
  const calls = [];
  const teammate = { id: "agent", workspaceId: "workspace_default", status: "active" };
  const channel = { id: "channel", workspaceId: teammate.workspaceId, status: "active" };
  const task = { id: "task", workspaceId: teammate.workspaceId, channelId: channel.id, assigneeTeammateId: teammate.id };
  const run = { id: "run", channelId: channel.id, taskId: task.id, teammateId: teammate.id };
  const store = {
    getAiTeammate: id => id === teammate.id ? teammate : undefined,
    getChannel: id => id === channel.id ? channel : undefined,
    getTask: id => id === task.id ? task : undefined,
    getRun: id => id === run.id ? run : undefined,
    listTeammateChannelMemberships: () => [{ channelId: channel.id, teammateId: teammate.id }],
    recallMemory(input) { calls.push(input); return { request: input, memories: [], policyVersion: "fixture" }; },
    ...overrides,
  };
  const request = { teammateId: teammate.id, channelId: channel.id, taskId: task.id, runId: run.id,
    intent: "task-run", query: "safe synthetic query" };
  return { store, request, calls, teammate, channel, task, run };
}

test("automatic recall verifies durable ownership and discards inspection flags before lexical lookup", async () => {
  const f = fixture();
  await recallMemory(f.store, { ...f.request, includePrivate: true, includeDisabled: true, includeSecretAdjacent: true });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].workspaceId, "workspace_default");
  for (const field of ["includePrivate", "includeDisabled", "includeSecretAdjacent"]) assert.equal(f.calls[0][field], false);
  assert.equal(f.calls[0].taskId, "task"); assert.equal(f.calls[0].runId, "run");
});

test("unknown identities, non-members, foreign lineage and workspace relabels never reach body retrieval", async () => {
  const cases = [
    { input: { teammateId: "unknown" } }, { input: { channelId: "unknown" } }, { input: { runId: "unknown" } },
    { input: { workspaceId: "foreign" } },
    { store: { listTeammateChannelMemberships: () => [] } },
    { store: { getAiTeammate: () => ({ id: "agent", workspaceId: "foreign", status: "active" }) } },
    { store: { getAiTeammate: () => ({ id: "agent", workspaceId: "workspace_default", status: "disabled" }) } },
    { store: { getChannel: () => ({ id: "channel", workspaceId: "workspace_default", status: "archived" }) } },
    { store: { getTask: () => ({ id: "task", workspaceId: "workspace_default", channelId: "foreign" }) } },
    { store: { getTask: () => ({ id: "task", workspaceId: "workspace_default", channelId: "channel", assigneeTeammateId: "peer" }) } },
    { store: { getRun: () => ({ id: "run", taskId: "foreign", channelId: "channel", teammateId: "agent" }) } },
    { store: { getRun: () => ({ id: "run", taskId: "task", channelId: "channel", teammateId: "peer" }) } },
  ];
  for (const entry of cases) {
    const f = fixture(entry.store);
    const result = await recallMemory(f.store, { ...f.request, ...entry.input });
    assert.deepEqual(result.memories, []);
    assert.equal(result.audit.scopeRejected, true);
    assert.equal(f.calls.length, 0, JSON.stringify(entry.input));
    assert.deepEqual(Object.keys(result.audit).sort(), ["candidateCount", "scopeRejected", "selectedMemoryIds", "strategy"]);
  }
});

test("an unpersisted request cannot claim a task memory scope; system Agent still gets verified shared channel context", async () => {
  const f = fixture();
  const scope = resolveAutomaticMemoryRecallScope(f.store, { ...f.request, taskId: "not_persisted", runId: undefined });
  assert.equal(scope.taskId, undefined); assert.equal(scope.channelId, "channel");
  await recallMemory(f.store, { ...f.request, teammateId: "ling_agent", taskId: undefined, runId: undefined });
  assert.equal(f.calls[0].teammateId, "ling_agent");
  assert.equal(f.calls[0].channelId, "channel");
});

test("private chat does not acquire channel or task scopes and membership removal revokes the next recall", async () => {
  const f = fixture();
  await recallMemory(f.store, { teammateId: "agent", intent: "private-chat", query: "preference" });
  assert.equal(f.calls[0].channelId, undefined); assert.equal(f.calls[0].taskId, undefined);
  f.store.listTeammateChannelMemberships = () => [];
  const result = await recallMemory(f.store, f.request);
  assert.equal(result.audit.scopeRejected, true); assert.equal(f.calls.length, 1);
});

test("explicit search/review retain existing local management inspection semantics", async () => {
  const f = fixture();
  for (const intent of ["search", "review"]) {
    const input = { ...f.request, intent, includeDisabled: true, includeSecretAdjacent: true };
    await recallMemory(f.store, input);
    assert.deepEqual(f.calls.at(-1), input);
  }
});
