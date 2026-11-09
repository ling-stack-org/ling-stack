import assert from "node:assert/strict";
import test from "node:test";
import { LingDaemonError } from "@ling-stack/api-client";
import { catalogConsumerHarness } from "./support/catalog-consumer-harness.mjs";
import { catalogHookPort } from "./support/catalog-hook-port.mjs";
import { evidence, observed, round, steps, workflow } from "./support/workflow-isolation-evidence-fixture.mjs";

const missing = () => new LingDaemonError("No recovery", 404, "Not Found", "workflow_recovery.not_found");
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const source = "features/workspace/useWorkflowConflictRecovery.ts";

async function fixture(t, overrides = {}) {
  const port = catalogHookPort(), calls = [], changed = [];
  const owner = workflow({ status: "blocked" });
  const ports = { hooks: port.hooks, observation: { paused: false, epoch: 0, workspaceCwd: "/qa", baseUrl: "http://127.0.0.1:9999" },
    get: async () => { throw missing(); }, post: async () => response(), start: async () => ({ workflow: successor(), status: "started" }), ...overrides };
  for (const name of ["get", "post", "start"]) {
    const method = ports[name];
    ports[name] = (...args) => { calls.push({ name, args }); return method(...args); };
  }
  const h = await catalogConsumerHarness(t, { ports, transforms: { [source]: [
    { anchor: 'import { useEffect, useMemo, useRef, useState } from "react";',
      replace: key => `const { useEffect, useMemo, useRef, useState } = globalThis[${JSON.stringify(key)}].ports.hooks;` },
    { anchor: 'import { getChannelWorkflowConflictRecovery, orchestrateChannelWorkflow, recoverChannelWorkflowConflict } from "../../api/channels.js";',
      replace: key => `const p = globalThis[${JSON.stringify(key)}].ports;
        const getChannelWorkflowConflictRecovery = (...args) => p.get(...args), recoverChannelWorkflowConflict = (...args) => p.post(...args),
          orchestrateChannelWorkflow = (...args) => p.start(...args);` },
    { anchor: 'import { isDaemonObservationPausedForWorkspace, useDaemonObservation } from "../../shared/conversation/observation/daemon-observation.js";',
      replace: key => `import { isDaemonObservationPausedForWorkspace } from "../../shared/conversation/observation/daemon-observation.js";
        const useDaemonObservation = () => globalThis[${JSON.stringify(key)}].ports.observation;` },
  ] }, exports: { [source]: ["useWorkflowConflictRecovery", "WORKFLOW_RECOVERY_TIMEOUT_MS"] } });
  const r = round({ phase: "conflicted", lastConfirmedPhase: "conflicted", mode: "candidate_only", candidate: undefined,
    approval: undefined, reasonCode: "workflow_integration.text_conflict" });
  const input = { cwd: "/qa", channelId: owner.channelId, threadId: "thread-qa", enabled: true, workflows: [owner],
    observations: new Map([[owner.id, observed(evidence({ rounds: [r] }))]]), onChanged: () => changed.push(input.cwd) };
  const render = () => port.render(h.module.useWorkflowConflictRecovery, input);
  t.after(() => port.unmount());
  return { ...h, input, port, ports, calls, changed, render,
    async open() { await render().open(owner.id, r.roundId, r.generation, r.revision); await port.flush(); return render(); },
    async submit() { render().setInstruction("Preserve both edits."); await render().submit(); return render(); } };
}
function successor(overrides = {}) { return workflow({ id: "repair-workflow", status: "ready", metadata: { sourceTurnId: "repair-turn", sourceMessageId: "repair-source" }, ...overrides }); }
function response({ request, phase = "ready", workflow: owner = successor() } = {}) {
  const r = request ?? { roundId: "round-qa", generation: 1, expectedRevision: 3, idempotencyKey: "retained-request", repairInstruction: "Preserve both edits." };
  return { recovery: { schemaVersion: 1, recoveryId: "recovery-qa", sequence: 1,
    root: { workflowId: "workflow-qa", roundId: r.roundId, generation: r.generation },
    predecessor: { workflowId: "workflow-qa", roundId: r.roundId, generation: r.generation, revision: r.expectedRevision },
    successor: { workflowId: owner.id, roundId: "repair-round", generation: 1 }, idempotencyKey: r.idempotencyKey, repairInstruction: r.repairInstruction },
    workflow: owner, workflowSteps: steps(owner, { pinned: false, narration: false }).map(step => ({ ...step, status: "queued", runId: undefined })),
    phase, mode: "candidate_only", executionProfile: "pi_host_isolated_files_v1", requiresExplicitOrchestration: true };
}

test("opening only observes; a create-only request uses an exact revision and never orchestrates", async t => {
  const f = await fixture(t, { post: async (_cwd, _id, request) => response({ request }) });
  assert.equal((await f.open()).phase, "editing");
  assert.deepEqual(f.calls.map(call => call.name), ["get"]);
  const ready = await f.submit();
  assert.equal(ready.phase, "ready");
  assert.equal(f.changed.length, 1);
  assert.deepEqual(f.calls.map(call => call.name), ["get", "post"]);
  const request = f.calls[1].args[2];
  assert.deepEqual({ ...request, idempotencyKey: "key" }, { roundId: "round-qa", generation: 1, expectedRevision: 3,
    idempotencyKey: "key", repairInstruction: "Preserve both edits." });
  assert.match(request.idempotencyKey, /^[a-z0-9-]+$/u);
  assert.equal(Object.isFrozen(request), true);
  await ready.start();
  assert.deepEqual(f.calls[2], { name: "start", args: ["/qa", "repair-workflow", { executionProfile: "pi_host_isolated_files_v1" }] });
  assert.equal(f.render().phase, "started");
});

test("only the exact not-found response permits a new plan; authorization, conflict, foreign 404 and network failures remain unknown", async t => {
  for (const error of [new LingDaemonError("Denied", 403, "Forbidden"), new LingDaemonError("Conflict", 409, "Conflict"),
    new LingDaemonError("Wrong route", 404, "Not Found", "not_found"), new Error("Disconnected")]) {
    const f = await fixture(t, { get: async () => { throw error; } });
    assert.equal((await f.open()).phase, "unknown");
    await f.submit(); await f.render().retry(); await f.render().start();
    assert.deepEqual(f.calls.map(call => call.name), ["get"]);
  }
});

test("duplicate create and start commands are single-flight before rerender", async t => {
  const post = deferred(), start = deferred();
  const f = await fixture(t, { post: () => post.promise, start: () => start.promise });
  await f.open();
  f.render().setInstruction("Preserve both edits.");
  const controller = f.render(), first = controller.submit(), duplicate = controller.submit();
  assert.equal(f.calls.filter(call => call.name === "post").length, 1);
  post.resolve(response({ request: f.calls[1].args[2] })); await Promise.all([first, duplicate]);
  const ready = f.render(), starting = ready.start(), duplicateStart = ready.start();
  assert.equal(f.calls.filter(call => call.name === "start").length, 1);
  start.resolve({ workflow: successor(), status: "started" }); await Promise.all([starting, duplicateStart]);
});

test("unknown create results require a GET before explicit retry and never change the frozen request", async t => {
  let retained, reads = 0, posts = 0;
  const f = await fixture(t, { get: async () => { if (++reads === 1) throw missing(); return response({ request: retained, phase: "planning" }); },
    post: async (_cwd, _id, request) => { retained = request; if (++posts === 1) throw new Error("Response lost"); return response({ request }); } });
  await f.open(); assert.equal((await f.submit()).phase, "unknown");
  f.render().setInstruction("Must not replace the original intent"); await f.render().retry();
  assert.equal(posts, 1);
  await f.render().check(); assert.equal(f.render().phase, "planning");
  assert.equal(posts, 1, "GET never resumes planning");
  await f.render().retry();
  assert.equal(f.render().phase, "ready");
  assert.deepEqual(f.calls.filter(call => call.name === "post").map(call => call.args[2]), [retained, retained]);
});

test("reopening discovers a retained planning request and retries its original instruction, key and revision", async t => {
  const retained = response({ phase: "planning" });
  const f = await fixture(t, { get: async () => retained, post: async (_cwd, _id, request) => response({ request }) });
  assert.equal((await f.open()).phase, "planning");
  assert.deepEqual(f.calls.map(call => call.name), ["get"]);
  await f.render().retry();
  assert.deepEqual(f.calls[1].args[2], { roundId: "round-qa", generation: 1, expectedRevision: 3,
    idempotencyKey: "retained-request", repairInstruction: "Preserve both edits." });
  assert.equal(f.render().phase, "ready");
});

test("terminal successors retain read-only discovery without retrying their incomplete planning", async t => {
  for (const status of ["cancelled", "failed", "succeeded"]) {
    const retained = response({ phase: "planning", workflow: successor({ status }) });
    const f = await fixture(t, { get: async () => retained });
    assert.equal((await f.open()).phase, "planning");
    await f.render().retry(); await f.render().start();
    assert.deepEqual(f.calls.map(call => call.name), ["get"], status);
    await f.render().check();
    assert.deepEqual(f.calls.map(call => call.name), ["get", "get"], status);
    assert.equal(f.render().session.response.workflow.status, status);
  }
});

for (const change of ["workspace", "channel", "conversation", "away-and-back", "daemon-epoch", "daemon-endpoint", "pause"]) {
  test(`late recovery responses cannot publish or orchestrate after ${change}`, async t => {
    const pending = deferred();
    const f = await fixture(t, { get: () => pending.promise });
    const opening = f.render().open("workflow-qa", "round-qa", 1, 3); await f.port.flush();
    if (change === "workspace") f.input.cwd = "/other";
    else if (change === "conversation") f.input.threadId = "other-thread";
    else if (change === "daemon-epoch") f.ports.observation = { ...f.ports.observation, epoch: 1 };
    else if (change === "daemon-endpoint") f.ports.observation = { ...f.ports.observation, baseUrl: "http://127.0.0.1:8888" };
    else if (change === "pause") f.ports.observation = { ...f.ports.observation, paused: true, epoch: 1 };
    else f.input.channelId = "other-channel";
    f.render();
    if (change === "away-and-back") { f.input.channelId = "channel-qa"; f.render(); }
    pending.resolve(response()); await opening;
    assert.equal(f.changed.length, 0);
    assert.equal(f.render().session?.response, undefined);
    assert.deepEqual(f.calls.map(call => call.name), ["get"]);
  });
}

test("transport changes retain an in-flight create's exact request for read-only discovery after reconnect", async t => {
  const pending = deferred(); let reads = 0, retained;
  const f = await fixture(t, { get: async () => { if (++reads === 1) throw missing(); return response({ request: retained, phase: "planning" }); },
    post: (_cwd, _id, request) => { retained = request; return pending.promise; } });
  await f.open(); f.render().setInstruction("Preserve both edits."); const posting = f.render().submit();
  f.ports.observation = { ...f.ports.observation, paused: true, epoch: 1 }; f.render();
  pending.resolve(response({ request: retained })); await posting;
  assert.equal(f.render().phase, "unknown"); assert.equal(f.changed.length, 0);
  f.ports.observation = { ...f.ports.observation, paused: false, epoch: 2 }; f.render();
  assert.equal(f.render().session.request, retained);
  await f.render().retry(); assert.equal(f.calls.filter(call => call.name === "post").length, 1);
  await f.render().check(); assert.equal(f.render().phase, "planning");
});

test("deadline failures reject late success and permit only explicit observation", async t => {
  const pending = deferred();
  const f = await fixture(t, { get: () => pending.promise });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const opening = f.render().open("workflow-qa", "round-qa", 1, 3); await f.port.flush();
  t.mock.timers.tick(f.module.WORKFLOW_RECOVERY_TIMEOUT_MS); await opening;
  assert.equal(f.render().phase, "unknown");
  pending.resolve(response()); await f.port.flush();
  assert.equal(f.render().phase, "unknown"); assert.equal(f.changed.length, 0);
});

test("foreign or mismatched lineage never enables repair execution", async t => {
  const f = await fixture(t, { get: async () => response({ workflow: successor({ workspaceId: "foreign" }) }) });
  assert.equal((await f.open()).phase, "unknown");
  await f.render().start(); await f.render().retry();
  assert.deepEqual(f.calls.map(call => call.name), ["get"]);
});

test("changed evidence blocks creation and a retired predecessor with no recovery cannot create again", async t => {
  const f = await fixture(t); await f.open();
  f.input.observations = new Map(); f.render();
  await f.submit(); assert.equal(f.render().phase, "unavailable");
  assert.deepEqual(f.calls.map(call => call.name), ["get"]);
  const retired = await fixture(t); retired.input.workflows[0].status = "failed";
  assert.equal((await retired.open()).phase, "unavailable");
  await retired.submit(); assert.deepEqual(retired.calls.map(call => call.name), ["get"]);
});
