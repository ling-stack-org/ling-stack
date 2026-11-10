import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { DEFAULT_WORKSPACE_ID, createSqliteRunStore, resolveStoragePaths } from "@ling-stack/core";
import { createDaemonServer } from "../dist/index.js";
import { ControlPlaneEventHub } from "../dist/features/control-plane/events.js";
import { ProviderImportPreflightService } from "../dist/features/providers/import-preflight.js";
import { ProviderStartupRefreshService, refreshProvidersOnStartup } from "../dist/features/providers/startup-refresh.js";
import { StartupStateRegistry } from "../dist/startup/state.js";

const fixedNow = "2026-10-09T00:00:00.000Z";
const testOptions = { timeout: 15_000 };

test("provider startup publication rejects an edited configuration whose old and new lastCheck are absent", testOptions, async (t) => {
  const fixture = await createFixture(t);
  try {
    const startup = fixture.track(refreshProvidersOnStartup(fixture.startupInput));
    await fixture.arrived(0);
    fixture.store.updateProviderPreset(fixture.provider.id, { model: "replacement-model" }, fixedNow);
    const before = fixture.state();
    fixture.release(0, "success");
    assert.deepEqual(await startup, []);
    assert.deepEqual(fixture.state(), before, "old startup success must not be attributed to the replacement configuration");
    assert.equal(fixture.broadcasts.length, 0);
  } finally {
    await fixture.close();
  }
});

test("provider startup cannot publish while a later manual check is still in flight", testOptions, async (t) => {
  const fixture = await createFixture(t);
  try {
    const startup = fixture.track(refreshProvidersOnStartup(fixture.startupInput));
    await fixture.arrived(0);
    const manual = fixture.manual();
    await fixture.arrived(1);
    fixture.release(0, "success");
    await startup;
    assert.equal(fixture.store.getProviderPreset(fixture.provider.id).lastCheck, undefined,
      "latest-admitted-wins is checked before the later request finishes");
    assert.equal(fixture.events().length, 0);
    assert.equal(fixture.broadcasts.length, 0);
    fixture.release(1, "empty");
    const current = await manual;
    assert.equal(current.status, 200);
    assert.equal(current.body.code, "empty_response");
    assert.equal(fixture.events().length, 1);
  } finally {
    await fixture.close();
  }
});

test("provider startup phase preserves current failed readiness when its own result is superseded by a manual check", testOptions, async (t) => {
  const fixture = await createFixture(t);
  const startupState = new StartupStateRegistry();
  const service = new ProviderStartupRefreshService({ ...fixture.dependencies, startupState });
  try {
    const startup = fixture.track(service.start(fixture.cwd, fixture.store));
    await fixture.arrived(0);
    const manual = fixture.manual();
    await fixture.arrived(1);
    fixture.release(1, "empty");
    const current = await manual;
    assert.equal(current.status, 200);
    assert.equal(current.body.ok, false);
    assert.equal(current.body.code, "empty_response");
    const currentProvider = fixture.store.getProviderPreset(fixture.provider.id);
    assert.equal(currentProvider.lastCheck.ok, false);
    fixture.release(0, "success");
    assert.deepEqual(await startup, [], "superseded startup result must not be returned as published evidence");
    assert.deepEqual(fixture.store.getProviderPreset(fixture.provider.id), currentProvider);
    assert.equal(fixture.events().length, 1);
    assert.equal(fixture.broadcasts.length, 0);
    assert.equal(startupState.snapshot(fixture.cwd).phases.provider_warmup, "degraded",
      "completion of a discarded startup check cannot hide the current provider's committed failure");
  } finally {
    await fixture.close();
  }
});

test("provider startup phase uses the current ready configuration rather than an earlier published failure", testOptions, async (t) => {
  const fixture = await createFixture(t);
  const startupState = new StartupStateRegistry();
  const service = new ProviderStartupRefreshService({ ...fixture.dependencies, startupState });
  try {
    fixture.createAdditionalProvider();
    const startup = fixture.track(service.start(fixture.cwd, fixture.store));
    await fixture.arrived(0);
    fixture.release(0, "empty");
    await fixture.arrived(1);
    assert.equal(fixture.store.getProviderPreset(fixture.provider.id).lastCheck.ok, false);
    fixture.store.updateProviderPreset(fixture.provider.id, { model: "ready-replacement-model" }, fixedNow);
    const manual = fixture.manual();
    const request = await fixture.arrived(2);
    assert.equal(request.model, "ready-replacement-model");
    fixture.release(2, "success");
    assert.equal((await manual).body.ok, true);
    fixture.release(1, "success");
    const startupResults = await startup;
    assert.equal(startupResults[0].ok, false, "the old failed check remains a truthful historical publication receipt");
    assert.equal(fixture.store.getProviderPreset(fixture.provider.id).lastCheck.ok, true);
    assert.equal(startupState.snapshot(fixture.cwd).phases.provider_warmup, "ready",
      "historical failure of configuration A must not downgrade currently checked configuration B");
  } finally {
    await fixture.close();
  }
});

test("provider startup latest unexpected diagnostics never expose thrown secret or path markers", testOptions, async (t) => {
  const fixture = await createFixture(t);
  const startupState = new StartupStateRegistry();
  const service = new ProviderStartupRefreshService({ ...fixture.dependencies, startupState });
  const failingStore = proxyStore(fixture.store, { listProviderPresets() {
    throw new Error("private-provider-secret-marker at /private/private-provider-path-marker");
  } });
  try {
    assert.deepEqual(await service.start(fixture.cwd, failingStore), []);
    const current = startupState.snapshot(fixture.cwd);
    assert.equal(current.phases.provider_warmup, "degraded");
    const diagnostic = current.diagnostics.find(item => item.code === "provider_startup_refresh_failed");
    assert.ok(diagnostic);
    assert.doesNotMatch(JSON.stringify(current), /private-provider-secret-marker|private-provider-path-marker/,
      "unexpected errors are untrusted text, not public startup diagnostics");
    assert.equal(diagnostic.message, "Provider startup refresh failed unexpectedly. Run Check again from Model Workbench.");
    assert.equal(fixture.requestCount(), 0);
  } finally {
    await fixture.close();
  }
});

test("provider startup phase does not classify a current pending import check as a terminal failure", testOptions, async (t) => {
  const fixture = await createFixture(t);
  const startupState = new StartupStateRegistry();
  const service = new ProviderStartupRefreshService({ ...fixture.dependencies, startupState });
  try {
    fixture.store.recordProviderCheckResult(fixture.provider.id, {
      ok: false, code: "checking", message: "Provider check is running.", checkedAt: fixedNow,
    });
    const startup = fixture.track(service.start(fixture.cwd, fixture.store));
    await fixture.arrived(0);
    const manual = fixture.manual();
    await fixture.arrived(1);
    fixture.release(0, "success");
    assert.deepEqual(await startup, []);
    assert.equal(fixture.store.getProviderPreset(fixture.provider.id).lastCheck.code, "checking");
    const current = startupState.snapshot(fixture.cwd);
    assert.equal(current.phases.provider_warmup, "ready", "unknown checking status is not evidence of a failed provider");
    assert.equal(current.diagnostics.some(item => item.code === "provider_startup_check_failed"), false);
    fixture.release(1, "success");
    await manual;
  } finally {
    await fixture.close();
  }
});

test("provider startup older forced refresh exception cannot overwrite the newer phase or diagnostics", testOptions, async (t) => {
  const fixture = await createFixture(t);
  const startupState = new StartupStateRegistry();
  const service = new ProviderStartupRefreshService({ ...fixture.dependencies, startupState });
  let failOldStore = false;
  const oldStore = proxyStore(fixture.store, {
    getProviderPreset(...args) {
      if (failOldStore) throw new Error("isolated old refresh storage failure");
      return fixture.store.getProviderPreset(...args);
    },
    commitProviderCheckResult(...args) {
      if (failOldStore) throw new Error("isolated old refresh storage failure");
      return fixture.store.commitProviderCheckResult(...args);
    },
  });
  try {
    const oldRefresh = fixture.track(service.start(fixture.cwd, oldStore, { force: true }));
    await fixture.arrived(0);
    const newerStore = proxyStore(fixture.store, { listProviderPresets: () => [] });
    await service.start(fixture.cwd, newerStore, { force: true });
    const current = startupState.snapshot(fixture.cwd);
    assert.equal(current.phases.provider_warmup, "ready");
    failOldStore = true;
    fixture.release(0, "success");
    await oldRefresh;
    assert.deepEqual(startupState.snapshot(fixture.cwd), current,
      "a superseded refresh catch must not publish phase or diagnostic changes");
  } finally {
    await fixture.close();
  }
});

test("provider startup joining a completed refresh does not replay warming or terminal diagnostics", testOptions, async (t) => {
  const fixture = await createFixture(t);
  const startupState = new StartupStateRegistry();
  const service = new ProviderStartupRefreshService({ ...fixture.dependencies, startupState });
  try {
    const refresh = fixture.track(service.start(fixture.cwd, fixture.store));
    await fixture.arrived(0);
    fixture.release(0, "empty");
    await refresh;
    const current = startupState.snapshot(fixture.cwd);
    const joined = service.start(fixture.cwd, fixture.store);
    assert.equal(joined, refresh);
    assert.deepEqual(startupState.snapshot(fixture.cwd), current, "joining is observation, not another phase transition");
    await joined;
    assert.deepEqual(startupState.snapshot(fixture.cwd), current, "joining must not count the same failure twice");
  } finally {
    await fixture.close();
  }
});

test("provider startup older forced refresh completion cannot replay an already accumulated failure", testOptions, async (t) => {
  const fixture = await createFixture(t);
  const startupState = new StartupStateRegistry();
  const service = new ProviderStartupRefreshService({ ...fixture.dependencies, startupState });
  try {
    fixture.createAdditionalProvider();
    const oldRefresh = fixture.track(service.start(fixture.cwd, fixture.store, { force: true }));
    await fixture.arrived(0);
    fixture.release(0, "empty");
    await fixture.arrived(1);
    const newerRefresh = fixture.track(service.start(fixture.cwd, fixture.store, { force: true }));
    await fixture.arrived(2);
    fixture.release(2, "success");
    await fixture.arrived(3);
    fixture.release(3, "success");
    await newerRefresh;
    const current = startupState.snapshot(fixture.cwd);
    assert.equal(current.phases.provider_warmup, "ready");
    fixture.release(1, "success");
    const oldResults = await oldRefresh;
    assert.equal(oldResults[0].ok, false, "the old refresh really had an earlier committed failure");
    assert.deepEqual(startupState.snapshot(fixture.cwd), current,
      "superseded successful completion cannot downgrade the newest startup phase");
  } finally {
    await fixture.close();
  }
});

test("provider startup superseded forced refresh cannot admit its remaining candidates", testOptions, async (t) => {
  const fixture = await createFixture(t);
  const service = new ProviderStartupRefreshService(fixture.dependencies);
  try {
    const second = fixture.createAdditionalProvider();
    const oldRefresh = fixture.track(service.start(fixture.cwd, fixture.store, { force: true }));
    await fixture.arrived(0);
    const newerRefresh = fixture.track(service.start(fixture.cwd, fixture.store, { force: true }));
    await fixture.arrived(1);
    fixture.release(1, "success");
    await fixture.arrived(2);
    fixture.release(2, "empty");
    await newerRefresh;
    const currentSecond = fixture.store.getProviderPreset(second.id);
    assert.equal(currentSecond.lastCheck.code, "empty_response");
    fixture.release(3, "success"); // A regression must fail, not hang on its unwanted fourth request.
    fixture.release(0, "success");
    await oldRefresh;
    assert.equal(fixture.requestCount(), 3, "an old workspace refresh cannot supersede new provider checks later in its loop");
    assert.deepEqual(fixture.store.getProviderPreset(second.id), currentSecond);
  } finally {
    await fixture.close();
  }
});

test("provider startup uses the admission snapshot when a later candidate changes during an earlier request", testOptions, async (t) => {
  const fixture = await createFixture(t);
  try {
    const second = fixture.createAdditionalProvider();
    const startup = fixture.track(refreshProvidersOnStartup(fixture.startupInput));
    await fixture.arrived(0);
    fixture.store.updateProviderPreset(second.id, { model: "new-admission-model" }, fixedNow);
    fixture.release(0, "success");
    const request = await fixture.arrived(1);
    assert.equal(request.model, "new-admission-model", "a new ticket cannot legitimize a probe of the old list snapshot");
    fixture.release(1, "success");
    assert.equal((await startup).length, 2);
    assert.equal(fixture.store.getProviderPreset(second.id).lastCheck.ok, true);
  } finally {
    await fixture.close();
  }
});

test("provider import result cannot publish ahead of a later manual admission in the same millisecond", testOptions, async (t) => {
  const fixture = await createFixture(t);
  const service = new ProviderImportPreflightService(fixture.dependencies);
  const restoreDate = freezeDate();
  try {
    service.enqueue(fixture.cwd, fixture.backgroundStore, fixture.provider);
    await fixture.arrived(0);
    const manual = fixture.manual();
    await fixture.arrived(1);
    fixture.release(0, "success");
    await fixture.backgroundAttempted(0);
    assert.equal(fixture.store.getProviderPreset(fixture.provider.id).lastCheck.code, "checking");
    assert.equal(fixture.events().length, 0, "the older import must not append a stale check event");
    fixture.release(1, "empty");
    assert.equal((await manual).body.code, "empty_response");
    assert.equal(fixture.events().length, 1);
  } finally {
    restoreDate();
    fixture.releaseAll();
    await service.shutdown();
    await fixture.close();
  }
});

test("provider manual result cannot replace a later import admission in the same millisecond", testOptions, async (t) => {
  const fixture = await createFixture(t);
  const service = new ProviderImportPreflightService(fixture.dependencies);
  const restoreDate = freezeDate();
  try {
    const manual = fixture.manual();
    await fixture.arrived(0);
    service.enqueue(fixture.cwd, fixture.backgroundStore, fixture.provider);
    await fixture.arrived(1);
    fixture.release(0, "empty");
    const stale = await manual;
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error, "provider_check_result_superseded");
    assert.equal(stale.body.reason, "superseded");
    assert.equal(fixture.store.getProviderPreset(fixture.provider.id).lastCheck.code, "checking");
    assert.equal(fixture.events().length, 0);
    fixture.release(1, "success");
    await fixture.backgroundAttempted(0);
    assert.equal(fixture.store.getProviderPreset(fixture.provider.id).lastCheck.ok, true);
    assert.equal(fixture.events().length, 1);
    assert.equal(fixture.events()[0].data.source, "model_import");
  } finally {
    restoreDate();
    fixture.releaseAll();
    await service.shutdown();
    await fixture.close();
  }
});

test("provider import shutdown drains in-flight checks without publishing a cancelled result", testOptions, async (t) => {
  const fixture = await createFixture(t);
  const service = new ProviderImportPreflightService(fixture.dependencies);
  try {
    const pending = service.enqueue(fixture.cwd, fixture.backgroundStore, fixture.provider);
    await fixture.arrived(0);
    await service.shutdown();
    fixture.release(0, "success");
    assert.deepEqual(fixture.store.getProviderPreset(fixture.provider.id), pending);
    assert.equal(fixture.events().length, 0);
    assert.equal(fixture.broadcasts.length, 0);
  } finally {
    fixture.releaseAll();
    await service.shutdown();
    await fixture.close();
  }
});

test("provider import publication failure drains safely without leaking the thrown message", testOptions, async (t) => {
  const fixture = await createFixture(t);
  const attempted = deferred();
  const warnings = [];
  const originalWarn = console.warn;
  const failingStore = proxyStore(fixture.store, { commitProviderCheckResult() {
    attempted.resolve();
    throw new Error("private-fixture-secret-storage-error");
  } });
  const service = new ProviderImportPreflightService(fixture.dependencies);
  try {
    console.warn = (...args) => warnings.push(args.join(" "));
    service.enqueue(fixture.cwd, failingStore, fixture.provider);
    await fixture.arrived(0);
    fixture.release(0, "success");
    await abortable(attempted.promise, t.signal);
    await service.shutdown();
    assert.deepEqual(warnings, ["Provider background check publication failed. Run Check again from Model Workbench."]);
    assert.equal(fixture.store.getProviderPreset(fixture.provider.id).lastCheck.code, "checking");
    assert.equal(fixture.events().length, 0);
    assert.equal(fixture.broadcasts.length, 0);
  } finally {
    console.warn = originalWarn;
    fixture.releaseAll();
    await service.shutdown();
    await fixture.close();
  }
});

async function createFixture(t) {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-provider-background-publication-"));
  const gates = Array.from({ length: 5 }, () => ({ arrived: deferred(), released: deferred() }));
  const attempts = Array.from({ length: 3 }, deferred);
  const tracked = [];
  let requestIndex = 0;
  let attemptIndex = 0;
  const modelServer = createServer(async (request, response) => {
    const index = requestIndex++;
    const gate = gates[index];
    if (!gate) {
      response.writeHead(500, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "unexpected extra fixture request" }));
      return;
    }
    try {
      let body = "";
      for await (const chunk of request) body += chunk;
      gate.arrived.resolve(JSON.parse(body));
      const result = await gate.released.promise;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: result === "empty" ? "" : `background-result-${index}` } }] }));
    } catch (error) {
      gate.arrived.reject(error);
      response.destroy();
    }
  });
  await new Promise((resolveListen) => modelServer.listen(0, "127.0.0.1", resolveListen));
  const address = modelServer.address();
  assert.ok(address && typeof address === "object");
  const secretResolver = {
    status: (ref) => ({ ref, kind: "env", configured: false, errorCode: "secret_missing" }),
    resolve: (ref) => ({ ref, configured: false }),
  };
  let store;
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd }, {
    secretResolver,
    externalSecretStore: {
      ...secretResolver,
      setSecret: (ref) => secretResolver.status(ref),
      deleteSecret: (ref) => secretResolver.status(ref),
    },
    storeFactory(requestedCwd) {
      assert.equal(requestedCwd, cwd, "test must not open any other workspace");
      store ??= createSqliteRunStore(cwd, resolveStoragePaths(cwd, {
        userRootDir: resolve(cwd, "fixture-home"), workspaceStateLocation: "user-data-dir", env: {},
      }).workspace);
      return store;
    },
  });
  const broadcasts = [];
  const controlPlaneEvents = new ControlPlaneEventHub();
  const publish = controlPlaneEvents.publish.bind(controlPlaneEvents);
  controlPlaneEvents.publish = (event) => {
    broadcasts.push(event);
    return publish(event);
  };
  function track(promise) {
    tracked.push(promise);
    void promise.catch(() => {});
    return promise;
  }
  function releaseAll() {
    for (const gate of gates) gate.released.resolve("success");
  }
  async function close() {
    releaseAll();
    await Promise.allSettled(tracked);
    await daemon.stop();
    await new Promise((resolveClose, rejectClose) => {
      modelServer.close((error) => error ? rejectClose(error) : resolveClose());
      modelServer.closeAllConnections();
    });
    await rm(cwd, { recursive: true, force: true });
  }
  try {
    await daemon.start();
    const daemonAddress = daemon.server.address();
    assert.ok(daemonAddress && typeof daemonAddress === "object");
    const provider = store.createProviderPreset({
      kind: "openai-compatible", displayName: "Background authority fixture", providerId: "background-authority",
      model: "background-model", api: "openai-completions", baseUrl: `http://127.0.0.1:${address.port}`,
      authHeader: false, capabilities: ["chat"], enabled: true,
    }, fixedNow);
    const baselineSeq = store.getLatestControlPlaneEventSeq(DEFAULT_WORKSPACE_ID);
    const events = () => store.listControlPlaneEvents({ workspaceId: DEFAULT_WORKSPACE_ID, afterSeq: baselineSeq,
      domains: ["providers"], entityId: provider.id }).filter(event => event.action === "provider.preflight_checked");
    const backgroundStore = proxyStore(store, {
      recordProviderCheckResult(...args) {
        const result = store.recordProviderCheckResult(...args);
        if (args[1].code !== "checking") attempts[attemptIndex++].resolve();
        return result;
      },
      commitProviderCheckResult(...args) {
        const result = store.commitProviderCheckResult(...args);
        attempts[attemptIndex++].resolve();
        return result;
      },
    });
    return {
      cwd, store, provider, backgroundStore, events, broadcasts, track, close, releaseAll,
      dependencies: { secretResolver, controlPlaneEvents },
      startupInput: { cwd, store, secretResolver, controlPlaneEvents },
      arrived: (index) => abortable(gates[index].arrived.promise, t.signal),
      release: (index, result) => gates[index].released.resolve(result),
      backgroundAttempted: (index) => abortable(attempts[index].promise, t.signal),
      state: () => ({ provider: store.getProviderPreset(provider.id), events: events() }),
      requestCount: () => requestIndex,
      createAdditionalProvider: () => store.createProviderPreset({
        kind: "openai-compatible", displayName: "Second background authority fixture", providerId: "second-background-authority",
        model: "second-background-model", api: "openai-completions", baseUrl: `http://127.0.0.1:${address.port}`,
        authHeader: false, capabilities: ["chat"], enabled: true,
      }, "2026-10-08T23:59:00.000Z"),
      manual: () => track(fetch(`http://127.0.0.1:${daemonAddress.port}/providers/${provider.id}/check?cwd=${encodeURIComponent(cwd)}`,
        { method: "POST", signal: t.signal }).then(async response => ({ status: response.status, body: await response.json() }))),
    };
  } catch (error) {
    await close();
    throw error;
  }
}

function proxyStore(store, overrides) {
  return new Proxy(store, { get(target, property) {
    if (Object.hasOwn(overrides, property)) return overrides[property];
    const value = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}

function deferred() {
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject; });
  void promise.catch(() => {});
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function abortable(promise, signal) {
  return new Promise((resolvePromise, rejectPromise) => {
    const abort = () => rejectPromise(signal.reason ?? new Error("fixture aborted before gate opened"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(value => { signal.removeEventListener("abort", abort); resolvePromise(value); }, error => {
      signal.removeEventListener("abort", abort); rejectPromise(error);
    });
    if (signal.aborted) abort();
  });
}

function freezeDate() {
  const OriginalDate = globalThis.Date;
  globalThis.Date = class extends OriginalDate {
    constructor(...args) { super(...(args.length === 0 ? [fixedNow] : args)); }
    static now() { return OriginalDate.parse(fixedNow); }
  };
  return () => { globalThis.Date = OriginalDate; };
}
