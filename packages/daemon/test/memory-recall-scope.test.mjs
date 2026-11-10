import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteRunStore } from "@ling-stack/core";
import { createWorkflowParticipantAuthorityV1 } from "@ling-stack/contracts";
import { recallMemory, resolveAutomaticMemoryRecallScope } from "../dist/features/memory/recall-service.js";
import { registerMemorySemanticService } from "../dist/features/memory/semantic-registry.js";
import { assertPreparedRunnerMemoryCurrent } from "../dist/features/runs/prepared-runner-input.js";

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


test("a run-only request derives verified task/channel/teammate lineage and rejects conflicting explicit owners", () => {
  const f = fixture();
  const scope = resolveAutomaticMemoryRecallScope(f.store, { runId: "run", query: "receipt", intent: "task-run" });
  for (const key of ["taskId", "channelId", "teammateId"]) assert.equal(scope[key], f.request[key]);
  assert.equal(resolveAutomaticMemoryRecallScope(f.store, { ...f.request, channelId: "other" }), undefined);
  assert.equal(resolveAutomaticMemoryRecallScope(f.store, { ...f.request, teammateId: "other" }), undefined);
});

test('durable selection audit contains aggregate exclusions and selected IDs, without query or rejected-source details',async()=>{
 const events=[];
 const f=fixture({paths:{cwd:'/synthetic'},appendControlPlaneEvent:(event)=>events.push(event),
   recallMemory:input=>({request:input,memories:[],policyVersion:'fixture',audit:{strategy:'fts5',candidateCount:2,
     eligibleCount:4,excludedCount:3,selectedMemoryIds:[]}})});
 const result=await recallMemory(f.store,{...f.request,query:'private-query-text'});
 assert.equal(events.length,1); assert.equal(result.audit.traceId,events[0].entityId);
 assert.equal(events[0].action,'memory.recall_selected'); assert.equal(events[0].data.excludedCount,3);
 assert.doesNotMatch(JSON.stringify(events),/private-query-text/);
 await recallMemory(f.store,{...f.request,channelId:'hidden-owner-name',query:'hidden-title'});
 assert.equal(events[1].data.scopeRejected,true);
 assert.doesNotMatch(JSON.stringify(events[1]),/hidden-owner-name|hidden-title/);
});

// Value: protects=durable workflow authority permits assigned nonmember recall and rejects forged ownership;
// fails_when=raw membership overrides workflow authority or an arbitrary workflow id widens recall;
// why_new=existing scope fixtures have no workflow owner and autoplan covers only the valid path; seam=none;
// no_claim=model quality or a workflow start beyond the existing owner transaction.
test("Host workflow recall respects durable participant authority without granting arbitrary owner claims", async t => {
  const f = await workflowFixture(t);
  assert.equal(resolveAutomaticMemoryRecallScope(f.store, f.request), undefined);
  assert.deepEqual((await recallMemory(f.store, f.request, f.host)).memories.map(item => item.memory.id), [f.memory.id]);
  assert.deepEqual(f.store.listTeammateChannelMemberships(f.teammate.id), [], "recall never enrolls workflow participants");
  for (const status of ["queued", "blocked", "claimed", "running"]) {
    const store = overrideStore(f.store, { getChannelWorkflowStep: () => ({ ...f.step, status }) });
    assert.equal(resolveAutomaticMemoryRecallScope(store, f.request, f.host)?.teammateId, f.teammate.id, status);
  }
  const cases = [
    { getChannelWorkflowStep: () => undefined },
    { getChannelWorkflowStep: () => ({ ...f.step, channelId: "foreign" }) },
    { getChannelWorkflowStep: () => ({ ...f.step, workspaceId: "foreign" }) },
    { getChannelWorkflowStep: () => ({ ...f.step, toParticipantId: "teammate_builtin_designer" }) },
    { getChannelWorkflowStep: () => ({ ...f.step, status: "cancelled" }) },
    { getChannelWorkflowStep: () => ({ ...f.step, taskId: "unrelated-task" }) },
    { getChannelWorkflowStep: () => ({ ...f.step, participantAuthority: { ...f.step.participantAuthority, fingerprint: "forged" } }) },
    { getChannelWorkflowStep: () => ({ ...f.step, participantAuthority: createWorkflowParticipantAuthorityV1({
      kind: "channel_selection", origin: "manual_channel_step", participantId: f.teammate.id, sourceId: "manual" }) }) },
    { getChannelWorkflow: () => ({ ...f.workflow, channelId: "foreign" }) },
    { getChannelWorkflow: () => ({ ...f.workflow, status: "succeeded" }) },
    { getAiTeammate: () => ({ ...f.teammate, hidden: true }) },
    { getAiTeammate: () => ({ ...f.teammate, status: "paused" }) },
    { getAiTeammate: () => ({ ...f.teammate, allowedTools: [] }) },
  ];
  for (const overrides of cases) {
    const result = await recallMemory(overrideStore(f.store, overrides), f.request, f.host);
    assert.deepEqual(result.memories, []);
    assert.equal(result.audit.scopeRejected, true);
  }
  assert.equal(resolveAutomaticMemoryRecallScope(f.store, { ...f.request, taskId: "not-persisted" }, f.host), undefined);
  assert.equal(resolveAutomaticMemoryRecallScope(f.store, { ...f.request, intent: "channel-reply" }, f.host), undefined);
});

// Value: protects=workflow cancellation during semantic work revokes both old lexical and vector results;
// fails_when=async recall reuses authority that was valid only before provider work;
// why_new=scope-only tests have no asynchronous provider boundary; seam=none;
// no_claim=real embedding quality (the semantic provider is controlled).
test("workflow authority is rechecked after asynchronous semantic retrieval", async t => {
  const f = await workflowFixture(t);
  let searched = false;
  registerMemorySemanticService(f.store, {
    status: () => ({ status: "ready", optional: true }),
    search: async () => {
      searched = true;
      f.store.updateChannelWorkflow(f.workflow.id, { status: "cancelled" }, new Date().toISOString());
      return [];
    },
    revalidate: () => { assert.fail("cancelled authority cannot revalidate provider hits"); },
  });
  const result = await recallMemory(f.store, f.request, f.host);
  assert.equal(searched, true);
  assert.deepEqual(result.memories, []);
  assert.equal(result.audit.scopeRejected, true);
});

// Value: protects=frozen workflow memory requires the exact durable task start owner and current authority;
// fails_when=nonmember restores lose valid memory or a forged/stale workflow id authorizes it;
// why_new=prepared dispatch tests cover shared memory but no workflow-owned nonmember; seam=none;
// no_claim=SDK execution (this tests the public restore eligibility guard).
test("prepared workflow memory keeps a valid nonmember owner and rejects foreign or revoked lineage", async t => {
  const f = await workflowFixture(t);
  const now = new Date().toISOString();
  const lease = f.store.acquireResourceLease({ workspaceId: "workspace_default", resourceType: "workflow_step", resourceKey: f.step.id,
    ownerType: "workflow_step", ownerId: f.step.id, acquiredAt: now, expiresAt: new Date(Date.now() + 60000).toISOString() });
  const begun = f.store.beginChannelWorkflowStepStart({ workflowStepId: f.step.id, expected: f.step, leaseId: lease.id, now,
    task: { channelId: f.channel.id, assigneeTeammateId: f.teammate.id, title: "Receipt", prompt: "Compare receipts." } });
  assert.equal(begun.status, "begun");
  const request = { cwd: f.cwd, workflowStepId: f.step.id, teammateId: f.teammate.id,
    task: { id: begun.task.id, title: "Receipt", prompt: "Compare receipts.", channelId: f.channel.id } };
  const payload = { usedMemory: { memoryIds: [f.memory.id], recallQuery: "receipt", policyVersion: "fixture" } };
  assert.doesNotThrow(() => assertPreparedRunnerMemoryCurrent(f.store, request, payload));
  for (const taskId of ["not-persisted", f.store.createTask({ channelId: f.channel.id, assigneeTeammateId: f.teammate.id,
    title: "Other task", prompt: "Another receipt." }, now).id]) {
    assert.throws(() => assertPreparedRunnerMemoryCurrent(f.store, { ...request, task: { ...request.task, id: taskId } }, payload),
      error => error.code === "prepared_memory_unavailable");
  }
  f.store.updateChannelWorkflow(f.workflow.id, { status: "cancelled" }, new Date().toISOString());
  assert.throws(() => assertPreparedRunnerMemoryCurrent(f.store, request, payload), error => error.code === "prepared_memory_unavailable");
});

async function workflowFixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-workflow-memory-scope-"));
  const store = createSqliteRunStore(cwd);
  t.after(async () => { store.close(); await rm(cwd, { recursive: true, force: true }); });
  const now = new Date().toISOString();
  const channel = store.createChannel({ name: "Workflow memory", boundPath: cwd, allowedTools: ["read"] }, now);
  const teammate = store.getAiTeammate("teammate_builtin_engineer");
  store.replaceTeammateChannelMemberships(teammate.id, [], now);
  const workflow = store.createChannelWorkflow({ channelId: channel.id, title: "Receipt workflow", objective: "Compare receipts.",
    status: "ready", createdBy: "local-user" }, now);
  const step = store.createChannelWorkflowStep({ workflowId: workflow.id, title: "Receipt step", prompt: "Compare receipts.",
    toParticipantId: teammate.id, toParticipantLabel: teammate.displayName, metadata: { requiredTools: ["read"] },
    participantAuthority: createWorkflowParticipantAuthorityV1({ kind: "workflow_definition", origin: "workflow_graph",
      participantId: teammate.id, sourceId: "receipt-graph" }) }, now);
  const memory = store.createMemoryObject({ scopeType: "teammate", ownerId: teammate.id, title: "Receipt procedure",
    body: "Compare the signed receipt against the account.", sensitivity: "private" }, now);
  const request = { teammateId: teammate.id, channelId: channel.id, intent: "task-run", query: "receipt" };
  return { cwd, store, channel, teammate, workflow, step, memory, request, host: { workflowStepId: step.id } };
}

function overrideStore(store, overrides) {
  return new Proxy(store, { get(target, key) {
    if (Object.hasOwn(overrides, key)) return overrides[key];
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}
