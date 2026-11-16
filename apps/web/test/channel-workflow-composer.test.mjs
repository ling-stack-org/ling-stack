import assert from "node:assert/strict";
import test from "node:test";
import { workflow, steps, evidence, observed, round } from "./support/workflow-isolation-evidence-fixture.mjs";
import { catalogConsumerHarness } from "./support/catalog-consumer-harness.mjs";

const { selectChannelWorkflowComposerControl: select } = await import("../src/features/workspace/useChannelWorkflowComposerController.ts");
const owner = workflow({ status: "ready" });
const tasks = steps(owner, { pinned: false }).map(step => ({ ...step, runId: undefined, status: "queued", metadata: { dependsOnStepIds: [] } }));
const base = { workflows: [owner], steps: tasks, runs: [], workflowIds: new Set([owner.id]), pendingApproval: false, observations: new Map() };

test("the primary action starts or continues the owned workflow and retries its original blocked step", () => {
  assert.equal(select(base).intent, "start");
  assert.equal(select({ ...base, workflows: [{ ...owner, status: "running" }] }).intent, "continue");
  const blocked = { ...tasks[1], status: "blocked" };
  const retry = select({ ...base, workflows: [{ ...owner, status: "blocked" }], steps: [{ ...tasks[0], status: "succeeded" }, blocked] });
  assert.equal(retry.intent, "continue");
  assert.equal(retry.retryStep, blocked);
});

test("session membership and the actual active reply prevent borrowing another workflow", () => {
  assert.equal(select({ ...base, workflowIds: new Set() }), undefined);
  assert.equal(select({ ...base, activeRunId: "unrelated-normal-reply" }), undefined);
  const active = { ...tasks[0], status: "running", runId: "child-run" };
  assert.equal(select({ ...base, workflows: [{ ...owner, status: "running" }], steps: [active], activeRunId: "child-run" }).intent, "stop");
  assert.equal(select({ ...base, workflows: [{ ...owner, status: "running" }],
    steps: [{ ...active, runId: undefined }], runs: [{ id: "child-run", workflowStepId: active.id, status: "running" }], activeRunId: "child-run" }).intent, "stop");
});

test("a newer settled workflow does not resume an older blocked workflow whose timestamp changed", () => {
  const old = { ...owner, status: "blocked", updatedAt: "2099-01-01" };
  const settled = { ...owner, id: "settled", status: "succeeded", createdAt: "2026-11-03T01:00:00.000Z" };
  const state = select({ ...base, workflows: [old, settled], workflowIds: new Set([old.id, settled.id]) });
  assert.equal(state.workflow, settled);
  assert.equal(state.intent, undefined);
});

test("terminal failure, cancellation, input and approval gates never become automatic retries", () => {
  for (const status of ["failed", "cancelled", "succeeded", "draft", "waiting_for_input", "waiting_for_approval"]) {
    assert.equal(select({ ...base, workflows: [{ ...owner, status }], steps: tasks.map(step => ({ ...step, status: "blocked" })) }).intent, undefined);
  }
  assert.equal(select({ ...base, pendingApproval: true }).intent, undefined);
  for (const status of ["waiting_for_input", "waiting_for_approval"]) {
    assert.equal(select({ ...base, steps: [{ ...tasks[0], status }] }).intent, undefined);
  }
});

test("incomplete dependencies and explicit execution loops are not offered as resume", () => {
  for (const metadata of [{ dependsOnStepIds: ["missing"] }, { dependsOnStepIds: [tasks[1].id] },
    { delegatedOutcome: { kind: "blocked", code: "execution_loop_detected" } }]) {
    const control = select({ ...base, workflows: [{ ...owner, status: "blocked" }], steps: [{ ...tasks[0], status: "blocked", metadata }, tasks[1]] });
    assert.equal(control.intent, undefined);
  }
  const blocked = { ...tasks[0], status: "blocked", metadata: { dependsOnStepIds: [tasks[1].id], dependencyMode: "all_terminal" } };
  assert.equal(select({ ...base, steps: [blocked, { ...tasks[1], status: "failed" }] }).retryStep, blocked);
  assert.equal(select({ ...base, steps: [{ ...blocked, metadata: { ...blocked.metadata, dependencyMode: "any_succeeded", fanInPolicy: { requireAllBranchesTerminal: true } } },
    { ...tasks[1], status: "running" }] }).intent, "stop");
});

test("unconfirmed isolated effects never expose a replay command", () => {
  for (const observation of [{ status: "loading", expected: true }, { status: "error", expected: true },
    observed(evidence({ gitEffects: "unknown" })), observed(evidence({ hostOperationPending: true }))]) {
    assert.equal(select({ ...base, observations: new Map([[owner.id, observation]]) }).intent, undefined);
  }
});

test("verified text conflicts retain exact round and revision for the existing recovery dialog", () => {
  const conflict = round({ phase: "conflicted", lastConfirmedPhase: "verifying", mode: "candidate_only",
    candidate: undefined, approval: undefined, reasonCode: "workflow_integration.text_conflict" });
  const control = select({ ...base, workflows: [{ ...owner, status: "blocked" }],
    observations: new Map([[owner.id, observed(evidence({ rounds: [conflict] }))]]) });
  assert.equal(control.intent, "continue");
  assert.equal(control.conflictRound, conflict);
  assert.equal(control.retryStep, undefined);
});

async function controller(t, overrides = {}) {
  const slots = [];
  let cursor = 0;
  const calls = [];
  const hooks = {
    useRef(value) { const i = cursor++; return slots[i] ??= { current: value }; },
    useState(value) { const i = cursor++; if (!(i in slots)) slots[i] = value; return [slots[i], next => { slots[i] = typeof next === "function" ? next(slots[i]) : next; }]; },
  };
  const h = await catalogConsumerHarness(t, {
    exports: { "features/workspace/useChannelWorkflowComposerController.ts": ["useChannelWorkflowComposerController"] },
    ports: { hooks }, transforms: { "features/workspace/useChannelWorkflowComposerController.ts": [{
      anchor: 'import { useRef, useState } from "react";', replace: key => `const { useRef, useState } = globalThis[${JSON.stringify(key)}].ports.hooks;`,
    }] },
  });
  const input = { ...base, ownerKey: "session-A", enabled: true, advanceAllowed: true,
    onOrchestrate: async (...args) => { calls.push(["advance", ...args]); }, onRetry: async (...args) => { calls.push(["retry", ...args]); },
    onCancel: async (...args) => { calls.push(["cancel", ...args]); }, onRecoverConflict: async (...args) => { calls.push(["recover", ...args]); },
    onError: message => calls.push(["error", message]), ...overrides };
  return { calls, render(patch = {}) { cursor = 0; return h.module.useChannelWorkflowComposerController({ ...input, ...patch }); } };
}

test("recovery calls the original endpoint once; repeated clicks cannot create duplicate attempts", async t => {
  let release;
  const requests = [];
  const blocked = { ...tasks[0], status: "blocked" };
  const f = await controller(t, { workflows: [{ ...owner, status: "blocked" }], steps: [blocked],
    onRetry: step => { requests.push(step); return new Promise(resolve => { release = resolve; }); } });
  const c = f.render();
  const pending = c.submit();
  await c.submit();
  assert.deepEqual(requests, [blocked]);
  assert.equal(f.render().busy, true);
  release();
  await pending;
  assert.equal(f.render().busy, false);
  assert.deepEqual(f.calls, [], "workflow recovery never submits another user message");
});

test("the stop action cancels the workflow, including siblings, rather than a single run", async t => {
  const f = await controller(t, { workflows: [{ ...owner, status: "running" }], steps: tasks.map(step => ({ ...step, status: "running" })) });
  await f.render().submit();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][0], "cancel");
  assert.equal(f.calls[0][1].id, owner.id);
});

test("disabled, pending and approval states dispatch no recovery commands", async t => {
  for (const patch of [{ enabled: false }, { advanceAllowed: false }, { pendingWorkflowId: owner.id }, { pendingStepId: tasks[0].id }, { pendingApproval: true }]) {
    const f = await controller(t, patch);
    await f.render().submit();
    assert.deepEqual(f.calls, []);
  }
});

test("plan mode prevents advancement without disabling Stop for a live workflow", async t => {
  const f = await controller(t, { advanceAllowed: false, workflows: [{ ...owner, status: "running" }],
    steps: [{ ...tasks[0], status: "running" }] });
  await f.render().submit();
  assert.deepEqual(f.calls, [["cancel", { ...owner, status: "running" }]]);
});

test("ordinary Start keeps its execution profile; only the explicit menu choice requests isolation", async t => {
  const isolatedTasks = tasks.map(step => ({ ...step, metadata: { ...step.metadata, sideEffectClass: "workspace_write",
    parallelPolicy: { autoParallel: true, maxParallelSiblings: 2 } } }));
  const f = await controller(t, { workflows: [{ ...owner, metadata: { workflowGraphFingerprint: "accepted-graph" } }], steps: isolatedTasks });
  assert.equal(f.render().control.canStartIsolated, true);
  await f.render().submit();
  await f.render().submit(true);
  assert.equal(f.calls[0].length, 2);
  assert.deepEqual(f.calls[1][2], { executionProfile: "pi_host_isolated_files_v1" });
});

test("Continue opens the exact retained conflict recovery instead of replaying execution", async t => {
  const conflict = round({ phase: "conflicted", lastConfirmedPhase: "verifying", mode: "candidate_only",
    candidate: undefined, approval: undefined, reasonCode: "workflow_integration.text_conflict" });
  const f = await controller(t, { workflows: [{ ...owner, status: "blocked" }],
    observations: new Map([[owner.id, observed(evidence({ rounds: [conflict] }))]]) });
  await f.render().submit();
  assert.deepEqual(f.calls, [["recover", owner.id, conflict.roundId, conflict.generation, conflict.revision]]);
});

test("a late failure or stale submit callback cannot affect another session", async t => {
  let reject;
  const f = await controller(t, { onOrchestrate: () => new Promise((_, fail) => { reject = fail; }) });
  const a = f.render();
  const pending = a.submit();
  f.render({ ownerKey: "session-B", workflowIds: new Set() });
  await a.submit();
  reject(new Error("A request failed"));
  await pending;
  assert.deepEqual(f.calls, []);
});

test("a pending request in one session cannot disable another session's send or Stop", async t => {
  let release;
  const f = await controller(t, { onOrchestrate: workflow => {
    f.calls.push(["advance", workflow]);
    return new Promise(resolve => { release = resolve; });
  } });
  const pending = f.render().submit();
  const other = { ...owner, id: "workflow-B", status: "running" };
  const otherStep = { ...tasks[0], id: "step-B", workflowId: other.id, status: "running" };
  const b = f.render({ ownerKey: "session-B", workflows: [other], steps: [otherStep], workflowIds: new Set([other.id]),
    pendingWorkflowId: owner.id, pendingStepId: tasks[0].id });
  assert.equal(b.busy, false, "a foreign workflow request must not disable normal sending");
  assert.equal(b.control.intent, "stop");
  await b.submit();
  assert.deepEqual(f.calls, [["advance", owner], ["cancel", other]]);
  const a = f.render();
  assert.equal(a.busy, true);
  await a.submit();
  assert.equal(f.calls.length, 2, "returning to the first session preserves its duplicate-submit guard");
  release();
  await pending;
  assert.equal(f.render().busy, false);
});

test("returning to the same session does not revive a stale callback or publish its late error", async t => {
  let reject;
  const f = await controller(t, { onOrchestrate: () => new Promise((_, fail) => { reject = fail; }) });
  const a = f.render();
  const pending = a.submit();
  f.render({ ownerKey: "session-B", workflowIds: new Set() });
  f.render();
  reject(new Error("A request failed"));
  await pending;
  await a.submit();
  assert.deepEqual(f.calls, []);
  assert.equal(f.render().busy, false);
});

test("Composer renders send, resume, start and stop through the existing primary icon button", async t => {
  const h = await catalogConsumerHarness(t, { exports: { "features/workspace/ChannelComposer.tsx": ["ChannelComposer"] } });
  const props = { selectedChannelId: "channel-qa", composerDropZoneStyle: {}, mentionPickerOptions: [], slashCommandPickerOptions: [],
    pendingAttachments: [], inputParts: [], channelTeammateIds: new Set(), runGuidanceItems: [], value: "", sendState: "idle", submitDisabled: false,
    authorizationMode: "ask", permissionPreset: "read_only" };
  for (const [submitIntent, icon] of [["send", "send"], ["continue", "play"], ["start", "play"], ["stop", "square"]]) {
    const html = h.render(h.module.ChannelComposer, { ...props, submitIntent, submitLabel: submitIntent, submitTitle: submitIntent });
    const primary = html.slice(html.indexOf('class="primary-button composer-send-button"')).split("</button>")[0];
    assert.match(primary, new RegExp(`lucide-${icon}(?: |")`, "u"));
    assert.match(primary, new RegExp(`aria-label="${submitIntent}"`, "u"));
  }
  const busy = h.render(h.module.ChannelComposer, { ...props, submitIntent: "continue", submitBusy: true, submitDisabled: true, submitLabel: "Continue" });
  const primary = busy.slice(busy.indexOf('class="primary-button composer-send-button"')).split("</button>")[0];
  assert.match(primary, /disabled=""/u);
  assert.match(primary, /lucide-loader/u);
});
