import assert from "node:assert/strict";
import test from "node:test";
import { catalogConsumerHarness } from "./support/catalog-consumer-harness.mjs";
import { catalogHookPort } from "./support/catalog-hook-port.mjs";
import { evidence, hookTransforms, round, steps, workflow } from "./support/workflow-isolation-evidence-fixture.mjs";

function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function fixture(t, request) {
  const port = catalogHookPort(), calls = [];
  const ports = { hooks: port.hooks, observation: { paused: false, epoch: 0, workspaceCwd: "/qa", baseUrl: "http://127.0.0.1:9999" },
    request: (...args) => { calls.push(args); return request(...args); } };
  const h = await catalogConsumerHarness(t, { ports, transforms: hookTransforms, exports: {
    "features/workspace/useWorkflowIsolationEvidence.ts": ["useWorkflowIsolationEvidence", "WORKFLOW_ISOLATION_POLL_LIMIT", "WORKFLOW_ISOLATION_POLL_MS", "WORKFLOW_ISOLATION_READ_TIMEOUT_MS"],
  } });
  const owner = workflow();
  const input = { cwd: "/qa", channelId: owner.channelId, enabled: true, workflows: [owner], steps: steps(), retainedIsolationWorkflowIds: [], refreshSignature: "initial", refreshToken: 0 };
  t.after(() => port.unmount());
  return { ...h, port, ports, input, calls, render: () => port.render(h.module.useWorkflowIsolationEvidence, input) };
}

for (const change of ["workspace", "channel", "away-and-back"]) {
  test(`actual evidence hook fences late responses after ${change}, including before effect cleanup`, async t => {
    const pending = deferred();
    const f = await fixture(t, () => pending.promise);
    f.render(); await f.port.flush();
    if (change === "workspace") f.input.cwd = "/other";
    else f.input.channelId = "other-channel";
    assert.equal(f.render().size, 0, "the new scope never renders old evidence");
    if (change === "away-and-back") { f.input.channelId = "channel-qa"; f.render(); }
    pending.resolve({ workflow: workflow(), isolation: evidence() });
    await Promise.resolve(); await Promise.resolve();
    assert.equal(f.render().size, 0, "even a return to the same string scope has a new owner");
    assert.equal(f.calls.length, 1);
  });
}

test("actual hook skips ordinary workflows without an isolation plan and never polls them", async t => {
  const f = await fixture(t, async (_cwd, id) => { if (id === "error-qa") throw new Error("Synthetic failure"); return { workflow: workflow({ id }) }; });
  f.input.workflows = [workflow(), workflow({ id: "error-qa" })]; f.input.steps = [];
  t.mock.timers.enable({ apis: ["setTimeout"] });
  f.render(); await f.port.flush();
  assert.equal(f.calls.length, 0);
  t.mock.timers.tick(200_000); await f.port.flush();
  assert.equal(f.calls.length, 0);
  assert.equal(f.render().get("workflow-qa").status, "loading");
  assert.equal(f.render().get("workflow-qa").expected, false);
  assert.equal(f.render().get("error-qa").status, "loading");
  assert.equal(f.render().get("error-qa").expected, false);
});

test("isolated in-flight/unknown reads have a finite follow-up budget; SSE token and signature can refresh it", async t => {
  const f = await fixture(t, async () => ({ workflow: workflow({ status: "running" }), isolation: evidence({ rounds: [round({ phase: "collecting" })] }) }));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  f.render(); await f.port.flush();
  for (let i = 0; i < f.module.WORKFLOW_ISOLATION_POLL_LIMIT + 2; i++) {
    t.mock.timers.tick(f.module.WORKFLOW_ISOLATION_POLL_MS); await f.port.flush();
  }
  assert.equal(f.calls.length, 1 + f.module.WORKFLOW_ISOLATION_POLL_LIMIT);
  assert.equal(f.render().get("workflow-qa").isolation.rounds[0].phase, "collecting");
  f.input.refreshToken++; f.render(); await f.port.flush();
  assert.equal(f.calls.length, 2 + f.module.WORKFLOW_ISOLATION_POLL_LIMIT);
  f.input.refreshSignature = "approval-resolved"; f.render(); await f.port.flush();
  assert.equal(f.calls.length, 3 + f.module.WORKFLOW_ISOLATION_POLL_LIMIT);
});

test("ready apply evidence stops follow-ups using the returned lifecycle, not a stale running prop", async t => {
  let count = 0;
  const f = await fixture(t, async () => ({ workflow: workflow({ status: count++ === 0 ? "running" : "succeeded" }),
    isolation: count === 1 ? evidence({ rounds: [round({ phase: "applying", application: { status: "pending" } })] })
      : evidence({ completion: "ready", rounds: [round({ phase: "applied", application: { status: "applied" } })] }) }));
  f.input.workflows = [workflow({ status: "running" })];
  t.mock.timers.enable({ apis: ["setTimeout"] });
  f.render(); await f.port.flush();
  t.mock.timers.tick(f.module.WORKFLOW_ISOLATION_POLL_MS); await f.port.flush();
  t.mock.timers.tick(200_000); await f.port.flush();
  assert.equal(f.calls.length, 2);
  assert.equal(f.render().get("workflow-qa").isolation.rounds[0].phase, "applied");
});

test("cancelled blocked completion stops follow-ups once journals are confirmed and Host is no longer draining", async t => {
  let count = 0;
  const f = await fixture(t, async () => ({ workflow: workflow({ status: "cancelled" }), isolation: evidence({
    hostOperationPending: ++count === 1, completion: "blocked", completionBlockerCode: "workflow_integration.round_not_complete",
    rounds: [round({ phase: "blocked", approval: undefined, application: { status: "not_applied" } })],
  }) }));
  f.input.workflows = [workflow({ status: "cancelled" })];
  t.mock.timers.enable({ apis: ["setTimeout"] });
  f.render(); await f.port.flush();
  t.mock.timers.tick(f.module.WORKFLOW_ISOLATION_POLL_MS); await f.port.flush();
  t.mock.timers.tick(200_000); await f.port.flush();
  assert.equal(f.calls.length, 2);
  assert.equal(f.render().get("workflow-qa").isolation.completion, "blocked");
  assert.equal(f.render().get("workflow-qa").isolation.hostOperationPending, false);
});

test("refresh invalidation rejects an older request before passive cleanup can run", async t => {
  const old = deferred(), fresh = deferred(); let count = 0;
  const f = await fixture(t, () => count++ ? fresh.promise : old.promise);
  f.render(); await f.port.flush();
  f.input.refreshToken++; f.render();
  old.resolve({ workflow: workflow(), isolation: evidence({ completion: "ready", rounds: [round({ phase: "applied", application: { status: "applied" } })] }) });
  await f.port.flush();
  assert.equal(f.render().get("workflow-qa").status, "loading");
  fresh.resolve({ workflow: workflow(), isolation: evidence() }); await f.port.flush();
  assert.equal(f.render().get("workflow-qa").isolation.rounds[0].phase, "awaiting_approval");
});

test("pause/resume fences old reads and follow-up timers; paused Host never starts new reads", async t => {
  const pending = deferred(); let count = 0;
  const f = await fixture(t, async () => ++count === 1 ? pending.promise : { workflow: workflow(), isolation: evidence() });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  f.render(); await f.port.flush();
  f.ports.observation = { ...f.ports.observation, paused: true, epoch: 1 }; f.render();
  pending.resolve({ workflow: workflow(), isolation: evidence({ completion: "ready" }) }); await f.port.flush();
  t.mock.timers.tick(200_000); await f.port.flush();
  assert.equal(f.calls.length, 1);
  f.ports.observation = { ...f.ports.observation, paused: false, epoch: 2 }; f.render(); await f.port.flush();
  assert.equal(f.calls.length, 2);
  f.ports.observation = { ...f.ports.observation, paused: true, epoch: 3 }; f.render();
  t.mock.timers.tick(f.module.WORKFLOW_ISOLATION_POLL_MS); await f.port.flush();
  assert.equal(f.calls.length, 2, "even a timer firing before cleanup consults the current episode");
});

test("timeout remains unknown, rejects a late success and only retries known isolation", async t => {
  const late = deferred();
  const f = await fixture(t, () => late.promise);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  f.render(); await f.port.flush();
  t.mock.timers.tick(f.module.WORKFLOW_ISOLATION_READ_TIMEOUT_MS); await f.port.flush();
  assert.equal(f.render().get("workflow-qa").status, "error");
  late.resolve({ workflow: workflow(), isolation: evidence({ completion: "ready" }) }); await f.port.flush();
  assert.equal(f.render().get("workflow-qa").status, "error");
  assert.equal(f.render().get("workflow-qa").isolation, undefined);
});

test("foreign workflow ownership and disappearance of retained isolation fail closed", async t => {
  let count = 0;
  const f = await fixture(t, async () => ({ workflow: workflow(count++ === 0 ? { channelId: "foreign" } : {}), ...(count === 2 ? { isolation: evidence() } : {}) }));
  f.render(); await f.port.flush();
  assert.equal(f.render().get("workflow-qa").status, "error");
  f.input.refreshToken++; f.render(); await f.port.flush();
  assert.equal(f.render().get("workflow-qa").isolation.status, "available");
  f.input.refreshToken++; f.render(); await f.port.flush();
  assert.equal(f.render().get("workflow-qa").status, "error");
  assert.equal(f.render().get("workflow-qa").expected, true);
});
