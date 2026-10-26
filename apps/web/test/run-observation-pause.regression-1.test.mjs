import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { LingDaemonTransportError } from "@ling-stack/api-client";
import { catalogConsumerHarness } from "./support/catalog-consumer-harness.mjs";
import { catalogHookPort } from "./support/catalog-hook-port.mjs";

// Actual Run-read/caller code, deterministic hooks/IO only. No real Host,
// database, execution, permission change or canonical Run status is produced.
const sourcePath = "domains/runs/use-runs-domain.ts", cwd = "/isolated/r03-run";
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const isDeferred = error => error.name === "DaemonObservationDeferredError";
const transport = () => new LingDaemonTransportError("fetch", new TypeError("network disconnected"));
const run = (id, workUnitId) => ({ id, cwd, status: "running", ...(workUnitId ? { workUnitId } : {}) });

async function fixture(t) {
  const port = catalogHookPort(), calls = [], details = [];
  let readOverride, runtimeOverride, streamOverride, queue = false, input;
  const queued = [], observation = { paused: false, epoch: 1, workspaceCwd: cwd, baseUrl: "http://127.0.0.1:17928" };
  const hooks = { ...port.hooks, useState(initial) {
    const [value, setValue] = port.hooks.useState(initial);
    return [value, update => { if (queue) queued.push(() => setValue(update)); else setValue(update); }];
  } };
  const source = await readFile(new URL(`../src/${sourcePath}`, import.meta.url), "utf8");
  const start = source.indexOf("import {\n"), end = source.indexOf('} from "../../api.js";', start) + '} from "../../api.js";'.length;
  const apiImport = source.slice(start, end), names = apiImport.slice(apiImport.indexOf("{") + 1, apiImport.indexOf("}")).split(",").map(name => name.trim()).filter(Boolean);
  const api = Object.fromEntries(names.map(name => [name, name === "daemonBaseUrl" ? observation.baseUrl : async (...args) => {
    calls.push({ name, args });
    const result = readOverride?.(name, ...args); if (result !== undefined) return result;
    if (name === "getRun") return run(args[0]);
    if (name === "getRunEvents") return { runId: args[0], events: [{ id: `${args[0]}-event`, runId: args[0], type: "run_started", data: {} }] };
    if (name === "listRunArtifacts") return { artifacts: [{ id: `${args[0]}-artifact` }] };
    if (name === "getWorkUnit") return { cwd: args[0], workUnit: { id: args[1] } };
    if (name === "listRuns") return { runs: [] };
    throw new Error(`unexpected IO ${name}`);
  }]));
  const h = await catalogConsumerHarness(t, { exports: { [sourcePath]: ["useRunsDomain"] }, ports: { hooks, api,
    streamRun: async (...args) => streamOverride?.(...args) }, transforms: {
    [sourcePath]: [
      { anchor: 'import { useMemo, useRef, useState } from "react";', replace: key => `const { useMemo, useRef, useState } = globalThis[${JSON.stringify(key)}].ports.hooks;` },
      { anchor: apiImport, replace: key => `const { ${names.join(", ")} } = globalThis[${JSON.stringify(key)}].ports.api;` },
      { anchor: 'import { useRunControl } from "../../lib/use-run-control.js";', replace: () => 'const useRunControl = () => ({ cancellingRunId: "", cancellingRunIds: [], cancelRunOrWorkUnit: async () => {} });' },
      { anchor: 'import { streamRun, type StreamJsonResponseParser } from "../../sse.js";', replace: key => `const { streamRun } = globalThis[${JSON.stringify(key)}].ports;` },
    ],
    "lib/use-latest-request.ts": [{ anchor: 'import { useRef } from "react";', replace: key => `const { useRef } = globalThis[${JSON.stringify(key)}].ports.hooks;` }],
  } });
  input = { cwd, confirmFullAccessRunIfNeeded: async value => value, setSelectedWorkUnitDetail: detail => details.push(detail),
    refreshRuntimeState: async (...args) => { calls.push({ name: "refreshRuntimeState", args }); await runtimeOverride?.(); },
    refreshApprovals: async () => {}, refreshUsedMemoryAudit: async () => {}, readRunWorkspaceCwd: (_run, fallback) => fallback,
    refreshHealth: async () => { calls.push({ name: "refreshHealth" }); } };
  const render = () => port.render(h.module.useRunsDomain, { ...input, observation: { ...observation } });
  render(); t.after(() => port.unmount());
  return { render, calls, details,
    io(value) { readOverride = value; }, runtime(value) { runtimeOverride = value; }, stream(value) { streamOverride = value; },
    pause(paused = true, workspaceCwd = cwd) { Object.assign(observation, { paused, workspaceCwd, epoch: observation.epoch + 1 }); render(); },
    change(value) { input = { ...input, ...value }; render(); }, queue() { queue = true; },
    applyQueued() { queue = false; for (const publish of queued.splice(0)) publish(); },
  };
}

test("paused loadRun defers before IO and preserves the last Run/events/artifacts", async t => {
  const f = await fixture(t); await f.render().actions.loadRun("old");
  const before = f.render().state, calls = f.calls.length; f.pause();
  await assert.rejects(f.render().actions.loadRun("new"), isDeferred);
  const after = f.render(); assert.equal(f.calls.length, calls); assert.equal(after.error, undefined);
  assert.deepEqual(after.state.selectedRun, before.selectedRun); assert.deepEqual(after.state.events, before.events);
  assert.deepEqual(after.state.artifacts, before.artifacts); assert.equal(after.state.selectedRun.status, "running");
});

test("a pre-pause triple-read snapshot cannot publish into a resumed observation epoch", async t => {
  const f = await fixture(t); await f.render().actions.loadRun("old");
  const pending = deferred(); f.io(name => name === "getRun" ? pending.promise : undefined);
  const read = f.render().actions.loadRun("same"); f.pause(); f.pause(false); pending.resolve(run("same", "unit"));
  await assert.rejects(read, isDeferred); assert.equal(f.render().state.selectedRun.id, "old");
  assert.equal(f.calls.some(call => call.name === "getWorkUnit"), false); assert.equal(f.render().error, undefined);
});

test("paused WorkUnit completion cannot change detail or start runtime observation", async t => {
  const f = await fixture(t); await f.render().actions.loadRun("old");
  const pending = deferred(); f.io(name => name === "getRun" ? run("next", "unit") : name === "getWorkUnit" ? pending.promise : undefined);
  const read = f.render().actions.loadRun("next"); await Promise.resolve(); await Promise.resolve();
  const details = f.details.length, runtimes = f.calls.filter(call => call.name === "refreshRuntimeState").length;
  assert.equal(f.calls.some(call => call.name === "getWorkUnit"), true);
  f.pause(); pending.resolve({ workUnit: { id: "unit" } }); await assert.rejects(read, isDeferred);
  assert.equal(f.details.length, details); assert.equal(f.calls.filter(call => call.name === "refreshRuntimeState").length, runtimes);
});

test("runtime refresh completion is checked and a deferred refresh is not a successful read", async t => {
  const f = await fixture(t), pending = deferred(); f.runtime(() => pending.promise);
  const read = f.render().actions.loadRun("running"); await Promise.resolve(); await Promise.resolve();
  assert.equal(f.calls.some(call => call.name === "refreshRuntimeState"), true);
  f.pause(); pending.resolve(); await assert.rejects(read, isDeferred);
  assert.equal(f.render().error, undefined); assert.equal(f.render().state.selectedRun.status, "running");
});

for (const [label, failure, defer] of [["typed transport", transport(), true], ["HTTP", new Error("HTTP 403 denied"), false],
  ["plain TypeError", new TypeError("Failed to fetch"), false]]) {
  test(`Run read preserves ${label} identity, merging only trusted paused IO`, async t => {
    const f = await fixture(t), pending = deferred(); f.io(name => name === "getRun" ? pending.promise : undefined);
    const read = f.render().actions.loadRun("pending"); f.pause(); pending.reject(failure);
    await assert.rejects(read, error => defer ? isDeferred(error) : error === failure);
    assert.equal(f.render().error?.message, defer ? undefined : failure.message);
  });
}

test("WorkUnit HTTP failures remain visible rather than catch-all clearing detail", async t => {
  const f = await fixture(t), failure = new Error("HTTP 403 WorkUnit denied");
  f.io(name => name === "getRun" ? run("with-unit", "unit") : name === "getWorkUnit" ? Promise.reject(failure) : undefined);
  await assert.rejects(f.render().actions.loadRun("with-unit"), error => error === failure);
  assert.equal(f.render().error?.message, failure.message); assert.deepEqual(f.details, []);
  assert.equal(f.calls.some(call => call.name === "refreshRuntimeState"), false);
});

test("a later selected Run owns publication even when the older ID's keyed request is still current", async t => {
  const f = await fixture(t), pending = deferred(); f.io((name, id) => name === "getRun" && id === "A" ? pending.promise : undefined);
  const oldRead = f.render().actions.loadRun("A"); await f.render().actions.loadRun("B"); pending.resolve(run("A"));
  await assert.rejects(oldRead, isDeferred); assert.equal(f.render().state.selectedRun.id, "B");
});

test("workspace navigation fences an in-flight Run without clearing the previous fact snapshot", async t => {
  const f = await fixture(t); await f.render().actions.loadRun("old");
  const pending = deferred(); f.io(name => name === "getRun" ? pending.promise : undefined);
  const read = f.render().actions.loadRun("late"); f.change({ cwd: "/different-workspace" }); pending.resolve(run("late"));
  await assert.rejects(read, isDeferred); assert.equal(f.render().state.selectedRun.id, "old");
});

test("React state publications queued before a pause recheck their observation on application", async t => {
  const f = await fixture(t); await f.render().actions.loadRun("old");
  const pending = deferred(); f.io(name => name === "getRun" ? pending.promise : undefined);
  const read = f.render().actions.loadRun("new"); f.queue(); pending.resolve(run("new")); await read;
  f.pause(); f.applyQueued(); assert.equal(f.render().state.selectedRun.id, "old");
  assert.equal(f.render().state.events[0].runId, "old"); assert.equal(f.render().state.artifacts[0].id, "old-artifact");
});

test("a foreign workspace pause does not gate this Run or suppress its transport failure", async t => {
  const f = await fixture(t); f.pause(true, "/foreign"); await f.render().actions.loadRun("readable");
  const failure = transport(); f.io(name => name === "getRun" ? Promise.reject(failure) : undefined);
  await assert.rejects(f.render().actions.loadRun("failure"), error => error === failure);
  assert.equal(f.render().error?.message, failure.message);
});

for (const parseJson of [false, true]) {
  test(`a deferred post-stream load is observation-only, not a stream failure (JSON parser=${parseJson})`, async t => {
    const f = await fixture(t);
    f.stream((_url, _request, receive) => { receive({ kind: "ready", runId: "accepted-run" }); f.pause(); });
    await f.render().actions.streamRunRequest("http://fixture/runs", {}, cwd, undefined, parseJson ? () => ({}) : undefined);
    assert.equal(f.render().error, undefined); assert.deepEqual(f.calls, []);
    assert.equal(f.render().state.selectedRunId, "accepted-run");
  });
}

async function runtimeFixture(t) {
  const runtimePath = "domains/runtime/use-runtime-domain.ts", port = catalogHookPort(), calls = [], queued = [];
  let readOverride, label = "old", queue = false, input = { cwd };
  const observation = { paused: false, epoch: 1, workspaceCwd: cwd, baseUrl: "http://127.0.0.1:17928" };
  const hooks = { ...port.hooks, useState(initial) {
    const [value, setValue] = port.hooks.useState(initial);
    return [value, update => { if (queue) queued.push(() => setValue(update)); else setValue(update); }];
  } };
  const snapshot = (value = label) => ({ domains: { work_units: { ok: true, data: {
    active: [{ id: `${value}-snapshot`, kind: "task", status: "running", createdAt: "2026-10-26", updatedAt: "2026-10-26" }],
    queued: [], stale: [],
  } } } });
  const source = await readFile(new URL(`../src/${runtimePath}`, import.meta.url), "utf8");
  const hooksImport = source.slice(0, source.indexOf(";") + 1);
  const hookNames = hooksImport.slice(hooksImport.indexOf("{") + 1, hooksImport.indexOf("}")).trim();
  const start = source.indexOf("import {\n"), end = source.indexOf('} from "../../api.js";', start) + '} from "../../api.js";'.length;
  const apiImport = source.slice(start, end), names = apiImport.slice(apiImport.indexOf("{") + 1, apiImport.indexOf("}")).split(",").map(name => name.trim()).filter(Boolean);
  const api = Object.fromEntries(names.map(name => [name, async (...args) => {
    calls.push({ name, args });
    const result = readOverride?.(name, ...args); if (result !== undefined) return result;
    if (name === "getControlPlaneSnapshot") return snapshot();
    if (name === "listResourceLeases") return { leases: [{ id: `${label}-lease` }] };
    if (name === "listStateTransitions") return { transitions: [{ id: `${label}-${args[1].entityType ?? "all"}`, createdAt: "2026-10-26" }] };
    if (name === "getRuntimeDiagnostics") return { leases: [{ id: `${label}-diagnostic-lease` }], marker: label };
    if (name === "listWorkUnits") return { cwd, workUnits: [{ id: `${label}-unit`, status: "running" }] };
    throw new Error(`unexpected runtime IO ${name}`);
  }]));
  const h = await catalogConsumerHarness(t, { exports: { [runtimePath]: ["useRuntimeDomain"] }, ports: { hooks, api }, transforms: {
    [runtimePath]: [
      { anchor: hooksImport, replace: key => `const { ${hookNames} } = globalThis[${JSON.stringify(key)}].ports.hooks;` },
      { anchor: apiImport, replace: key => `const { ${names.join(", ")} } = globalThis[${JSON.stringify(key)}].ports.api;` },
    ],
    "app/use-focused-domain-error-owner.ts": [{ anchor: 'import { useEffect, useReducer, useRef } from "react";',
      replace: key => `const { useEffect, useReducer, useRef } = globalThis[${JSON.stringify(key)}].ports.hooks;` }],
  } });
  const render = () => port.render(h.module.useRuntimeDomain, { ...input, observation: { ...observation } });
  render(); await port.flush(); t.after(() => port.unmount());
  return { render, calls, snapshot,
    io(value) { readOverride = value; }, label(value) { label = value; },
    pause(paused = true, workspaceCwd = cwd) { Object.assign(observation, { paused, workspaceCwd, epoch: observation.epoch + 1 }); render(); },
    change(value) { input = { ...input, ...value }; render(); }, queue() { queue = true; },
    applyQueued() { queue = false; for (const publish of queued.splice(0)) publish(); },
    async flush() { for (let i = 0; i < 12; i++) await port.flush(); },
  };
}

test("Runtime paused entry preserves its fact snapshot without starting IO", async t => {
  const f = await runtimeFixture(t); await f.render().actions.refreshRuntimeState();
  const before = f.render().state, calls = f.calls.length; f.pause(); f.label("new");
  await f.render().actions.refreshRuntimeState();
  assert.equal(f.calls.length, calls); assert.deepEqual(f.render().state.workUnits, before.workUnits);
  assert.deepEqual(f.render().state.resourceLeases, before.resourceLeases); assert.equal(f.render().error, undefined);
});

test("Runtime snapshot crossing pause/resume cannot publish or start batch reads", async t => {
  const f = await runtimeFixture(t); await f.render().actions.refreshRuntimeState();
  const before = f.render().state, pending = deferred(), calls = f.calls.length;
  f.io(name => name === "getControlPlaneSnapshot" ? pending.promise : undefined);
  const read = f.render().actions.refreshRuntimeState(); f.pause(); f.pause(false); pending.resolve(f.snapshot("late"));
  await read; assert.equal(f.calls.length, calls + 1); assert.deepEqual(f.render().state.workUnits, before.workUnits);
  assert.deepEqual(f.render().state.resourceLeases, before.resourceLeases); assert.equal(f.render().error, undefined);
});

test("Runtime batch results cannot publish after pause/resume", async t => {
  const f = await runtimeFixture(t); await f.render().actions.refreshRuntimeState();
  const pending = deferred(); f.label("new"); f.io(name => name === "listResourceLeases" ? pending.promise : undefined);
  const read = f.render().actions.refreshRuntimeState(); await f.flush();
  const before = f.render().state; assert.equal(before.workUnits[0].id, "new-snapshot");
  f.pause(); f.pause(false); pending.resolve({ leases: [{ id: "late-lease" }] }); await read;
  const after = f.render().state;
  for (const field of ["workUnits", "resourceLeases", "runtimeDiagnostics", "stateTransitions"]) assert.deepEqual(after[field], before[field]);
  assert.equal(f.render().error, undefined); assert.equal(after.runtimeLoading, false);
});

test("Runtime queued React publications recheck their observation before application", async t => {
  const f = await runtimeFixture(t); await f.render().actions.refreshRuntimeState();
  const before = f.render().state; f.queue(); f.label("new"); await f.render().actions.refreshRuntimeState();
  f.pause(); f.applyQueued(); const after = f.render().state;
  for (const field of ["workUnits", "resourceLeases", "runtimeDiagnostics", "stateTransitions"]) assert.deepEqual(after[field], before[field]);
});

test("Runtime typed paused snapshot failure does not use fallback to start more IO", async t => {
  const f = await runtimeFixture(t); await f.render().actions.refreshRuntimeState();
  const before = f.render().state, count = f.calls.length, pending = deferred();
  f.io(name => name === "getControlPlaneSnapshot" ? pending.promise : undefined);
  const read = f.render().actions.refreshRuntimeState(); f.pause(); pending.reject(transport()); await read;
  assert.equal(f.calls.length, count + 1); assert.equal(f.render().error, undefined);
  for (const field of ["workUnits", "resourceLeases", "runtimeDiagnostics", "stateTransitions"]) assert.deepEqual(f.render().state[field], before[field]);
});

for (const endpoint of ["listResourceLeases", "getRuntimeDiagnostics", "listWorkUnits"]) {
  test(`Runtime ${endpoint} paused transport preserves facts without a duplicate error`, async t => {
    const f = await runtimeFixture(t); await f.render().actions.refreshRuntimeState();
    const pending = deferred(); f.io(name => name === endpoint ? pending.promise : undefined);
    const read = f.render().actions.refreshRuntimeState(); await f.flush(); const before = f.render().state;
    f.pause(); pending.reject(transport()); await read;
    for (const field of ["workUnits", "resourceLeases", "runtimeDiagnostics", "stateTransitions"]) assert.deepEqual(f.render().state[field], before[field]);
    assert.equal(f.render().error, undefined);
  });
}

for (const [endpoint, failure] of [["getControlPlaneSnapshot", new Error("HTTP 403 snapshot denied")],
  ["getRuntimeDiagnostics", new Error("HTTP 403 diagnostics denied")], ["listWorkUnits", new TypeError("Failed to fetch")],
  ["listResourceLeases", new Error("HTTP 403 lease denied")]]) {
  test(`Runtime ${endpoint} keeps real errors visible during a pause`, async t => {
    const f = await runtimeFixture(t); await f.render().actions.refreshRuntimeState();
    const pending = deferred(); f.io(name => name === endpoint ? pending.promise : undefined);
    const read = f.render().actions.refreshRuntimeState(); await f.flush(); const before = f.render().state, count = f.calls.length;
    f.pause(); pending.reject(failure); await read;
    assert.equal(f.render().error?.message, failure.message); assert.equal(f.calls.length, count);
    for (const field of ["workUnits", "resourceLeases", "runtimeDiagnostics", "stateTransitions"]) assert.deepEqual(f.render().state[field], before[field]);
  });
}

test("Runtime optional endpoint fallbacks preserve a real error after the remaining reads succeed", async t => {
  const f = await runtimeFixture(t), failure = new Error("HTTP 403 diagnostics denied");
  f.io(name => name === "getRuntimeDiagnostics" ? Promise.reject(failure) : undefined);
  await f.render().actions.refreshRuntimeState();
  assert.equal(f.render().error?.message, failure.message); assert.equal(f.render().state.workUnits[0].id, "old-unit");
  assert.equal(f.render().state.resourceLeases[0].id, "old-lease");
});

test("Runtime foreign-workspace pause neither gates reads nor suppresses a typed transport error", async t => {
  const f = await runtimeFixture(t); f.pause(true, "/foreign"); await f.render().actions.refreshRuntimeState();
  assert.equal(f.render().state.workUnits[0].id, "old-unit");
  const failure = transport(); f.io(name => name === "listResourceLeases" ? Promise.reject(failure) : undefined);
  await f.render().actions.refreshRuntimeState(); assert.equal(f.render().error?.message, failure.message);
});

test("Runtime navigation and a newer read both fence older snapshot requests", async t => {
  const f = await runtimeFixture(t), pending = deferred();
  f.io(name => name === "getControlPlaneSnapshot" ? pending.promise : undefined);
  const read = f.render().actions.refreshRuntimeState(); f.change({ cwd: "/different-workspace" });
  pending.resolve(f.snapshot("late")); await read;
  assert.deepEqual(f.render().state.workUnits, []); assert.equal(f.calls.length, 1);
  f.change({ cwd }); f.io(undefined); await f.render().actions.refreshRuntimeState();
  const older = deferred(); f.io(name => name === "getControlPlaneSnapshot" ? older.promise : undefined);
  const oldRead = f.render().actions.refreshRuntimeState(); f.io(undefined); f.label("newer");
  await f.render().actions.refreshRuntimeState(); older.resolve(f.snapshot("older")); await oldRead;
  assert.equal(f.render().state.workUnits[0].id, "newer-unit");
});

test("Runtime captured callbacks cannot read a previous workspace after navigation", async t => {
  const f = await runtimeFixture(t), oldRefresh = f.render().actions.refreshRuntimeState;
  f.change({ cwd: "/different-workspace" }); await oldRefresh();
  assert.deepEqual(f.calls, []); assert.deepEqual(f.render().state.workUnits, []);
});

test("Runs captured load callbacks cannot publish their previous workspace into the current owner", async t => {
  const f = await fixture(t), loadPrevious = f.render().actions.loadRun;
  f.change({ cwd: "/different-workspace" });
  await assert.rejects(loadPrevious("old-workspace-run"), isDeferred);
  assert.deepEqual(f.calls, []); assert.equal(f.render().state.selectedRun, undefined);
});

test("Runs list paused entry preserves existing rows and makes no new reads", async t => {
  const f = await fixture(t); f.io(name => name === "listRuns" ? { runs: [run("old")] } : undefined);
  await f.render().actions.refreshRunList(); const before = f.render().state.runs, count = f.calls.length;
  f.pause(); await f.render().actions.refreshRunList();
  assert.equal(f.calls.length, count); assert.deepEqual(f.render().state.runs, before);
});

test("Runs list crossing pause/resume cannot publish or begin runtime reads", async t => {
  const f = await fixture(t); f.io(name => name === "listRuns" ? { runs: [run("old")] } : undefined);
  await f.render().actions.refreshRunList(); const pending = deferred(), count = f.calls.length;
  f.io(name => name === "listRuns" ? pending.promise : undefined);
  const read = f.render().actions.refreshRunList(); f.pause(); f.pause(false); pending.resolve({ runs: [run("late")] }); await read;
  assert.deepEqual(f.render().state.runs, [run("old")]); assert.equal(f.calls.length, count + 1);
});

test("Runs list queued publications cannot overwrite rows in a later observation epoch", async t => {
  const f = await fixture(t); f.io(name => name === "listRuns" ? { runs: [run("old")] } : undefined);
  await f.render().actions.refreshRunList(); f.queue();
  f.io(name => name === "listRuns" ? { runs: [run("new")] } : undefined);
  await f.render().actions.refreshRunList(); f.pause(); f.applyQueued();
  assert.deepEqual(f.render().state.runs, [run("old")]);
});

test("Runs list latest request owns publication and follow-up runtime reads", async t => {
  const f = await fixture(t), pending = deferred(); f.io(name => name === "listRuns" ? pending.promise : undefined);
  const older = f.render().actions.refreshRunList();
  f.io(name => name === "listRuns" ? { runs: [run("newer")] } : undefined);
  await f.render().actions.refreshRunList(); pending.resolve({ runs: [run("older")] }); await older;
  assert.deepEqual(f.render().state.runs, [run("newer")]);
  assert.equal(f.calls.filter(call => call.name === "refreshRuntimeState").length, 1);
});

test("Runs captured list callbacks cannot start IO for a previous workspace", async t => {
  const f = await fixture(t), oldList = f.render().actions.refreshRunList;
  f.change({ cwd: "/different-workspace" }); await oldList(); assert.deepEqual(f.calls, []);
});

test("Runs in-flight list navigation does not publish old rows or start runtime IO", async t => {
  const f = await fixture(t), pending = deferred(); f.io(name => name === "listRuns" ? pending.promise : undefined);
  const read = f.render().actions.refreshRunList(); f.change({ cwd: "/different-workspace" });
  pending.resolve({ runs: [run("old-workspace")] }); await read;
  assert.deepEqual(f.render().state.runs, []); assert.equal(f.calls.length, 1);
});

for (const [label, failure, defer] of [["typed transport", transport(), true], ["HTTP", new Error("HTTP 403 list denied"), false],
  ["plain TypeError", new TypeError("Failed to fetch"), false]]) {
  test(`Runs list preserves ${label}, suppressing only trusted paused transport`, async t => {
    const f = await fixture(t), pending = deferred(); f.io(name => name === "listRuns" ? pending.promise : undefined);
    const read = f.render().actions.refreshRunList(); f.pause(); pending.reject(failure); await read;
    assert.equal(f.render().error?.message, defer ? undefined : failure.message);
    assert.equal(f.calls.some(call => call.name === "refreshRuntimeState"), false);
  });
}

test("Runs foreign-workspace pause does not gate the list or suppress its transport error", async t => {
  const f = await fixture(t); f.pause(true, "/foreign");
  f.io(name => name === "listRuns" ? { runs: [run("visible")] } : undefined);
  await f.render().actions.refreshRunList(); assert.equal(f.render().state.runs[0].id, "visible");
  const failure = transport(); f.io(name => name === "listRuns" ? Promise.reject(failure) : undefined);
  await f.render().actions.refreshRunList(); assert.equal(f.render().error?.message, failure.message);
});
