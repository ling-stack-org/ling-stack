import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createCompositeSecretResolver,
  createSqliteRunStore,
  ExecutionEngineProfileStore,
  resolveUserConfigPaths,
} from "@ling-stack/core";
import { parseRunRequest } from "../dist/features/runs/schemas.js";
import { createDetachedRunExecutionSink, executeRunRequest } from "../dist/features/runs/orchestrator.js";
import { createNativeRunDispatcher } from "../dist/features/runs/native-run-dispatcher.js";
import { createExecutionEngineRunTargetDispatcher } from "../dist/features/execution-engines/run-target-dispatcher.js";
import { createMemorySourceRevisions } from "../dist/features/memory/prompt.js";
import { acpConfigurationFingerprint } from "../dist/runtime/acp/journaled-lifecycle.js";
import { maybeStartNextRunInterventionContinuation } from "../dist/features/runs/interventions.js";
import { fixtureNativeAcceptance, fixtureNativePolicy } from "./support/fixture-native-acceptance.mjs";
import { loadWorkspaceRuntimeSettings, patchWorkspaceRuntimeSettings } from "../dist/runtime/runner-settings.js";
import { resolveConfig } from "../dist/config.js";
import {
  ActiveRunRegistry,
  createDaemonServer,
  createRunnerRegistry,
  RunStoreRegistry,
  RuntimeSupervisor,
} from "../dist/index.js";

const base = { cwd: "/workspace", task: { id: "task_fixture", title: "Fixture", prompt: "Do not execute" } };
const native = { kind: "native_profile", engineId: "codex-app-server", profileId: "profile_fixture", profileRevision: 1, nativeModelId: "native-model" };

test("typed Pi run selection can reparse its canonical persisted representation", () => {
  const request = parseRunRequest({ ...base, executionBinding: { kind: "pi_provider", providerPresetId: "pi-preset" } });
  assert.deepEqual(parseRunRequest(request), request);
  assert.throws(() => parseRunRequest({ ...request, providerPresetId: "different" }), { code: "execution_binding_conflict" });
});

function createRecordingSink() {
  const state = { ready: [], events: [], errors: [], ended: 0 };
  return {
    state,
    sink: {
      kind: "detached",
      onClose() {},
      isClosed() { return false; },
      writeReady(value) { state.ready.push(value); },
      writeEvent(event, data) { state.events.push({ event, data }); },
      writeError(statusCode, body) { state.errors.push({ statusCode, body }); },
      end() { state.ended += 1; },
    },
  };
}

function createNativeWorkflowFixture(t, target, timeoutPolicy) {
  const cwd = mkdtempSync(join(tmpdir(), "ling-native-workflow-"));
  const adapter = { async runTask() { throw new Error("Pi adapter must not receive a native run"); } };
  const runnerRegistry = createRunnerRegistry([
    { id: "pi", displayName: "Ling", status: "enabled", adapter },
    { id: "openclaw-acp", displayName: "OpenClaw", status: "enabled", adapter },
    { id: "codex-app-server", displayName: "Codex", status: "enabled", adapter },
  ]);
  const storeRegistry = new RunStoreRegistry((root) => {
    const store = createSqliteRunStore(root);
    if (timeoutPolicy) {
      const create = store.createWorkUnit.bind(store);
      store.createWorkUnit = input => create({ ...input, timeoutPolicy });
    }
    return store;
  }, { trustedWorkspaceRoots: [cwd] });
  const store = storeRegistry.getStore(cwd);
  patchWorkspaceRuntimeSettings(store, runnerRegistry, {
    schemaVersion: 2, confirmNativeMigration: true, expectedUpdatedAt: loadWorkspaceRuntimeSettings(store, runnerRegistry).updatedAt,
    defaultRunnerId: "pi",
    allowedRunnerIds: ["pi", "openclaw-acp", "codex-app-server"],
  });
  const activeRuns = new ActiveRunRegistry();
  const runtimeSupervisor = new RuntimeSupervisor(resolveConfig({
    host: "127.0.0.1",
    port: 0,
    defaultWorkspaceCwd: cwd,
  }));
  const dispatcher = createNativeRunDispatcher({
    runnerRegistry,
    storeRegistry,
    activeRuns,
    runtimeSupervisor,
    secretResolver: createCompositeSecretResolver({ env: {} }),
    target,
  });
  t.after(async () => {
    target.release?.();
    await activeRuns.waitForIdle();
    runtimeSupervisor.releaseAll();
    storeRegistry.closeAll();
    rmSync(cwd, { recursive: true, force: true });
  });
  return { cwd, store, dispatcher, runnerRegistry, storeRegistry, activeRuns, runtimeSupervisor,
    secretResolver: createCompositeSecretResolver({ env: {} }) };
}

function nativeWorkflowRequest(cwd, task, patch = {}) {
  const request = parseRunRequest({
    cwd,
    workspaceCwd: cwd,
    task,
    executionBinding: {
      kind: "native_profile",
      engineId: "openclaw-acp",
      profileId: "profile_fixture",
      profileRevision: 1,
    },
    ...patch,
  });
  // Internal workflow authority comes from Core, never from an HTTP payload parser.
  return { ...request, ...(patch.workflowStartOwner ? { workflowStartOwner: patch.workflowStartOwner } : {}) };
}

function nativeMemoryRequest(fixture, memory, patch = {}) {
  const request = nativeWorkflowRequest(fixture.cwd, {
    id: "task_native_memory", title: "Scoped Memory", prompt: "Follow the scoped Memory preference.",
  }, { executionBinding: native, teammateId: memory.ownerId, skipMemoryRecall: true, idempotencyKey: "native-memory-once", ...patch });
  return { ...request, preselectedMemoryUse: { memoryIds: [memory.id], recallQuery: "Scoped Memory",
    policyVersion: "fixture-memory-policy", renderedPrompt: `Used memory:\n${memory.body}`,
    sourceRevisions: createMemorySourceRevisions([memory]) } };
}

function acceptNativeMemoryInput(input, outcome = "completed") {
  const now = new Date().toISOString();
  const selection = { engineId: input.runRequest.executionBinding.engineId,
    profileId: input.runRequest.executionBinding.profileId, profileRevision: input.runRequest.executionBinding.profileRevision,
    profileFingerprint: "a".repeat(64), modelId: input.runRequest.executionBinding.nativeModelId,
    configurationFingerprint: "b".repeat(64) };
  const fence = { workUnitId: input.attempt.workUnitId, attemptId: input.attempt.id,
    runtimeInstanceId: input.attempt.runtimeInstanceId, fencingToken: input.attempt.fencingToken };
  const entry = input.store.reserveNativeExecution({ runId: input.run.id, generation: 1, fence, selection }, now);
  const key = { submissionId: entry.submission.id, fence };
  input.store.bindNativeExecutionSession({ ...key, nativeSessionId: "fixture-thread" }, now);
  input.store.beginNativeSubmission(key, now);
  input.store.acceptNativeSubmission({ ...key, nativeTurnId: "fixture-turn" }, now);
  input.store.finishNativeSubmission({ ...key, outcome }, now);
}

test("native Memory hydrates private system input once without changing canonical task or turn", async t => {
  const calls = [];
  const fixture = createNativeWorkflowFixture(t, {
    async assertAvailable(input) { calls.push(input.runRequest); },
    async dispatch(input) { calls.push(input.runRequest); acceptNativeMemoryInput(input); return { status: "completed", events: [] }; },
  });
  const memory = fixture.store.createMemoryObject({ scopeType: "teammate", ownerId: "teammate_builtin_engineer",
    title: "Scoped Memory", body: "NATIVE_PRIVATE_MEMORY_CANARY", sensitivity: "private", reviewState: "active" }, new Date().toISOString());
  const request = nativeMemoryRequest(fixture, memory);
  const recording = createRecordingSink();
  const runId = await fixture.dispatcher.dispatch({ runRequest: request, sink: recording.sink, executionOptions: {} });
  assert.ok(runId, JSON.stringify(recording.state.errors));
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.appendSystemPrompt.filter(text => text.includes(memory.body)).length, 1);
    assert.doesNotMatch(call.task.prompt, /NATIVE_PRIVATE_MEMORY_CANARY/);
    assert.equal(call.preselectedMemoryUse, undefined);
  }
  const run = fixture.store.getRun(runId);
  assert.equal(run.status, "succeeded");
  assert.doesNotMatch(JSON.stringify(run.taskSnapshot), /NATIVE_PRIVATE_MEMORY_CANARY/);
  assert.doesNotMatch(JSON.stringify(fixture.store.listLingTurns({ threadId: run.threadId, limit: 100 })), /NATIVE_PRIVATE_MEMORY_CANARY/);
  assert.match(JSON.stringify(run.requestSnapshot.appendSystemPrompt), /NATIVE_PRIVATE_MEMORY_CANARY/);
  assert.equal(run.requestSnapshot.preselectedMemoryUse, undefined);
  const [used] = fixture.store.listUsedMemoryEvents({ runId });
  assert.deepEqual(used.memoryIds, [memory.id]);
  assert.equal(used.policyVersion, "fixture-memory-policy");
  assert.doesNotMatch(JSON.stringify(used), /NATIVE_PRIVATE_MEMORY_CANARY|renderedPrompt|sourceRevisions|semanticHash/);
  assert.equal(fixture.store.getMemoryObject(memory.id).updatedAt, memory.updatedAt);
  const replay = await fixture.dispatcher.dispatch({ runRequest: request, sink: createRecordingSink().sink, executionOptions: {} });
  assert.equal(replay, runId);
  assert.equal(calls.length, 2);
  assert.equal(fixture.store.listUsedMemoryEvents({ runId }).length, 1);
});

for (const change of ["revoke", "body"]) test(`native Memory ${change} during availability prevents execution`, async t => {
  let memory, dispatched = 0;
  const fixture = createNativeWorkflowFixture(t, {
    async assertAvailable() {
      await Promise.resolve();
      fixture.store.updateMemoryObject(memory.id, change === "revoke" ? { enabled: false } : { body: "changed-after-selection" }, new Date().toISOString());
    },
    async dispatch() { dispatched++; return { status: "completed", events: [] }; },
  });
  memory = fixture.store.createMemoryObject({ scopeType: "teammate", ownerId: "teammate_builtin_engineer",
    title: "Scoped Memory", body: "NATIVE_PRIVATE_MEMORY_CANARY", sensitivity: "private", reviewState: "active" }, new Date().toISOString());
  const recording = createRecordingSink();
  const id = await fixture.dispatcher.dispatch({ runRequest: nativeMemoryRequest(fixture, memory), sink: recording.sink, executionOptions: {} });
  assert.equal(id, undefined);
  assert.equal(dispatched, 0);
  assert.equal(recording.state.errors[0].body.error, "prepared_memory_unavailable");
  assert.equal(fixture.store.listUsedMemoryEvents().length, 0);
});

test("native Memory is rechecked at later Host authority boundaries and never counted before acceptance", async t => {
  let memory;
  const fixture = createNativeWorkflowFixture(t, { async dispatch(input) {
    fixture.store.updateMemoryObject(memory.id, { enabled: false }, new Date().toISOString());
    input.assertCurrentAuthority();
    throw new Error("must not submit revoked memory");
  } });
  memory = fixture.store.createMemoryObject({ scopeType: "teammate", ownerId: "teammate_builtin_engineer",
    title: "Scoped Memory", body: "NATIVE_PRIVATE_MEMORY_CANARY", sensitivity: "private", reviewState: "active" }, new Date().toISOString());
  const id = await fixture.dispatcher.dispatch({ runRequest: nativeMemoryRequest(fixture, memory), sink: createRecordingSink().sink, executionOptions: {} });
  assert.equal(fixture.store.getRun(id).status, "failed");
  assert.equal(fixture.store.getRun(id).errorMessage, "A prepared Memory source is no longer eligible.");
  assert.equal(fixture.store.listUsedMemoryEvents().length, 0);
});

test("native Memory automatic recall also remains role-private and counts an accepted failed turn", async t => {
  const calls = [];
  const fixture = createNativeWorkflowFixture(t, { async dispatch(input) {
    calls.push(input.runRequest);
    acceptNativeMemoryInput(input, "failed");
    throw new Error("fixture native turn failed after acceptance");
  } });
  const memory = fixture.store.createMemoryObject({ scopeType: "teammate", ownerId: "teammate_builtin_engineer",
    title: "Scoped Memory", body: "NATIVE_PRIVATE_MEMORY_CANARY", sensitivity: "private", reviewState: "active" }, new Date().toISOString());
  const request = { ...nativeMemoryRequest(fixture, memory), preselectedMemoryUse: undefined, skipMemoryRecall: false };
  const runId = await fixture.dispatcher.dispatch({ runRequest: request, sink: createRecordingSink().sink, executionOptions: {} });
  assert.equal(calls.length, 1);
  assert.match(calls[0].appendSystemPrompt.join("\n"), /NATIVE_PRIVATE_MEMORY_CANARY/);
  assert.doesNotMatch(calls[0].task.prompt, /NATIVE_PRIVATE_MEMORY_CANARY/);
  assert.equal(fixture.store.getRun(runId).status, "failed");
  const [used] = fixture.store.listUsedMemoryEvents({ runId });
  assert.deepEqual(used.memoryIds, [memory.id]);
  assert.equal(used.policyVersion, "ling-memory-v1-lexical-v2");
});

test("native Memory usage by another consumer does not invalidate frozen semantic input", async t => {
  let memory;
  const fixture = createNativeWorkflowFixture(t, {
    async assertAvailable() {
      fixture.store.recordUsedMemoryEvent({ memoryIds: [memory.id], intent: "task-run", recallQuery: "other consumer",
        teammateId: memory.ownerId, policyVersion: "fixture" }, new Date().toISOString());
    },
    async dispatch(input) { input.assertCurrentAuthority(); acceptNativeMemoryInput(input); return { status: "completed", events: [] }; },
  });
  memory = fixture.store.createMemoryObject({ scopeType: "teammate", ownerId: "teammate_builtin_engineer",
    title: "Scoped Memory", body: "NATIVE_PRIVATE_MEMORY_CANARY", sensitivity: "private", reviewState: "active" }, new Date().toISOString());
  const request = nativeMemoryRequest(fixture, memory);
  fixture.store.recordUsedMemoryEvent({ memoryIds: [memory.id], intent: "task-run", recallQuery: "before dispatcher",
    teammateId: memory.ownerId, policyVersion: "fixture" }, new Date().toISOString());
  const runId = await fixture.dispatcher.dispatch({ runRequest: request, sink: createRecordingSink().sink, executionOptions: {} });
  assert.ok(runId);
  assert.equal(fixture.store.getRun(runId).status, "succeeded");
  assert.equal(fixture.store.listUsedMemoryEvents({ runId }).length, 1);
});

test("native Memory body changed after selection but before dispatcher entry is rejected", async t => {
  let preparations = 0;
  const fixture = createNativeWorkflowFixture(t, {
    async assertAvailable() { preparations++; }, async dispatch() { return { status: "completed", events: [] }; },
  });
  const memory = fixture.store.createMemoryObject({ scopeType: "teammate", ownerId: "teammate_builtin_engineer",
    title: "Scoped Memory", body: "NATIVE_PRIVATE_MEMORY_CANARY", sensitivity: "private", reviewState: "active" }, new Date().toISOString());
  const request = nativeMemoryRequest(fixture, memory);
  fixture.store.updateMemoryObject(memory.id, { body: "new-current-body" }, new Date().toISOString());
  const recording = createRecordingSink();
  const id = await fixture.dispatcher.dispatch({ runRequest: request, sink: recording.sink, executionOptions: {} });
  assert.equal(id, undefined);
  assert.equal(preparations, 0);
  assert.equal(recording.state.errors[0].body.error, "prepared_memory_unavailable");
  assert.equal(fixture.store.listUsedMemoryEvents().length, 0);
});

test("native Memory rendered selection without exact source revisions is rejected", async t => {
  let preparations = 0;
  const fixture = createNativeWorkflowFixture(t, {
    async assertAvailable() { preparations++; }, async dispatch() { return { status: "completed", events: [] }; },
  });
  const memory = fixture.store.createMemoryObject({ scopeType: "teammate", ownerId: "teammate_builtin_engineer",
    title: "Scoped Memory", body: "NATIVE_PRIVATE_MEMORY_CANARY", sensitivity: "private", reviewState: "active" }, new Date().toISOString());
  const request = nativeMemoryRequest(fixture, memory);
  request.preselectedMemoryUse = { ...request.preselectedMemoryUse, sourceRevisions: undefined };
  const recording = createRecordingSink();
  const id = await fixture.dispatcher.dispatch({ runRequest: request, sink: recording.sink, executionOptions: {} });
  assert.equal(id, undefined);
  assert.equal(preparations, 0);
  assert.equal(recording.state.errors[0].body.error, "prepared_memory_unavailable");
});

for (const invalid of ["no-prompt", "no-source"]) test(`native Memory ${invalid} is rejected before native preparation`, async t => {
  let preparations = 0;
  const fixture = createNativeWorkflowFixture(t, {
    async assertAvailable() { preparations++; }, async dispatch() { throw new Error("invalid memory must not execute"); },
  });
  const memory = fixture.store.createMemoryObject({ scopeType: "teammate", ownerId: "teammate_builtin_engineer",
    title: "Scoped Memory", body: "NATIVE_PRIVATE_MEMORY_CANARY", sensitivity: "private", reviewState: "active" }, new Date().toISOString());
  const request = nativeMemoryRequest(fixture, memory);
  request.preselectedMemoryUse = { ...request.preselectedMemoryUse,
    ...(invalid === "no-prompt" ? { renderedPrompt: undefined } : { memoryIds: [] }) };
  const recording = createRecordingSink();
  const runId = await fixture.dispatcher.dispatch({ runRequest: request, sink: recording.sink, executionOptions: {} });
  assert.equal(runId, undefined);
  assert.equal(preparations, 0);
  assert.equal(recording.state.errors[0].body.error, "native_memory_input_invalid");
  assert.equal(fixture.store.listUsedMemoryEvents().length, 0);
});

test("run parsing preserves native engine/model ownership without requiring a Pi preset", () => {
  const parsed = parseRunRequest({ ...base, executionBinding: native });
  assert.deepEqual(parsed.executionBinding, native);
  assert.equal(parsed.runnerId, native.engineId);
  assert.equal(parsed.providerPresetId, undefined);
  assert.equal(parsed.provider, undefined);
});

test("Pi binding uses its own preset while legacy provider requests remain unchanged", () => {
  const binding = { kind: "pi_provider", providerPresetId: "preset_fixture" };
  const pi = parseRunRequest({ ...base, executionBinding: binding });
  assert.deepEqual(pi.executionBinding, binding);
  assert.equal(pi.providerPresetId, "preset_fixture");
  assert.equal(pi.runnerId, "pi");
  const legacy = parseRunRequest({ ...base, providerPresetId: "preset_fixture", runnerId: "plugin-fixture" });
  assert.equal(legacy.executionBinding, undefined);
  assert.equal(legacy.providerPresetId, "preset_fixture");
  assert.equal(legacy.runnerId, "plugin-fixture");
  const inline = parseRunRequest({ ...base, provider: { provider: "openai", model: "fixture-model" } });
  assert.equal(inline.executionBinding, undefined);
  assert.equal(inline.provider.model, "fixture-model");
  assert.throws(() => parseRunRequest(base), /Either providerPresetId or provider is required/);
});

test("explicit binding cannot be silently discarded or combined with another engine/provider", () => {
  for (const fields of [
    { executionBinding: native, providerPresetId: "preset" },
    { executionBinding: native, provider: { provider: "openai", model: "wrong" } },
    { executionBinding: native, runnerId: "pi" },
    { executionBinding: native, runnerId: "kimi-acp" },
    { executionBinding: { kind: "pi_provider", providerPresetId: "preset" }, runnerId: "kimi-acp" },
  ]) {
    assert.throws(() => parseRunRequest({ ...base, ...fields }), (error) => error.code === "execution_binding_conflict");
  }
  for (const executionBinding of [null, {}, { ...native, profileRevision: 0 }, { ...native, secret: "do-not-echo" }]) {
    assert.throws(() => parseRunRequest({ ...base, executionBinding }), (error) => {
      assert.equal(error.code, "execution_binding_invalid");
      assert.equal(error.message.includes("do-not-echo"), false);
      return true;
    });
  }
  assert.throws(() => parseRunRequest({ ...base, executionBinding: native, permissionPreset: "full_access" }),
    /Full access runs require explicit permission confirmation/);
});

test("native requests are explicitly unavailable before touching a Pi provider or creating a workspace", async () => {
  const root = mkdtempSync(join(tmpdir(), "ling-native-binding-"));
  const home = process.env.LING_STACK_HOME;
  process.env.LING_STACK_HOME = join(root, "host");
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: root,
    channels: { autoRoute: false, intentSelector: false } }, {
    nativeRunTargetDispatcher: null,
    remoteReplyDispatcher: null,
  });
  try {
    await daemon.start();
    const cwd = join(root, "not-created");
    const response = await fetch(`http://127.0.0.1:${daemon.server.address().port}/runs`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...base, cwd, executionBinding: native }),
    });
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.error, "native_execution_unavailable");
    assert.equal(body.runId, undefined);
    assert.equal(existsSync(cwd), false);
  } finally {
    await daemon.stop();
    if (home === undefined) delete process.env.LING_STACK_HOME;
    else process.env.LING_STACK_HOME = home;
    rmSync(root, { recursive: true, force: true });
  }
});

test("daemon production composition routes native requests through the injected target dispatcher", async () => {
  const root = mkdtempSync(join(tmpdir(), "ling-native-composition-"));
  const home = process.env.LING_STACK_HOME;
  process.env.LING_STACK_HOME = join(root, "host");
  const piTrap = {
    async runTask() {
      throw new Error("Pi adapter must not receive a native run");
    },
  };
  const runnerRegistry = createRunnerRegistry([
    { id: "pi", displayName: "Ling", status: "enabled", adapter: piTrap },
    { id: "openclaw-acp", displayName: "OpenClaw", status: "enabled", adapter: piTrap },
  ]);
  const calls = [];
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: root,
    channels: { autoRoute: false, intentSelector: false } }, {
    runnerRegistry,
    nativeRunTargetDispatcher: {
      async dispatch(input) {
        calls.push(input);
        return { status: "completed", stopReason: "end_turn", events: [] };
      },
    },
    remoteReplyDispatcher: null,
  });
  try {
    await daemon.start();
    const baseUrl = `http://127.0.0.1:${daemon.server.address().port}`;
    const settingsResponse = await fetch(`${baseUrl}/runtime/settings?cwd=${encodeURIComponent(root)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allowedRunnerIds: ["pi", "openclaw-acp"], schemaVersion: 2, confirmNativeMigration: true,
        expectedUpdatedAt: (await (await fetch(`${baseUrl}/runtime/settings?cwd=${encodeURIComponent(root)}`)).json()).settings.updatedAt }),
    });
    assert.equal(settingsResponse.status, 200);

    const response = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...base,
        cwd: root,
        workspaceCwd: root,
        task: { ...base.task, id: "task_native_composition" },
        executionBinding: {
          kind: "native_profile",
          engineId: "openclaw-acp",
          profileId: "profile_fixture",
          profileRevision: 1,
        },
      }),
    });
    const stream = await response.text();
    assert.equal(response.status, 200);
    assert.match(stream, /event: ready/);
    assert.match(stream, /event: result/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].runRequest.executionBinding.engineId, "openclaw-acp");
    assert.equal(calls[0].runRequest.cwd, root);
    assert.equal(calls[0].run.id.startsWith("run_"), true);
  } finally {
    await daemon.stop();
    if (home === undefined) delete process.env.LING_STACK_HOME;
    else process.env.LING_STACK_HOME = home;
    rmSync(root, { recursive: true, force: true });
  }
});

test("native target cancellation remains cancelled instead of being published as success", async () => {
  const root = mkdtempSync(join(tmpdir(), "ling-native-cancelled-"));
  const home = process.env.LING_STACK_HOME;
  process.env.LING_STACK_HOME = join(root, "host");
  const piTrap = { async runTask() { throw new Error("Pi adapter must not receive a native run"); } };
  const runnerRegistry = createRunnerRegistry([
    { id: "pi", displayName: "Ling", status: "enabled", adapter: piTrap },
    { id: "openclaw-acp", displayName: "OpenClaw", status: "enabled", adapter: piTrap },
  ]);
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: root,
    channels: { autoRoute: false, intentSelector: false } }, {
    runnerRegistry,
    nativeRunTargetDispatcher: {
      async dispatch() {
        return { status: "cancelled", stopReason: "interrupted", events: [] };
      },
    },
    remoteReplyDispatcher: null,
  });
  try {
    await daemon.start();
    const baseUrl = `http://127.0.0.1:${daemon.server.address().port}`;
    const settingsResponse = await fetch(`${baseUrl}/runtime/settings?cwd=${encodeURIComponent(root)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allowedRunnerIds: ["pi", "openclaw-acp"], schemaVersion: 2, confirmNativeMigration: true,
        expectedUpdatedAt: (await (await fetch(`${baseUrl}/runtime/settings?cwd=${encodeURIComponent(root)}`)).json()).settings.updatedAt }),
    });
    assert.equal(settingsResponse.status, 200);
    const response = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...base,
        cwd: root,
        workspaceCwd: root,
        task: { ...base.task, id: "task_native_cancelled" },
        executionBinding: { kind: "native_profile", engineId: "openclaw-acp",
          profileId: "profile_fixture", profileRevision: 1 },
      }),
    });
    const stream = await response.text();
    assert.equal(response.status, 200);
    assert.match(stream, /event: run_cancelled/);
    assert.doesNotMatch(stream, /event: result/);
    const runId = stream.match(/"runId":"([^"]+)"/)?.[1];
    assert.ok(runId);
    const saved = await fetch(`${baseUrl}/runs/${encodeURIComponent(runId)}?cwd=${encodeURIComponent(root)}`);
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).status, "cancelled");
  } finally {
    await daemon.stop();
    if (home === undefined) delete process.env.LING_STACK_HOME;
    else process.env.LING_STACK_HOME = home;
    rmSync(root, { recursive: true, force: true });
  }
});

test("native OpenClaw binding reaches one injected dispatcher without touching Pi dependencies", async () => {
  const request = parseRunRequest({
    ...base,
    executionBinding: { ...native, engineId: "openclaw-acp", nativeModelId: undefined },
  });
  const touched = [];
  const trap = new Proxy({}, {
    get(_target, property) {
      touched.push(String(property));
      throw new Error(`Pi dependency touched: ${String(property)}`);
    },
  });
  const calls = [];
  const activeRuns = new ActiveRunRegistry();
  const runId = await executeRunRequest(
    request,
    createDetachedRunExecutionSink(),
    trap,
    trap,
    activeRuns,
    trap,
    trap,
    trap,
    {
      nativeRunDispatcher: {
        async dispatch(input) {
          calls.push(input);
          return "native-run-fixture";
        },
      },
    },
  );
  assert.equal(runId, "native-run-fixture");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].runRequest.executionBinding, request.executionBinding);
  assert.equal(calls[0].sink.kind, "detached");
  assert.deepEqual(touched, []);
  await activeRuns.waitForIdle();
});

test("native dispatcher failure remains fail-closed and does not fall through to Pi", async () => {
  const request = parseRunRequest({
    ...base,
    executionBinding: { ...native, engineId: "openclaw-acp", nativeModelId: undefined },
  });
  const trap = new Proxy({}, {
    get(_target, property) {
      throw new Error(`Pi dependency touched: ${String(property)}`);
    },
  });
  const sink = createDetachedRunExecutionSink();
  const activeRuns = new ActiveRunRegistry();
  await assert.rejects(
    executeRunRequest(request, sink, trap, trap, activeRuns, trap, trap, trap, {
      nativeRunDispatcher: {
        async dispatch() {
          const error = new Error("profile_revision_conflict");
          error.code = "profile_revision_conflict";
          throw error;
        },
      },
    }),
    { code: "profile_revision_conflict" },
  );
  await activeRuns.waitForIdle();
});

test("retired runnerId-only requests return migration_required before Pi dependencies", async () => {
  for (const runnerId of ["codex-app-server", "openclaw-acp", "kimi-acp", "claude-agent-sdk"]) {
    const recording = createRecordingSink();
    const trap = new Proxy({}, { get() { throw new Error("legacy request touched an execution dependency"); } });
    assert.throws(() => parseRunRequest({ ...base, runnerId }), { code: "legacy_runner_migration_required" });
    const id = await executeRunRequest({ ...base, runnerId }, recording.sink,
      trap, trap, new ActiveRunRegistry(), trap, trap, trap);
    assert.equal(id, undefined);
    assert.equal(recording.state.errors[0]?.body.error, "legacy_runner_migration_required");
    assert.equal(recording.state.errors[0]?.statusCode, 409);
  }
});

test("native run readiness callback failure cannot stop durable target execution", async (t) => {
  const calls = [];
  const fixture = createNativeWorkflowFixture(t, {
    async dispatch(input) {
      calls.push(input);
      return { status: "completed", stopReason: "end_turn", events: [] };
    },
  });
  const recording = createRecordingSink();
  const request = nativeWorkflowRequest(fixture.cwd, {
    id: "task_native_ready_callback",
    title: "Ready callback",
    prompt: "Complete despite an auxiliary callback failure.",
  });

  const runId = await fixture.dispatcher.dispatch({
    runRequest: request,
    sink: recording.sink,
    executionOptions: {
      onRunReady() {
        throw new Error("auxiliary callback failed");
      },
    },
  });

  assert.ok(runId);
  assert.equal(calls.length, 1);
  assert.equal(fixture.store.getRun(runId)?.status, "succeeded");
  assert.deepEqual(recording.state.ready, [{ ok: true, runId }]);
  assert.deepEqual(recording.state.errors, []);
  assert.equal(recording.state.ended, 1);
});

test("native duplicate readiness callback failure still returns the original run", async (t) => {
  const calls = [];
  const fixture = createNativeWorkflowFixture(t, {
    async dispatch(input) {
      calls.push(input);
      return { status: "completed", stopReason: "end_turn", events: [] };
    },
  });
  const task = {
    id: "task_native_duplicate_callback",
    title: "Duplicate callback",
    prompt: "Execute exactly once.",
  };
  const request = nativeWorkflowRequest(fixture.cwd, task, {
    idempotencyKey: "native-duplicate-ready-callback",
  });
  const first = createRecordingSink();
  const firstRunId = await fixture.dispatcher.dispatch({
    runRequest: request,
    sink: first.sink,
    executionOptions: {},
  });
  assert.ok(firstRunId);

  const duplicate = createRecordingSink();
  const duplicateRunId = await fixture.dispatcher.dispatch({
    runRequest: request,
    sink: duplicate.sink,
    executionOptions: {
      onRunReady() {
        throw new Error("duplicate callback failed");
      },
    },
  });

  assert.equal(duplicateRunId, firstRunId);
  assert.equal(calls.length, 1);
  assert.equal(fixture.store.getRun(firstRunId)?.status, "succeeded");
  assert.deepEqual(duplicate.state.ready, [{ ok: true, runId: firstRunId, duplicate: true }]);
  assert.deepEqual(duplicate.state.errors, []);
  assert.equal(duplicate.state.ended, 1);
});

test("duplicate native requests preserve the active thread while the original target runs", async (t) => {
  let release;
  let started;
  const running = new Promise((resolve) => { started = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const fixture = createNativeWorkflowFixture(t, {
    async dispatch() {
      calls++;
      started();
      await held;
      return { status: "completed", stopReason: "end_turn", events: [] };
    },
    release() { release(); },
  });
  const request = nativeWorkflowRequest(fixture.cwd, {
    id: "task_native_duplicate_active", title: "Duplicate active request", prompt: "Execute once.",
  }, { idempotencyKey: "duplicate-active-request" });
  const original = createRecordingSink();
  const pending = fixture.dispatcher.dispatch({ runRequest: request, sink: original.sink, executionOptions: {} });
  await running;
  const runId = original.state.ready[0].runId;
  const source = fixture.store.getRun(runId);
  const before = fixture.store.getLingThread(source.threadId);
  try {
    fixture.runnerRegistry.resolve = () => { throw new Error("availability changed after original admission"); };
    const duplicate = createRecordingSink();
    const repeated = await fixture.dispatcher.dispatch({ runRequest: request, sink: duplicate.sink, executionOptions: {} });
    assert.equal(repeated, runId);
    assert.equal(calls, 1);
    assert.equal(fixture.store.getRun(runId).status, "running");
    assert.equal(fixture.store.getLingThread(source.threadId).status, before.status);
    assert.equal(fixture.store.getLingThread(source.threadId).activeRunId, runId);
  } finally {
    release();
    await pending;
  }
});

function beginNativeWorkflow(fixture) {
  const now = new Date().toISOString();
  const channel = fixture.store.createChannel({ name: "Native workflow", boundPath: fixture.cwd }, now);
  const workflow = fixture.store.createChannelWorkflow({ channelId: channel.id, title: "Owned native run",
    objective: "Execute only for the current workflow owner", status: "ready", createdBy: "local-user" }, now);
  const step = fixture.store.createChannelWorkflowStep({ workflowId: workflow.id, title: "Inspect",
    prompt: "Inspect workspace", toParticipantId: "teammate_builtin_engineer", toParticipantLabel: "Engineer" }, now);
  const lease = fixture.store.acquireResourceLease({ workspaceId: channel.workspaceId, resourceType: "workflow_step",
    resourceKey: step.id, ownerType: "workflow_step", ownerId: step.id, acquiredAt: now,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  const start = fixture.store.beginChannelWorkflowStepStart({ workflowStepId: step.id,
    expected: { status: step.status, taskId: step.taskId, runId: step.runId, updatedAt: step.updatedAt },
    leaseId: lease.id, task: { channelId: channel.id, title: "Inspect", prompt: "Inspect workspace",
      assigneeTeammateId: "teammate_builtin_engineer" }, now });
  assert.equal(start.status, "begun");
  return { step, start };
}

test("native workflow without its captured start owner cannot invoke the target", async (t) => {
  let calls = 0, admissions = 0;
  const fixture = createNativeWorkflowFixture(t, { async assertAvailable() { admissions++; }, async dispatch() {
    calls++;
    return { status: "completed", events: [] };
  } });
  const { step, start } = beginNativeWorkflow(fixture);
  const recording = createRecordingSink();
  const runId = await fixture.dispatcher.dispatch({
    runRequest: nativeWorkflowRequest(fixture.cwd, start.task, { workflowStepId: step.id }),
    sink: recording.sink, executionOptions: {},
  });
  assert.equal(calls, 0);
  assert.equal(admissions, 0, "missing workflow authority must reject before any native preflight");
  assert.equal(runId, undefined);
  assert.equal(recording.state.errors[0]?.statusCode, 409);
  assert.equal(recording.state.errors[0]?.body.error, "workflow_start_owner_stale", JSON.stringify(recording.state.errors));
  assert.equal(fixture.store.getChannelWorkflowStep(step.id).runId, undefined);
  assert.deepEqual(fixture.store.listLingThreads({ workflowStepId: step.id, channelId: start.task.channelId }), [],
    "missing authority must reject before creating any canonical source Thread");
});

test("native workflow revalidates its original owner after awaited availability before creating a Turn", async t => {
  let calls = 0, admissions = 0;
  let fixture, owner, stepId;
  fixture = createNativeWorkflowFixture(t, {
    async assertAvailable() {
      admissions++;
      await Promise.resolve();
      fixture.store.releaseResourceLease(owner.leaseId, "workflow_step", stepId, new Date().toISOString());
    },
    async dispatch() { calls++; return { status: "completed", events: [] }; },
  });
  const { step, start } = beginNativeWorkflow(fixture);
  owner = start.owner;
  stepId = step.id;
  const recording = createRecordingSink();
  const runId = await fixture.dispatcher.dispatch({
    runRequest: nativeWorkflowRequest(fixture.cwd, start.task, {
      workflowStepId: step.id, workflowStartOwner: start.owner, teammateId: "teammate_builtin_engineer",
    }), sink: recording.sink, executionOptions: {},
  });
  assert.equal(admissions, 1);
  assert.equal(calls, 0);
  assert.equal(runId, undefined);
  assert.deepEqual(recording.state.errors.map(({ statusCode, body }) => ({ statusCode, error: body.error })),
    [{ statusCode: 409, error: "workflow_start_owner_stale" }]);
  assert.deepEqual(recording.state.ready, []);
  const threads = fixture.store.listLingThreads({ workflowStepId: step.id, channelId: start.task.channelId });
  assert.equal(threads.length, 1, "native availability uses its real preparation Thread");
  const [thread] = threads;
  assert.equal(thread.kind, "workflow_step");
  assert.equal(thread.taskId, start.task.id);
  assert.equal(thread.teammateId, "teammate_builtin_engineer");
  assert.equal(thread.status, "failed");
  assert.equal(thread.activeRunId, undefined);
  assert.deepEqual(fixture.store.listLingTurns({ threadId: thread.id, limit: 100 }), []);
  assert.deepEqual(fixture.store.listWorkUnits(), [], "the isolated Store has no admitted WorkUnit");
  assert.deepEqual(fixture.store.listRuns(), [], "the isolated Store has no admitted Run");
  assert.equal(fixture.store.getChannelWorkflowStep(step.id).runId, undefined);
});

test("native workflow commits its captured owner before notifying ready and executing", async (t) => {
  let calls = 0;
  const fixture = createNativeWorkflowFixture(t, { async dispatch(input) {
    calls++;
    assert.equal(input.store.getChannelWorkflowStep(input.run.workflowStepId).runId, input.run.id);
    return { status: "completed", events: [] };
  } });
  const { step, start } = beginNativeWorkflow(fixture);
  const recording = createRecordingSink();
  const runId = await fixture.dispatcher.dispatch({
    runRequest: nativeWorkflowRequest(fixture.cwd, start.task, {
      workflowStepId: step.id, workflowStartOwner: start.owner, teammateId: "teammate_builtin_engineer",
    }), sink: recording.sink,
    executionOptions: { onRunReady(id) { assert.equal(fixture.store.getChannelWorkflowStep(step.id).runId, id); } },
  });
  assert.deepEqual(recording.state.errors, []);
  assert.equal(calls, 1);
  assert.equal(fixture.store.getRun(runId).status, "succeeded");
});

test("native workflow owner revoked at readiness cannot invoke the target", async (t) => {
  let calls = 0;
  const fixture = createNativeWorkflowFixture(t, { async dispatch() { calls++; return { status: "completed", events: [] }; } });
  const { step, start } = beginNativeWorkflow(fixture);
  const recording = createRecordingSink();
  const runId = await fixture.dispatcher.dispatch({
    runRequest: nativeWorkflowRequest(fixture.cwd, start.task, {
      workflowStepId: step.id, workflowStartOwner: start.owner, teammateId: "teammate_builtin_engineer",
    }), sink: recording.sink,
    executionOptions: { onRunReady() {
      fixture.store.releaseResourceLease(start.owner.leaseId, "workflow_step", step.id, new Date().toISOString());
    } },
  });
  assert.equal(calls, 0);
  assert.equal(fixture.store.getRun(runId).status, "failed");
});

test("native running attempt renews heartbeat without output", async (t) => {
  let started, release;
  const running = new Promise(resolve => { started = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  let observed;
  const fixture = createNativeWorkflowFixture(t, { async dispatch(input) {
    observed = input;
    started(); await held;
    return { status: "completed", events: [] };
  }, release() { release(); } });
  t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: Date.now() });
  const recording = createRecordingSink();
  const pending = fixture.dispatcher.dispatch({ runRequest: nativeWorkflowRequest(fixture.cwd, {
    id: "heartbeat-without-output", title: "Heartbeat", prompt: "Wait quietly",
  }), sink: recording.sink, executionOptions: {} });
  await running;
  try {
    const before = fixture.store.getWorkUnit(observed.workUnit.id);
    t.mock.timers.tick(before.timeoutPolicy.heartbeatIntervalMs + 1);
    const after = fixture.store.getWorkUnit(observed.workUnit.id);
    assert.ok(Date.parse(after.lastHeartbeatAt) > Date.parse(before.lastHeartbeatAt));
    assert.equal(after.status, "running");
  } finally { release(); await pending; }
});

test("native heartbeats do not refresh meaningful activity or prevent idle timeout", async (t) => {
  let started, release;
  const running = new Promise(resolve => { started = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  let observed;
  const fixture = createNativeWorkflowFixture(t, { async dispatch(input) {
    observed = input; started(); await held;
    return { status: "completed", events: [] };
  }, release() { release(); } });
  t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: Date.now() });
  let monotonic = performance.now();
  t.mock.method(performance, "now", () => monotonic);
  const recording = createRecordingSink();
  const pending = fixture.dispatcher.dispatch({ runRequest: nativeWorkflowRequest(fixture.cwd, {
    id: "idle-with-heartbeat", title: "Idle budget", prompt: "Wait without output",
  }), sink: recording.sink, executionOptions: {} });
  await running;
  try {
    monotonic += observed.workUnit.timeoutPolicy.idleTimeoutMs + 10_001;
    t.mock.timers.tick(observed.workUnit.timeoutPolicy.idleTimeoutMs + 10_001);
    assert.equal(observed.signal.aborted, true);
    assert.equal(observed.signal.reason.code, "idle_timeout");
  } finally { release(); await pending; }
  assert.equal(fixture.store.getRun(recording.state.ready[0].runId).status, "failed");
});

test("native idle budget ignores forward and backward wall clock adjustments", async (t) => {
  let started, release, observed;
  const running = new Promise(resolve => { started = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const fixture = createNativeWorkflowFixture(t, { async dispatch(input) {
    observed = input; started(); await held; return { status: "completed", events: [] };
  }, release() { release(); } });
  t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: Date.now() });
  const pending = fixture.dispatcher.dispatch({ runRequest: nativeWorkflowRequest(fixture.cwd, {
    id: "clock-adjustment", title: "Clock", prompt: "Wait",
  }), sink: createRecordingSink().sink, executionOptions: {} });
  await running;
  try {
    const policy = observed.workUnit.timeoutPolicy;
    t.mock.timers.setTime(Date.now() + policy.idleTimeoutMs * 4);
    t.mock.timers.tick(policy.heartbeatIntervalMs + 1);
    assert.equal(observed.signal.aborted, false, "forward wall clock change must not exhaust idle budget");
    t.mock.timers.setTime(Date.now() - policy.idleTimeoutMs * 8);
    t.mock.timers.tick(policy.heartbeatIntervalMs + 1);
    assert.equal(observed.signal.aborted, false);
  } finally { release(); await pending; }
});

test("native terminal callbacks wait for original writers and durable resource cleanup", async (t) => {
  let release, started, observed, terminalCalled = false;
  const held = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  const fixture = createNativeWorkflowFixture(t, { async dispatch(input) {
    observed = input;
    input.onLocalLifetime(held);
    started();
    return { status: "completed", events: [] };
  }, release() { release(); } });
  const recording = createRecordingSink();
  const pending = fixture.dispatcher.dispatch({ runRequest: nativeWorkflowRequest(fixture.cwd, {
    id: "original-writer-drain", title: "Drain", prompt: "Finish after local writers",
  }), sink: recording.sink, executionOptions: { afterRunTerminal() { terminalCalled = true; } } });
  await entered;
  await new Promise(resolve => setImmediate(resolve));
  const source = { runId: observed.run.id, workUnitId: observed.workUnit.id, attemptId: observed.attempt.id,
    runtimeInstanceId: observed.attempt.runtimeInstanceId, fencingToken: observed.attempt.fencingToken };
  try {
    assert.equal(fixture.store.getRun(source.runId).status, "succeeded");
    assert.equal(terminalCalled, false);
    assert.equal(fixture.store.getHostAttemptCompletion(source).drainedAt, undefined);
    assert.ok(fixture.store.listRuntimeSemaphoreSlots({ workUnitId: source.workUnitId, status: "active" }).length > 0);
  } finally { release(); await pending; }
  assert.equal(terminalCalled, true);
  assert.equal(fixture.store.getHostAttemptCompletion(source).effectCoverage, "native_journal_v1");
  assert.equal(fixture.store.listRuntimeSemaphoreSlots({ workUnitId: source.workUnitId, status: "active" }).length, 0);
});

test("native queued guidance executes FIFO successors with the original binding and lineage", async (t) => {
  let fixture, rootId, previousUnitId;
  const calls = [], interventions = [];
  fixture = createNativeWorkflowFixture(t, { async dispatch(input) {
    calls.push(input.runRequest);
    if (calls.length === 1) {
      rootId = input.run.id;
      for (let index = 0; index < 2; index++) interventions.push(fixture.store.createRunIntervention({
        sourceRunId: rootId, sourceWorkUnitId: input.workUnit.id, sourceAttemptId: input.attempt.id,
        mode: "queue_followup", instruction: `Followup ${index}`, idempotencyKey: `native-fifo-${index}`, requestedBy: "local-user",
      }, new Date().toISOString()).id);
    } else {
      assert.equal(fixture.store.listRuntimeSemaphoreSlots({ workUnitId: previousUnitId, status: "active" }).length, 0);
      assert.equal(input.run.parentRunId, rootId);
    }
    previousUnitId = input.workUnit.id;
    return { status: "completed", events: [] };
  } });
  const request = nativeWorkflowRequest(fixture.cwd, { id: "native-fifo-source", title: "FIFO", prompt: "Original task" }, { authorizationMode: "smart", workspaceAccessMode: "read_only", permissionMode: "custom" });
  const continueRun = terminalRun => maybeStartNextRunInterventionContinuation({ ...fixture, terminalRun,
    sourceRunId: terminalRun.parentRunId ?? terminalRun.id, nativeRunDispatcher: fixture.dispatcher, mcpBroker: {},
  });
  await fixture.dispatcher.dispatch({ runRequest: request, sink: createRecordingSink().sink,
    executionOptions: { afterRunTerminal: continueRun } });
  await fixture.activeRuns.waitForIdle(2_000);
  assert.equal(calls.length, 3, JSON.stringify(interventions.map(id => fixture.store.getRunIntervention(id))));
  for (const next of calls) {
    assert.deepEqual(next.executionBinding, request.executionBinding);
    assert.equal(next.authorizationMode, "smart");
    assert.equal(next.workspaceAccessMode, "read_only");
  }
  assert.deepEqual(calls.slice(1).map(call => call.interventionId), interventions);
  for (const id of interventions) {
    const continuation = fixture.store.getRunIntervention(id);
    // Mainline records a consumed instruction as started, with completedAt once its Run ends.
    assert.equal(continuation.status, "started");
    assert.ok(continuation.completedAt, "terminal callback must durably complete the consumed guidance");
    assert.equal(fixture.store.getRun(continuation.continuationRunId).status, "succeeded");
  }
});

test("native approval wait pauses both budgets and resumes the remaining hard deadline", { timeout: 5_000 }, async (t) => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const fixture = createNativeWorkflowFixture(t, { async dispatch(input) {
    input.onApprovalWaitChanged(true);
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(input.signal.aborted, false, "user wait must not consume either execution budget");
    input.onApprovalWaitChanged(false);
    await Promise.race([held, new Promise(resolve => input.signal.addEventListener("abort", resolve, { once: true }))]);
    assert.equal(input.signal.reason?.code, "hard_timeout");
    return { status: "completed", events: [] }; // A late success must not overwrite the watchdog.
  }, release() { release(); } }, {
    heartbeatIntervalMs: 10, heartbeatTimeoutMs: 500, idleTimeoutMs: 1_000, hardTimeoutMs: 150, cancelGraceMs: 20,
  });
  const guard = setTimeout(release, 2_000);
  const recording = createRecordingSink();
  try {
    const id = await fixture.dispatcher.dispatch({ runRequest: nativeWorkflowRequest(fixture.cwd, {
      id: "approval-hard-budget", title: "Hard budget", prompt: "Wait for approval then exceed execution budget",
    }), sink: recording.sink, executionOptions: {} });
    assert.equal(fixture.store.getRun(id).status, "failed");
    assert.equal(fixture.store.getRun(id).errorMessage, "hard_timeout");
  } finally { clearTimeout(guard); }
});

test("native queued readiness callback failure preserves the durable conflict queue", async (t) => {
  let releaseFirst;
  let markStarted;
  const firstStarted = new Promise((resolve) => { markStarted = resolve; });
  const firstReleased = new Promise((resolve) => { releaseFirst = resolve; });
  const calls = [];
  const target = {
    async dispatch(input) {
      calls.push(input);
      markStarted?.();
      await firstReleased;
      return { status: "completed", stopReason: "end_turn", events: [] };
    },
    release() {
      releaseFirst?.();
    },
  };
  const fixture = createNativeWorkflowFixture(t, target);
  const createdAt = new Date().toISOString();
  const firstChannel = fixture.store.createChannel({
    name: "Native writer A",
    boundPath: fixture.cwd,
    allowedTools: ["read", "write"],
    runtimePolicy: { queueOnConflict: true },
  }, createdAt);
  const secondChannel = fixture.store.createChannel({
    name: "Native writer B",
    boundPath: fixture.cwd,
    allowedTools: ["read", "write"],
    runtimePolicy: { queueOnConflict: true },
  }, createdAt);
  const firstTask = fixture.store.createTask({
    channelId: firstChannel.id,
    title: "Hold native write lease",
    prompt: "Hold the shared path lease.",
  }, createdAt);
  const secondTask = fixture.store.createTask({
    channelId: secondChannel.id,
    title: "Queue native write lease",
    prompt: "Wait for the shared path lease.",
  }, createdAt);
  const first = createRecordingSink();
  const firstRunPromise = fixture.dispatcher.dispatch({
    runRequest: nativeWorkflowRequest(fixture.cwd, firstTask, {
      tools: ["write"],
      idempotencyKey: "native-first-writer",
    }),
    sink: first.sink,
    executionOptions: {},
  });
  await firstStarted;

  const queued = createRecordingSink();
  const queuedRunId = await fixture.dispatcher.dispatch({
    runRequest: nativeWorkflowRequest(fixture.cwd, secondTask, {
      tools: ["write"],
      idempotencyKey: "native-second-writer",
    }),
    sink: queued.sink,
    executionOptions: {
      onRunReady() {
        throw new Error("queued callback failed");
      },
    },
  });

  assert.ok(queuedRunId);
  assert.equal(calls.length, 1);
  assert.equal(fixture.store.getRun(queuedRunId)?.status, "queued");
  const queuedReady = queued.state.ready[0];
  assert.deepEqual(queuedReady, {
    ok: true,
    runId: queuedRunId,
    workUnitId: queuedReady.workUnitId,
    queued: true,
    queueReason: "resource_conflict",
  });
  assert.equal(fixture.store.getWorkUnit(queuedReady.workUnitId)?.status, "queued");
  assert.deepEqual(queued.state.errors, []);
  assert.equal(queued.state.ended, 1);

  target.release();
  const firstRunId = await firstRunPromise;
  assert.ok(firstRunId);
  assert.equal(fixture.store.getRun(firstRunId)?.status, "succeeded");
});

test("saved OpenClaw binding invokes the owned executor once with host-derived identity", async (t) => {
  const f = createOpenClawTargetFixture(t);
  const published = [];
  const event = { id: "event_fixture", runId: "run_fixture", seq: 1, ts: new Date().toISOString(),
    type: "assistant_text_delta", data: { text: "fixture" } };
  f.executeResult = { status: "completed", stopReason: "end_turn", events: [event] };
  f.onExecute = (input) => input.onEvent(event);

  const result = await f.dispatcher.dispatch(f.input({ onEvent: (value) => published.push(value) }));

  assert.equal(f.probes.length, 1);
  assert.equal(f.executions.length, 1);
  assert.equal(f.generations.length, 1);
  assert.equal(f.generations[0].selection.profileFingerprint, f.profile.configurationFingerprint);
  assert.equal(f.executions[0].reservation.generation, 1);
  assert.equal(f.executions[0].reservation.selection.profileFingerprint, f.profile.configurationFingerprint);
  assert.match(f.executions[0].reservation.selection.configurationFingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(f.executions[0].input, [{ type: "text", text: base.task.prompt }]);
  assert.equal(f.executions[0].configuration.cwd, base.cwd);
  assert.deepEqual(result, f.executeResult);
  assert.deepEqual(published, [event], "the target must not republish journal-owned events");
});

test("native target rejects stale profile identity before probing or launching", async (t) => {
  const f = createOpenClawTargetFixture(t);
  const input = f.input({ binding: { profileRevision: f.profile.revision + 1 } });
  await assert.rejects(f.dispatcher.dispatch(input), { code: "profile_revision_conflict" });
  assert.equal(f.probes.length, 0);
  assert.equal(f.executions.length, 0);
  assert.equal(f.generations.length, 0);
});

test("installation evidence must belong to the exact saved profile before launch", async (t) => {
  const f = createOpenClawTargetFixture(t, { probePatch: { configurationFingerprint: "f".repeat(64) } });
  await assert.rejects(f.dispatcher.dispatch(f.input()), { code: "native_execution_unavailable" });
  assert.equal(f.probes.length, 1);
  assert.equal(f.executions.length, 0);
  assert.equal(f.generations.length, 0);
});

test("saved Codex binding invokes the owned executor once with the bound model and profile auth home", async (t) => {
  const f = createCodexTargetFixture(t);

  const result = await f.dispatcher.dispatch(f.input());

  assert.equal(f.probes.length, 1);
  assert.equal(f.executions.length, 1);
  assert.equal(f.generations.length, 1);
  assert.equal(f.generations[0].selection.engineId, "codex-app-server");
  assert.equal(f.generations[0].selection.modelId, "native-model");
  assert.equal(f.generations[0].selection.profileFingerprint, f.profile.configurationFingerprint);
  assert.match(f.generations[0].selection.configurationFingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(f.executions[0].configuration, {
    cwd: base.cwd,
    model: "native-model",
    modelProvider: "openai",
    approvalPolicy: "on-request",
    sandbox: {
      type: "workspaceWrite",
      writableRoots: [base.cwd],
      networkAccess: false,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    },
  });
  assert.deepEqual(f.executions[0].input, { input: [{
    type: "text",
    text: base.task.prompt,
    text_elements: [],
  }] });
  assert.equal(f.executions[0].process.codexHome, f.authHome);
  assert.equal(f.executions[0].process.executablePath, f.profile.configuration.executablePath);
  assert.equal(f.executions[0].authentication.store, f.profileStore);
  assert.deepEqual(f.executions[0].authentication.profile, f.profile);
  assert.equal(f.executions[0].authentication.secretResolver, f.secretResolver);
  assert.deepEqual(result, f.executeResult);
});

test("Codex binding requires a native model and current profile before probing or launching", async (t) => {
  const f = createCodexTargetFixture(t);
  await assert.rejects(f.dispatcher.dispatch(f.input({ binding: { nativeModelId: undefined } })), {
    code: "native_execution_unavailable",
  });
  await assert.rejects(f.dispatcher.dispatch(f.input({ binding: { profileRevision: f.profile.revision + 1 } })), {
    code: "profile_revision_conflict",
  });
  assert.equal(f.probes.length, 0);
  assert.equal(f.executions.length, 0);
  assert.equal(f.generations.length, 0);
});

test("Codex installation evidence must match the saved profile before launch", async (t) => {
  const f = createCodexTargetFixture(t, { probePatch: { configurationFingerprint: "f".repeat(64) } });
  await assert.rejects(f.dispatcher.dispatch(f.input()), { code: "native_execution_unavailable" });
  assert.equal(f.probes.length, 1);
  assert.equal(f.executions.length, 0);
  assert.equal(f.generations.length, 0);
});

test("Codex sandbox selection follows the effective Ling workspace policy", async (t) => {
  const f = createCodexTargetFixture(t);
  const defaults = f.input().effectivePolicySnapshot;
  const cases = [
    {
      policy: { ...defaults, workspaceAccessMode: "read_only", allowedWritePaths: [] },
      expected: { type: "readOnly", networkAccess: false },
    },
    {
      policy: { ...defaults, conversationMode: "plan", workspaceAccessMode: "full_access", allowedWritePaths: ["/"] },
      expected: { type: "readOnly", networkAccess: false },
    },
    {
      policy: { ...defaults, workspaceAccessMode: "full_access", allowedWritePaths: ["/"] },
      expected: { type: "dangerFullAccess" },
    },
  ];
  for (const item of cases) {
    await f.dispatcher.dispatch(f.input({ effectivePolicySnapshot: item.policy }));
    assert.deepEqual(f.executions.at(-1).configuration.sandbox, item.expected);
  }
  assert.equal(f.executions.length, cases.length);
});

test("saved Kimi API-key binding invokes the owned executor with its fixed profile model and auth home", async (t) => {
  const f = createKimiTargetFixture(t, { authentication: "api-key" });

  const result = await f.dispatcher.dispatch(f.input());

  assert.equal(f.probes.length, 1);
  assert.equal(f.executions.length, 1);
  assert.equal(f.generations.length, 1);
  assert.equal(f.generations[0].selection.engineId, "kimi-acp");
  assert.equal(f.generations[0].selection.modelId, undefined);
  assert.equal(f.generations[0].selection.profileFingerprint, f.profile.configurationFingerprint);
  assert.match(f.generations[0].selection.configurationFingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(f.executions[0].configuration, { cwd: base.cwd });
  assert.deepEqual(f.executions[0].input, [{ type: "text", text: base.task.prompt }]);
  assert.equal(f.executions[0].process.kimiHome, f.authHome);
  assert.equal(f.executions[0].process.executablePath, f.profile.configuration.executablePath);
  assert.equal(f.executions[0].process.expectedVersion, "2026.9.11");
  assert.equal(f.executions[0].authentication.store, f.profileStore);
  assert.deepEqual(f.executions[0].authentication.profile, f.profile);
  assert.equal(f.executions[0].authentication.secretResolver, f.secretResolver);
  assert.equal(f.executions[0].authentication.region, undefined);
  assert.deepEqual(result, f.executeResult);
});

test("saved Kimi OAuth binding preserves an optional native model and explicit account region", async (t) => {
  const f = createKimiTargetFixture(t, { authentication: "oauth" });

  await f.dispatcher.dispatch(f.input({ binding: { nativeModelId: "kimi-for-coding" } }));

  assert.equal(f.executions.length, 1);
  assert.deepEqual(f.executions[0].configuration, { cwd: base.cwd, modelId: "kimi-for-coding" });
  assert.equal(f.executions[0].reservation.selection.modelId, "kimi-for-coding");
  assert.equal(f.executions[0].authentication.store, f.profileStore);
  assert.deepEqual(f.executions[0].authentication.profile, f.profile);
  assert.equal(f.executions[0].authentication.region, "global");
  assert.equal(f.executions[0].authentication.secretResolver, undefined);
});

test("Kimi rejects a model override for a fixed API-key profile before probing or launching", async (t) => {
  const f = createKimiTargetFixture(t, { authentication: "api-key" });

  await assert.rejects(f.dispatcher.dispatch(f.input({ binding: { nativeModelId: "customer-model" } })), {
    code: "native_execution_unavailable",
  });

  assert.equal(f.probes.length, 0);
  assert.equal(f.executions.length, 0);
  assert.equal(f.generations.length, 0);
});

test("Kimi OAuth requires an explicit saved account region before probing or launching", async (t) => {
  const f = createKimiTargetFixture(t, { authentication: "oauth", region: undefined });

  await assert.rejects(f.dispatcher.dispatch(f.input()), { code: "native_execution_unavailable" });

  assert.equal(f.probes.length, 0);
  assert.equal(f.executions.length, 0);
  assert.equal(f.generations.length, 0);
});

test("unwired native engines fail closed without probing or launching", async (t) => {
  const f = createOpenClawTargetFixture(t);
  await assert.rejects(f.dispatcher.dispatch(f.input({ binding: { engineId: "claude-agent-sdk" } })), { code: "native_execution_unavailable" });
  assert.equal(f.probes.length, 0);
  assert.equal(f.executions.length, 0);
  assert.equal(f.generations.length, 0);
});

test("native target ignores connection flags without current verifier-owned acceptance", async (t) => {
  const f = createCodexTargetFixture(t, { readAcceptanceEvidence: () => undefined });
  await assert.rejects(f.dispatcher.dispatch(f.input()), { code: "native_execution_verification_missing" });
  assert.equal(f.executions.length, 0);
  assert.equal(f.generations.length, 0);
});

for (const create of [createCodexTargetFixture, createKimiTargetFixture, createOpenClawTargetFixture]) {
  for (const state of ["revoked", "expired"]) test(`${create.name} blocks ${state} acceptance at final submission authority`, async t => {
    let invalid = false, submitted = 0;
    const f = create(t, { readAcceptanceEvidence(identity) {
      const evidence = fixtureNativeAcceptance(identity);
      return !invalid ? evidence : state === "revoked" ? { ...evidence, revokedAt: new Date().toISOString() }
        : { ...evidence, verifiedAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-02T00:00:00.000Z" };
    } });
    f.onExecute = async input => {
      await Promise.resolve(); // Protocol preparation can yield after target admission.
      invalid = true;
      input.assertCurrentAuthority();
      submitted++;
    };
    await assert.rejects(f.dispatcher.dispatch(f.input()), { code: `native_execution_verification_${state}` });
    assert.equal(submitted, 0);
  });
}

test("native final submission rejects a profile changed during protocol preparation", async t => {
  const f = createCodexTargetFixture(t);
  let submitted = 0;
  f.onExecute = async input => {
    await Promise.resolve();
    f.profileStore.save({ ...f.profile.configuration, authProfileId: "changed-fixture" }, f.profile.revision);
    input.assertCurrentAuthority();
    submitted++;
  };
  await assert.rejects(f.dispatcher.dispatch(f.input()), { code: "profile_revision_conflict" });
  assert.equal(submitted, 0);
});

test("native Codex preserves private developer instructions apart from user input", async t => {
  const f = createCodexTargetFixture(t);
  const input = f.input();
  input.runRequest.appendSystemPrompt = ["NATIVE_PRIVATE_MEMORY_CANARY"];
  await f.dispatcher.dispatch(input);
  assert.equal(f.executions[0].configuration.developerInstructions, "NATIVE_PRIVATE_MEMORY_CANARY");
  assert.doesNotMatch(JSON.stringify(f.executions[0].input), /NATIVE_PRIVATE_MEMORY_CANARY/);
});

for (const create of [createCodexTargetFixture, createKimiTargetFixture, createOpenClawTargetFixture]) {
  test(`${create.name} retains the outer Host authority check after native preparation`, async t => {
    const f = create(t);
    let revoked = false, submitted = 0;
    const input = f.input();
    input.assertCurrentAuthority = () => { if (revoked) throw Object.assign(new Error("Host Memory no longer current"), { code: "prepared_memory_unavailable" }); };
    f.onExecute = async execution => {
      await Promise.resolve();
      revoked = true;
      execution.assertCurrentAuthority();
      submitted++;
    };
    await assert.rejects(f.dispatcher.dispatch(input), { code: "prepared_memory_unavailable" });
    assert.equal(submitted, 0);
  });
}

for (const create of [createKimiTargetFixture, createOpenClawTargetFixture]) {
  test(`${create.name} rejects private Memory rather than lowering it to user input`, async t => {
    const f = create(t);
    const input = f.input();
    input.runRequest.appendSystemPrompt = ["NATIVE_PRIVATE_MEMORY_CANARY"];
    await assert.rejects(f.dispatcher.dispatch(input), { code: "native_execution_system_instructions_unsupported" });
    assert.equal(f.executions.length, 0);
  });
}

function createOpenClawTargetFixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "ling-openclaw-target-"));
  const profileStore = new ExecutionEngineProfileStore(resolveUserConfigPaths({ userRootDir: root }));
  const configuration = { engineId: "openclaw-acp", executablePath: process.execPath,
    authProfileId: "openclaw-fixture", secretRef: "env:OPENCLAW_FIXTURE_TOKEN",
    openclaw: { gatewayUrl: "ws://127.0.0.1:18789", agentId: "main", credentialType: "token" } };
  const profile = profileStore.save(configuration, 0);
  const probes = [];
  const executions = [];
  const generations = [];
  const fixture = {
    probes,
    executions,
    generations,
    profile,
    executeResult: { status: "completed", stopReason: "end_turn", events: [] },
    onExecute: undefined,
  };
  const dispatcher = createExecutionEngineRunTargetDispatcher({
    getProfileStore: () => profileStore,
    readWorkspaceSettings: () => fixtureNativePolicy("openclaw-acp"),
    readAcceptanceEvidence: options.readAcceptanceEvidence ?? fixtureNativeAcceptance,
    secretResolver: {
      status: () => "available",
      resolve: (ref) => ({ ref, configured: true, status: "available", value: "fixture-token" }),
    },
    probeInstallation: async (candidate) => {
      probes.push(candidate);
      return { profileId: candidate.id, profileRevision: candidate.revision,
        configurationFingerprint: candidate.configurationFingerprint, checkedAt: new Date().toISOString(),
        status: "installed", authentication: "not_checked", connection: "not_checked",
        runtimeVersion: "2026.9.9", executableDigest: "a".repeat(64), ...options.probePatch };
    },
    executeOpenClaw: async (input) => {
      executions.push(input);
      await fixture.onExecute?.(input);
      return fixture.executeResult;
    },
  });
  t.after(() => {
    profileStore.close();
    rmSync(root, { recursive: true, force: true });
  });
  Object.assign(fixture, {
    dispatcher,
    input({ binding = {}, onEvent = () => {} } = {}) {
      const executionBinding = { kind: "native_profile", engineId: "openclaw-acp",
        profileId: profile.id, profileRevision: profile.revision, ...binding };
      return {
        runRequest: { ...base, executionBinding },
        store: {
          resolveNativeExecutionGeneration(value) {
            generations.push(value);
            return 1;
          },
        },
        run: { id: "run_fixture" },
        workUnit: { id: "work_fixture" },
        attempt: { id: "attempt_fixture", workUnitId: "work_fixture", runtimeInstanceId: "runtime_fixture",
          fencingToken: "fence_fixture" },
        approvalPolicy: { bash: "ask" },
        effectivePolicySnapshot: { mode: "workspace-write" },
        signal: new AbortController().signal,
        onEvent,
      };
    },
  });
  return fixture;
}

function createCodexTargetFixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "ling-codex-target-"));
  const profileStore = new ExecutionEngineProfileStore(resolveUserConfigPaths({ userRootDir: root }));
  const configuration = { engineId: "codex-app-server", executablePath: process.execPath,
    authProfileId: "codex-fixture" };
  const profile = profileStore.save(configuration, 0);
  const authHome = profileStore.getAuthProfileDirectory(profile);
  mkdirSync(authHome, { recursive: true, mode: 0o700 });
  const probes = [];
  const executions = [];
  const generations = [];
  const secretResolver = {
    status: () => "missing",
    resolve: (ref) => ({ ref, configured: false, status: "missing" }),
  };
  const fixture = {
    probes,
    executions,
    generations,
    profile,
    profileStore,
    secretResolver,
    authHome,
    executeResult: { status: "completed", stopReason: "end_turn", events: [] },
  };
  const dispatcher = createExecutionEngineRunTargetDispatcher({
    getProfileStore: () => profileStore,
    readWorkspaceSettings: () => fixtureNativePolicy("codex-app-server"),
    readAcceptanceEvidence: options.readAcceptanceEvidence ?? fixtureNativeAcceptance,
    secretResolver,
    probeInstallation: async (candidate) => {
      probes.push(candidate);
      return { profileId: candidate.id, profileRevision: candidate.revision,
        configurationFingerprint: candidate.configurationFingerprint, checkedAt: new Date().toISOString(),
        status: "installed", authentication: "authenticated", connection: "connected",
        runtimeVersion: "2026.9.10", executableDigest: "b".repeat(64), ...options.probePatch };
    },
    executeCodex: async (input) => {
      executions.push(input);
      await fixture.onExecute?.(input);
      return fixture.executeResult;
    },
  });
  t.after(() => {
    profileStore.close();
    rmSync(root, { recursive: true, force: true });
  });
  Object.assign(fixture, {
    dispatcher,
    input({ binding = {}, effectivePolicySnapshot, onEvent = () => {} } = {}) {
      const executionBinding = { kind: "native_profile", engineId: "codex-app-server",
        profileId: profile.id, profileRevision: profile.revision, nativeModelId: "native-model", ...binding };
      const policy = effectivePolicySnapshot ?? { mode: "workspace_write", workspaceAccessMode: "workspace_write",
        conversationMode: "default", toolDecisions: {}, allowedWritePaths: [base.cwd],
        workspacePolicyUpdatedAt: new Date().toISOString(), riskNotes: [] };
      return {
        runRequest: { ...base, executionBinding },
        store: {
          resolveNativeExecutionGeneration(value) {
            generations.push(value);
            return 1;
          },
        },
        run: { id: "run_fixture" },
        workUnit: { id: "work_fixture" },
        attempt: { id: "attempt_fixture", workUnitId: "work_fixture", runtimeInstanceId: "runtime_fixture",
          fencingToken: "fence_fixture" },
        approvalPolicy: { bash: "ask", allowedWritePaths: [base.cwd] },
        effectivePolicySnapshot: policy,
        signal: new AbortController().signal,
        onEvent,
      };
    },
  });
  return fixture;
}

function createKimiTargetFixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "ling-kimi-target-"));
  const profileStore = new ExecutionEngineProfileStore(resolveUserConfigPaths({ userRootDir: root }));
  const apiKey = options.authentication === "api-key";
  const configuration = {
    engineId: "kimi-acp",
    executablePath: process.execPath,
    authProfileId: "kimi-fixture",
    ...(apiKey ? {
      secretRef: "env:KIMI_FIXTURE_KEY",
      kimi: { providerType: "openai", baseUrl: "https://api.invalid.test/v1", modelId: "customer-model", maxContextSize: 32_000 },
    } : options.region === undefined && Object.hasOwn(options, "region") ? {} : { kimiLoginRegion: "global" }),
  };
  const profile = profileStore.save(configuration, 0);
  const authHome = profileStore.getAuthProfileDirectory(profile);
  mkdirSync(authHome, { recursive: true, mode: 0o700 });
  const probes = [];
  const executions = [];
  const generations = [];
  const secretResolver = {
    status: () => apiKey ? "available" : "missing",
    resolve: (ref) => apiKey
      ? { ref, configured: true, status: "available", value: "fixture-key" }
      : { ref, configured: false, status: "missing" },
  };
  const fixture = {
    probes,
    executions,
    generations,
    profile,
    profileStore,
    secretResolver,
    authHome,
    executeResult: { status: "completed", stopReason: "end_turn", events: [] },
  };
  const dispatcher = createExecutionEngineRunTargetDispatcher({
    getProfileStore: () => profileStore,
    readWorkspaceSettings: () => fixtureNativePolicy("kimi-acp"),
    readAcceptanceEvidence: options.readAcceptanceEvidence ?? fixtureNativeAcceptance,
    secretResolver,
    probeInstallation: async (candidate) => {
      probes.push(candidate);
      return { profileId: candidate.id, profileRevision: candidate.revision,
        configurationFingerprint: candidate.configurationFingerprint, checkedAt: new Date().toISOString(),
        status: "installed", authentication: "not_checked", connection: "not_checked",
        runtimeVersion: "2026.9.11", executableDigest: "c".repeat(64), ...options.probePatch };
    },
    executeKimi: async (input) => {
      executions.push(input);
      await fixture.onExecute?.(input);
      return fixture.executeResult;
    },
  });
  t.after(() => {
    profileStore.close();
    rmSync(root, { recursive: true, force: true });
  });
  Object.assign(fixture, {
    dispatcher,
    input({ binding = {}, effectivePolicySnapshot, onEvent = () => {} } = {}) {
      const executionBinding = { kind: "native_profile", engineId: "kimi-acp",
        profileId: profile.id, profileRevision: profile.revision, ...binding };
      const policy = effectivePolicySnapshot ?? { mode: "workspace_write", workspaceAccessMode: "workspace_write",
        conversationMode: "default", toolDecisions: {}, allowedWritePaths: [base.cwd],
        workspacePolicyUpdatedAt: new Date().toISOString(), riskNotes: [] };
      return {
        runRequest: { ...base, executionBinding },
        store: {
          resolveNativeExecutionGeneration(value) {
            generations.push(value);
            return 1;
          },
        },
        run: { id: "run_fixture" },
        workUnit: { id: "work_fixture" },
        attempt: { id: "attempt_fixture", workUnitId: "work_fixture", runtimeInstanceId: "runtime_fixture",
          fencingToken: "fence_fixture" },
        approvalPolicy: { bash: "ask", allowedWritePaths: [base.cwd] },
        effectivePolicySnapshot: policy,
        signal: new AbortController().signal,
        onEvent,
      };
    },
  });
  return fixture;
}


test("concurrent native first requests create one turn and one execution after admission", async (t) => {
  let entered = 0, release, ready;
  const held = new Promise(resolve => { release = resolve; });
  const bothEntered = new Promise(resolve => { ready = resolve; });
  let executions = 0;
  const fixture = createNativeWorkflowFixture(t, {
    async assertAvailable() { if (++entered === 2) ready(); await held; },
    async dispatch() { executions++; return { status: "completed", events: [] }; },
    release() { release(); },
  });
  const request = nativeWorkflowRequest(fixture.cwd, { id: "concurrent-first", title: "Concurrent", prompt: "Once" }, { idempotencyKey: "concurrent-first" });
  const one = createRecordingSink(), two = createRecordingSink();
  const first = fixture.dispatcher.dispatch({ runRequest: request, sink: one.sink, executionOptions: {} });
  const second = fixture.dispatcher.dispatch({ runRequest: request, sink: two.sink, executionOptions: {} });
  await bothEntered;
  release();
  const results = await Promise.all([first, second]);
  assert.ok(results[0], JSON.stringify([one.state.errors, two.state.errors]));
  assert.equal(results[0], results[1]);
  assert.equal(executions, 1);
  const run = fixture.store.getRun(results[0]);
  assert.equal(fixture.store.listLingTurns({ threadId: run.threadId, limit: 100 }).length, 1);
});

for (const engineId of ["codex-app-server", "openclaw-acp"]) {
  for (const tools of [[], ["read", "grep", "find", "ls"], ["bash"]]) {
    test(`${engineId} rejects a tool subset before resolving native authority: ${tools.join(",")}`, async () => {
      let profiles = 0, probes = 0, executions = 0;
      const dispatcher = createExecutionEngineRunTargetDispatcher({
        getProfileStore() { profiles++; throw new Error("must reject before profile access"); },
        probeInstallation() { probes++; throw new Error("must not probe"); },
        executeCodex() { executions++; throw new Error("must not execute"); },
        executeOpenClaw() { executions++; throw new Error("must not execute"); },
      });
      const input = { runRequest: { ...base, tools, executionBinding: { ...native, engineId,
        ...(engineId === "openclaw-acp" ? { nativeModelId: undefined } : {}) } } };
      await assert.rejects(dispatcher.assertAvailable(input), { code: "native_execution_tools_unsupported" });
      await assert.rejects(dispatcher.dispatch(input), { code: "native_execution_tools_unsupported" });
      assert.deepEqual([profiles, probes, executions], [0, 0, 0]);
    });
  }
}

for (const create of [createCodexTargetFixture, createOpenClawTargetFixture]) {
  test(`${create.name} preserves the ordinary conversation tool set`, async t => {
    const fixture = create(t), input = fixture.input();
    input.runRequest.tools = ["read", "grep", "find", "ls", "bash", "edit", "write"];
    await fixture.dispatcher.dispatch(input);
    assert.equal(fixture.executions.length, 1);
  });
}

test("Kimi request tools are snapshotted before an asynchronous admission and bind the execution identity", async t => {
  const fixture = createKimiTargetFixture(t), input = fixture.input();
  input.runRequest.tools = ["read", "grep", "find", "ls"];
  const pending = fixture.dispatcher.dispatch(input);
  input.runRequest.tools.push("bash");
  await pending;
  const execution = fixture.executions[0];
  assert.deepEqual(execution.configuration.allowedTools, ["read", "grep", "find", "ls"]);
  assert.notEqual(execution.reservation.selection.configurationFingerprint,
    acpConfigurationFingerprint({ engineId: "kimi-acp", expectedVersion: execution.process.expectedVersion },
      { ...execution.configuration, allowedTools: [...execution.configuration.allowedTools, "bash"] }));
});

for (const engineId of ["kimi-acp", "openclaw-acp"]) {
  for (const patch of [{ systemPrompt: "CUSTOM_SYSTEM_ONLY" }, { appendSystemPrompt: ["CUSTOM_APPEND_ONLY"] }]) {
    test(`${engineId} rejects unsupported system instructions before profile access (${Object.keys(patch)[0]})`, async () => {
      const dispatcher = createExecutionEngineRunTargetDispatcher({
        getProfileStore() { assert.fail("unsupported system instructions cannot access a profile"); },
      });
      const input = { runRequest: { ...base, ...patch, executionBinding: { ...native, engineId, nativeModelId: undefined } } };
      await assert.rejects(dispatcher.assertAvailable(input), { code: "native_execution_system_instructions_unsupported" });
      await assert.rejects(dispatcher.dispatch(input), { code: "native_execution_system_instructions_unsupported" });
    });
  }
}

test("Codex preserves separate native base and developer instructions without promoting task text", async t => {
  const fixture = createCodexTargetFixture(t), input = fixture.input();
  input.runRequest.systemPrompt = "CUSTOM_SYSTEM_ONLY";
  input.runRequest.appendSystemPrompt = ["FIRST_APPEND", "SECOND_APPEND"];
  await fixture.dispatcher.dispatch(input);
  const execution = fixture.executions[0];
  assert.equal(execution.configuration.baseInstructions, "CUSTOM_SYSTEM_ONLY");
  assert.equal(execution.configuration.developerInstructions, "FIRST_APPEND\n\nSECOND_APPEND");
  assert.equal(execution.input.input[0].text, base.task.prompt);
  assert.doesNotMatch(JSON.stringify(execution.input), /CUSTOM_SYSTEM_ONLY|FIRST_APPEND|SECOND_APPEND/);
});

for (const create of [createKimiTargetFixture, createOpenClawTargetFixture]) {
  test(`${create.name} sends typed response preferences as a separate user-level content block`, async t => {
    const fixture = create(t), input = fixture.input();
    input.runRequest.lingConversationTone = "friendly";
    input.runRequest.responseLanguage = "zh-CN";
    await fixture.dispatcher.dispatch(input);
    const blocks = fixture.executions[0].input;
    assert.equal(blocks.length, 2);
    assert.match(blocks[0].text, /^Ling response preferences \(user-level\):/);
    assert.match(blocks[0].text, /friendly/);
    assert.match(blocks[0].text, /Chinese|中文/);
    assert.equal(blocks[1].text, base.task.prompt);
  });
}

for (const create of [createKimiTargetFixture, createOpenClawTargetFixture]) {
  test(`${create.name} keeps follow_user distinct from the previous resolved language`, async t => {
    const fixture = create(t), input = fixture.input();
    input.runRequest.responseLanguage = "zh-CN";
    input.runRequest.nativeResponsePreferences = { tone: "friendly", language: "follow_user" };
    input.runRequest.task = { ...input.runRequest.task, prompt: "Please continue in the current language" };
    await fixture.dispatcher.dispatch(input);
    const blocks = fixture.executions[0].input;
    assert.match(blocks[0].text, /most recent user message/);
    assert.equal(blocks[1].text, input.runRequest.task.prompt);
  });
}
