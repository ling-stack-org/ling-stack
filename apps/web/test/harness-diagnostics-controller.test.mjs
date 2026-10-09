import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const controllerUrl = new URL("../src/features/runs/harness-diagnostics-controller.ts", import.meta.url).href;
const hook = registerHooks({ resolve(specifier, context, nextResolve) {
  if (context.parentURL === controllerUrl && specifier === "./harness-diagnostics-response.js") {
    return { url: new URL("../src/features/runs/harness-diagnostics-response.ts", import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
} });
const { createHarnessDiagnosticsController } = await import(controllerUrl);
hook.deregister();

const scope = { cwd: "/repo", runId: "run", workUnitId: "unit", linkedWorkUnitId: "unit", linkedRunId: "run" };
const timestamp = "2026-10-09T00:00:00.000Z";
function observation(id = "c1", overrides = {}) {
  return { record: { id, kind: "continuation", runId: "run", workUnitId: "unit", revision: 1, createdAt: timestamp, updatedAt: timestamp,
    state: "running", sourceAttemptId: "a", origin: "approval_resume", strategy: "native_resume", runnerId: "pi", generation: 1, ...overrides }, leaseStatus: "unclaimed", attempts: [{ id: "a", status: "missing" }] };
}
function page(items = [], overrides = {}) {
  return { schemaVersion: 1, cwd: scope.cwd, runId: scope.runId, workUnitId: scope.workUnitId, status: "available", observedAt: timestamp, items, ...overrides };
}
function cursor(item) {
  const { runId, workUnitId, id, kind, createdAt } = item.record;
  return { runId, workUnitId, id, kind, createdAt };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("collapsed disclosure does not read; activation loads once and suspension invalidates outstanding work", async () => {
  let calls = 0;
  const pending = deferred();
  const controller = createHarnessDiagnosticsController(async () => { calls++; return pending.promise; }, scope);
  assert.equal(controller.getSnapshot().phase, "idle");
  await controller.refresh();
  await controller.loadMore();
  assert.equal(calls, 0);
  const activation = controller.activate();
  assert.equal(controller.getSnapshot().phase, "loading");
  await controller.activate();
  assert.equal(calls, 1);
  controller.suspend();
  pending.resolve(page([observation()]));
  await activation;
  assert.equal(controller.getSnapshot().phase, "idle");
  assert.deepEqual(controller.getSnapshot().items, []);
});

test("real async paging appends unique records, emits loading state, and stops explicitly at the end", async () => {
  const first = observation("c2"), second = observation("c1");
  const calls = [], phases = [];
  const controller = createHarnessDiagnosticsController(async (...args) => {
    calls.push(args);
    return calls.length === 1 ? page([first], { nextCursor: cursor(first) }) : page([second]);
  }, scope);
  const unsubscribe = controller.subscribe(() => phases.push(controller.getSnapshot().phase));
  await controller.activate();
  assert.deepEqual(controller.getSnapshot().items, [first]);
  await controller.loadMore();
  assert.deepEqual(controller.getSnapshot().items, [first, second]);
  assert.equal(controller.getSnapshot().nextCursor, undefined);
  await controller.loadMore();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], ["/repo", "unit", { limit: 100 }]);
  assert.deepEqual(calls[1][2], { limit: 100, cursor: cursor(first) });
  assert.deepEqual(phases, ["loading", "ready", "loading", "ready"]);
  unsubscribe();
});

test("1001 mixed continuation/tool records are loaded without silently cutting off at a page limit", async () => {
  const rows = Array.from({ length: 1001 }, (_, i) => observation(`id-${1001 - i}`, i % 2 ? { kind: "tool_execution", state: "executing", attemptId: "a", toolCallId: `call-${i}`, toolName: "bash", executorKind: "bash", policySnapshotArtifactId: "policy", sandboxProfileId: "sandbox" } : {}));
  const calls = [];
  const controller = createHarnessDiagnosticsController(async (_cwd, _unit, query) => {
    calls.push(query);
    const offset = query.cursor ? rows.findIndex(item => item.record.id === query.cursor.id) + 1 : 0;
    const items = rows.slice(offset, offset + query.limit);
    return page(items, offset + items.length < rows.length ? { nextCursor: cursor(items.at(-1)) } : {});
  }, scope);
  await controller.activate();
  while (controller.getSnapshot().nextCursor) await controller.loadMore();
  assert.equal(calls.length, 11);
  assert.deepEqual(controller.getSnapshot().items.map(item => item.record.id), rows.map(item => item.record.id));
  assert.equal(controller.getSnapshot().phase, "ready");
});

test("refresh clears accumulated content and cursor immediately, superseding a late pagination success", async () => {
  const first = observation("c2"), oldMore = deferred(), refreshed = deferred();
  let calls = 0;
  const controller = createHarnessDiagnosticsController(async () => (++calls === 1 ? page([first], { nextCursor: cursor(first) }) : calls === 2 ? oldMore.promise : refreshed.promise), scope);
  await controller.activate();
  const more = controller.loadMore();
  const refresh = controller.refresh();
  assert.deepEqual(controller.getSnapshot().items, []);
  assert.equal(controller.getSnapshot().nextCursor, undefined);
  refreshed.resolve(page([observation("new")]));
  await refresh;
  oldMore.resolve(page([observation("old")]));
  await more;
  assert.deepEqual(controller.getSnapshot().items.map(item => item.record.id), ["new"]);
});

test("scope changes immediately erase old rows and ignore late successes and failures for cwd/run/unit", async () => {
  for (const changed of [{ cwd: "/another" }, { runId: "another", linkedRunId: "another" }, { workUnitId: "another", linkedWorkUnitId: "another" }]) {
    for (const outcome of ["resolve", "reject"]) {
      const pending = deferred();
      const controller = createHarnessDiagnosticsController(async () => pending.promise, scope);
      const old = controller.activate();
      controller.setScope({ ...scope, ...changed });
      assert.deepEqual(controller.getSnapshot().items, []);
      assert.equal(controller.getSnapshot().phase, "idle");
      pending[outcome](outcome === "resolve" ? page([observation("foreign")]) : new Error("SECRET_SENTINEL"));
      await old;
      assert.equal(controller.getSnapshot().phase, "idle");
      assert.deepEqual(controller.getSnapshot().items, []);
    }
  }
});

test("unloaded, absent and mismatched linkage never issue a speculative diagnostic request", async () => {
  for (const [changed, availability] of [
    [{ workUnitId: "" }, "run_unlinked"], [{ linkedWorkUnitId: undefined }, "linkage_unloaded"],
    [{ linkedWorkUnitId: "foreign" }, "lineage_mismatch"], [{ linkedRunId: "foreign" }, "lineage_mismatch"],
    [{ linkedRunId: undefined }, "run_unlinked"],
  ]) {
    let calls = 0;
    const controller = createHarnessDiagnosticsController(async () => { calls++; return page(); }, { ...scope, ...changed });
    await controller.activate();
    await controller.refresh();
    assert.equal(calls, 0);
    assert.equal(controller.getSnapshot().phase, "unavailable");
    assert.equal(controller.getSnapshot().availability, availability);
  }
});

test("responses must match exact workspace, work unit, run and every record's lineage", async () => {
  for (const response of [
    page([observation()], { cwd: "/foreign" }), page([observation()], { workUnitId: "foreign" }),
    page([observation()], { runId: "foreign" }), page([observation("foreign", { runId: "foreign" })]),
    page([observation("foreign", { workUnitId: "foreign" })]), page([], { schemaVersion: 2 }),
  ]) {
    const controller = createHarnessDiagnosticsController(async () => response, scope);
    await controller.activate();
    assert.equal(controller.getSnapshot().issue, "invalid_response");
    assert.deepEqual(controller.getSnapshot().items, []);
  }
});

test("unlinked/missing/mismatched responses are unavailable rather than an empty success", async () => {
  for (const status of ["run_unlinked", "run_missing", "lineage_mismatch"]) {
    const response = page([], { status, ...(status === "run_unlinked" ? { runId: undefined } : {}) });
    const controller = createHarnessDiagnosticsController(async () => response, scope);
    await controller.activate();
    assert.equal(controller.getSnapshot().phase, "unavailable");
    assert.equal(controller.getSnapshot().availability, status);
    const bad = createHarnessDiagnosticsController(async () => ({ ...response, items: [observation("should-not-leak")] }), scope);
    await bad.activate();
    assert.equal(bad.getSnapshot().issue, "invalid_response");
    assert.deepEqual(bad.getSnapshot().items, []);
  }
});

test("safe error classification never persists error messages, stack traces, unknown codes or secret fields", async () => {
  for (const [code, issue] of [
    ["harness_workspace_uninitialized", "workspace_uninitialized"], ["work_unit_not_found", "not_found"],
    ["harness_diagnostics_invalid_query", "invalid_query"], ["harness_diagnostics_unavailable", "unavailable"],
    ["SECRET_SENTINEL", "unavailable"],
  ]) {
    const controller = createHarnessDiagnosticsController(async () => { throw Object.assign(new Error("SECRET_SENTINEL"), { code, details: "SECRET_SENTINEL" }); }, scope);
    await controller.activate();
    assert.equal(controller.getSnapshot().phase, "error");
    assert.equal(controller.getSnapshot().issue, issue);
    assert.ok(!JSON.stringify(controller.getSnapshot()).includes("SECRET_SENTINEL"));
  }
});

test("failed pagination retains proven prior rows without claiming all pages loaded, then retry refresh starts over", async () => {
  const first = observation("c2");
  const calls = [];
  const controller = createHarnessDiagnosticsController(async (_cwd, _unit, query) => {
    calls.push(query);
    if (calls.length === 2) throw new Error("SECRET_SENTINEL");
    return page([first], calls.length === 1 ? { nextCursor: cursor(first) } : {});
  }, scope);
  await controller.activate();
  await controller.loadMore();
  assert.equal(controller.getSnapshot().phase, "error");
  assert.deepEqual(controller.getSnapshot().items, [first]);
  assert.deepEqual(controller.getSnapshot().nextCursor, cursor(first));
  await controller.refresh();
  assert.equal(controller.getSnapshot().phase, "ready");
  assert.deepEqual(calls[2], { limit: 100 });
  assert.deepEqual(controller.getSnapshot().items, [first]);
});

test("foreign, empty and non-advancing cursors fail closed without creating an infinite load-more loop", async () => {
  const first = observation("c2"), second = observation("c1");
  for (const response of [page([first], { nextCursor: { ...cursor(first), runId: "foreign" } }), page([], { nextCursor: cursor(first) }), page([first], { nextCursor: cursor(second) })]) {
    const controller = createHarnessDiagnosticsController(async () => response, scope);
    await controller.activate();
    assert.equal(controller.getSnapshot().issue, "invalid_response");
  }
  let calls = 0;
  const controller = createHarnessDiagnosticsController(async () => (++calls === 1 ? page([first], { nextCursor: cursor(first) }) : page([first], { nextCursor: cursor(first) })), scope);
  await controller.activate();
  await controller.loadMore();
  assert.equal(controller.getSnapshot().issue, "invalid_response");
  await controller.loadMore();
  assert.equal(calls, 2);
});

test("scope reset and suspension suppress late errors as well as late successes", async () => {
  const pending = deferred();
  const controller = createHarnessDiagnosticsController(async () => pending.promise, scope);
  const activation = controller.activate();
  controller.suspend();
  pending.reject(Object.assign(new Error("SECRET_SENTINEL"), { code: "work_unit_not_found" }));
  await activation;
  assert.equal(controller.getSnapshot().phase, "idle");
  assert.equal(controller.getSnapshot().issue, undefined);
});

test("attempt observation references and ownership must be exact; numeric fences are not opaque fences", async () => {
  for (const attempts of [
    [], [{ id: "foreign", status: "observed", workUnitId: "unit", fencingToken: "fence" }],
    [{ id: "a", status: "observed", workUnitId: "foreign", fencingToken: "fence" }],
    [{ id: "a", status: "observed", workUnitId: "unit", fencingToken: 123 }],
    [{ id: "a", status: "missing", runtimeInstanceId: "PRIVATE_SENTINEL" }],
    [{ id: "a", status: "ownership_mismatch", fencingToken: "PRIVATE_SENTINEL" }],
    [{ id: "a", status: "unknown" }], [{ id: "a", status: "missing" }, { id: "a", status: "missing" }],
  ]) {
    const controller = createHarnessDiagnosticsController(async () => page([{ ...observation(), attempts }]), scope);
    await controller.activate();
    assert.equal(controller.getSnapshot().issue, "invalid_response");
    assert.deepEqual(controller.getSnapshot().items, []);
  }
  const owned = { id: "a", status: "observed", workUnitId: "unit", fencingToken: "opaque:0001", runtimeInstanceId: "owner", attemptStatus: "running" };
  const controller = createHarnessDiagnosticsController(async () => page([{ ...observation(), attempts: [owned] }]), scope);
  await controller.activate();
  assert.equal(controller.getSnapshot().phase, "ready");
  assert.equal(controller.getSnapshot().items[0].attempts[0].fencingToken, "opaque:0001");
});

test("continuation source and target attempts are both observed exactly once, including same-id references", async () => {
  for (const targetAttemptId of ["b", "a"]) {
    const row = observation("c", { targetAttemptId });
    row.attempts = [...new Set(["a", targetAttemptId])].map(id => ({ id, status: "missing" }));
    const controller = createHarnessDiagnosticsController(async () => page([row]), scope);
    await controller.activate();
    assert.equal(controller.getSnapshot().phase, "ready");
    if (targetAttemptId === "b") {
      const missingTarget = createHarnessDiagnosticsController(async () => page([{ ...row, attempts: [{ id: "a", status: "missing" }] }]), scope);
      await missingTarget.activate();
      assert.equal(missingTarget.getSnapshot().issue, "invalid_response");
    }
  }
});

test("oversized pages and unknown lease or persisted states never appear as successful complete diagnostics", async () => {
  for (const response of [
    page(Array.from({ length: 101 }, (_, i) => observation(`c-${i}`))),
    page([{ ...observation(), leaseStatus: "unknown" }]), page([observation("c", { state: "unknown" })]),
    page([observation("c", { revision: -1 })]), page([], { observedAt: "not-a-date" }),
  ]) {
    const controller = createHarnessDiagnosticsController(async () => response, scope);
    await controller.activate();
    assert.equal(controller.getSnapshot().phase, "error");
    assert.equal(controller.getSnapshot().issue, "invalid_response");
    assert.deepEqual(controller.getSnapshot().items, []);
  }
});

test("initial proposed tool revision zero is a valid persisted observation", async () => {
  const initialTool = observation("proposed-tool", { kind: "tool_execution", state: "proposed", revision: 0, attemptId: "a", toolCallId: "call", toolName: "bash", executorKind: "bash", policySnapshotArtifactId: "policy", sandboxProfileId: "sandbox" });
  const controller = createHarnessDiagnosticsController(async () => page([initialTool]), scope);
  await controller.activate();
  assert.equal(controller.getSnapshot().phase, "ready");
  assert.equal(controller.getSnapshot().items[0].record.revision, 0);
});
