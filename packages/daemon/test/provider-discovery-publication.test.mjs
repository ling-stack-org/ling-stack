import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { after, test } from "node:test";
import { createCompositeSecretResolver, createSqliteRunStore, resolveStoragePaths } from "@ling-stack/core";

// Daemon bootstrap has process-level storage consumers outside storeFactory. Keep
// those consumers, every fixture database, and every secret resolver isolated.
const processRoot = await mkdtemp(resolve(tmpdir(), "ling-provider-discovery-process-"));
const priorHome = process.env.LING_STACK_HOME;
const priorDefaultCwd = process.env.LING_STACK_DEFAULT_WORKSPACE_CWD;
process.env.LING_STACK_HOME = resolve(processRoot, "home");
process.env.LING_STACK_DEFAULT_WORKSPACE_CWD = resolve(processRoot, "default-workspace");
await mkdir(process.env.LING_STACK_HOME, { recursive: true });
await mkdir(process.env.LING_STACK_DEFAULT_WORKSPACE_CWD, { recursive: true });
const { createDaemonServer } = await import("../dist/index.js");
after(async () => {
  restoreEnvironment("LING_STACK_HOME", priorHome);
  restoreEnvironment("LING_STACK_DEFAULT_WORKSPACE_CWD", priorDefaultCwd);
  await rm(processRoot, { recursive: true, force: true });
});

const testOptions = { timeout: 20_000 };
const frozenTime = "2026-10-09T01:02:03.456Z";
const fixtureSecret = "fixture-local-discovery-secret";
const explicitRequestKey = "fixture-test-explicit-request-key";
const upstreamModelId = "fixture-stale-discovery-model";

test("saved discovery publishes an unchanged connection without consuming check authority", testOptions, async (t) => {
  const fixture = await createFixture(t);
  try {
    const before = fixture.authority();
    const pending = fixture.discover();
    const request = await fixture.waitForRequest();
    assert.equal(request.headers.authorization, `Bearer ${fixtureSecret}`);
    fixture.release();
    const response = await pending;
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.models.map((model) => model.id), [upstreamModelId]);
    assert.deepEqual(fixture.authority(), before);
    assert.doesNotMatch(JSON.stringify(response), new RegExp(fixtureSecret));
  } finally {
    await fixture.close();
  }
});

test("saved discovery is not superseded by an unrelated admitted Provider check", testOptions, async (t) => {
  const fixture = await createFixture(t);
  try {
    const before = fixture.authority();
    const pending = fixture.discover();
    await fixture.waitForRequest();
    const check = fixture.store.beginProviderCheckRequest(fixture.provider.id, "manual");
    assert.ok(check);
    assert.equal(check.ticket.configRevision, before.configRevision);
    assert.equal(fixture.authority().requestRevision, before.requestRevision + 1);
    fixture.release();
    const response = await pending;
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.models.map((model) => model.id), [upstreamModelId]);
    assert.equal(fixture.authority().requestRevision, check.ticket.requestRevision);
    assert.equal(fixture.authority().publishedRevision, before.publishedRevision);
  } finally {
    await fixture.close();
  }
});

test("saved discovery rejects a late list after a same-millisecond connection update", testOptions, async (t) => {
  const fixture = await createFixture(t);
  try {
    const pending = fixture.discover();
    await fixture.waitForRequest();
    fixture.store.updateProviderPreset(fixture.provider.id, { baseUrl: `${fixture.modelUrl}/replacement` }, frozenTime);
    assert.equal(fixture.store.getProviderPreset(fixture.provider.id).updatedAt, frozenTime);
    assert.ok(fixture.authority().configRevision > fixture.initialAuthority.configRevision);
    fixture.release();
    assertConnectionChanged(await pending);
  } finally {
    await fixture.close();
  }
});

test("saved discovery rejects config A-to-B-to-A even when the current connection and timestamp match", testOptions, async (t) => {
  const fixture = await createFixture(t);
  try {
    const pending = fixture.discover();
    await fixture.waitForRequest();
    fixture.store.updateProviderPreset(fixture.provider.id, { headers: { "x-fixture-tenant": "replacement" } }, frozenTime);
    fixture.store.updateProviderPreset(fixture.provider.id, { headers: fixture.provider.headers }, frozenTime);
    assert.deepEqual(fixture.store.getProviderPreset(fixture.provider.id), fixture.provider);
    assert.ok(fixture.authority().configRevision > fixture.initialAuthority.configRevision);
    fixture.release();
    assertConnectionChanged(await pending);
  } finally {
    await fixture.close();
  }
});

test("saved discovery rejects a late list after Provider deletion", testOptions, async (t) => {
  const fixture = await createFixture(t);
  try {
    const pending = fixture.discover();
    await fixture.waitForRequest();
    assert.equal(fixture.store.deleteProviderPreset(fixture.provider.id), true);
    assert.equal(fixture.authority(), undefined);
    fixture.release();
    assertConnectionChanged(await pending);
  } finally {
    await fixture.close();
  }
});

test("saved discovery rejects delete/recreate of the same Provider ID and identical local connection", testOptions, async (t) => {
  const fixture = await createFixture(t);
  try {
    const pending = fixture.discover();
    await fixture.waitForRequest();
    const row = fixture.store.database.prepare("SELECT * FROM provider_presets WHERE id=?").get(fixture.provider.id);
    assert.equal(fixture.store.deleteProviderPreset(fixture.provider.id), true);
    const columns = Object.keys(row);
    fixture.store.database.prepare(`INSERT INTO provider_presets (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`)
      .run(...columns.map((column) => row[column]));
    fixture.store.setProviderSecret(fixture.provider.id, fixtureSecret, frozenTime);
    assert.deepEqual(fixture.store.getProviderPreset(fixture.provider.id), fixture.provider);
    assert.ok(fixture.authority().configRevision > fixture.initialAuthority.configRevision);
    fixture.release();
    assertConnectionChanged(await pending);
  } finally {
    await fixture.close();
  }
});

test("saved discovery rejects a late list after local secret rotation at the same timestamp", testOptions, async (t) => {
  const fixture = await createFixture(t);
  try {
    const pending = fixture.discover();
    await fixture.waitForRequest();
    fixture.store.setProviderSecret(fixture.provider.id, "fixture-rotated-local-secret", frozenTime);
    assert.ok(fixture.authority().configRevision > fixture.initialAuthority.configRevision);
    assert.equal(fixture.store.getProviderPreset(fixture.provider.id).updatedAt, frozenTime);
    fixture.release();
    assertConnectionChanged(await pending);
  } finally {
    await fixture.close();
  }
});

test("saved discovery rejects a late list after local secret deletion", testOptions, async (t) => {
  const fixture = await createFixture(t);
  try {
    const pending = fixture.discover();
    await fixture.waitForRequest();
    assert.equal(fixture.store.deleteProviderSecret(fixture.provider.id), true);
    assert.ok(fixture.authority().configRevision > fixture.initialAuthority.configRevision);
    fixture.release();
    assertConnectionChanged(await pending);
  } finally {
    await fixture.close();
  }
});

for (const mode of ["success", "http-fallback", "network-fallback"]) {
  test(`saved media discovery rejects stale ${mode} publication`, testOptions, async (t) => {
    const fixture = await createFixture(t, { media: true });
    try {
      const pending = fixture.discover();
      await fixture.waitForRequest();
      fixture.store.updateProviderPreset(fixture.provider.id, { baseUrl: `${fixture.modelUrl}/replacement` }, frozenTime);
      fixture.release(mode);
      assertConnectionChanged(await pending);
    } finally {
      await fixture.close();
    }
  });
}

test("review: explicit request key keeps saved identity fenced after configuration changes", testOptions, async (t) => {
  const fixture = await createFixture(t);
  try {
    const pending = fixture.discover({ apiKey: explicitRequestKey, baseUrl: `${fixture.modelUrl}/draft` });
    const request = await fixture.waitForRequest();
    assert.equal(request.headers.authorization, `Bearer ${explicitRequestKey}`);
    fixture.store.updateProviderPreset(fixture.provider.id, { model: "fixture-changed-model" }, frozenTime);
    fixture.release();
    assertConnectionChanged(await pending);
  } finally {
    await fixture.close();
  }
});

test("review: explicit request key permits an unsaved connection when saved identity is still current", testOptions, async (t) => {
  const fixture = await createFixture(t);
  try {
    const pending = fixture.discover({ apiKey: explicitRequestKey, baseUrl: `${fixture.modelUrl}/draft` });
    const request = await fixture.waitForRequest();
    assert.equal(request.url, "/draft/models");
    assert.equal(request.headers.authorization, `Bearer ${explicitRequestKey}`);
    fixture.release();
    const response = await pending;
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.models.map((model) => model.id), [upstreamModelId]);
    assert.doesNotMatch(JSON.stringify(response), new RegExp(explicitRequestKey));
  } finally {
    await fixture.close();
  }
});

test("review: standalone draft discovery never reads saved configuration authority", testOptions, async (t) => {
  const fixture = await createFixture(t);
  try {
    fixture.store.getProviderConfigurationSnapshot = () => {
      assert.fail("Draft discovery must not read saved Provider configuration authority.");
    };
    const pending = fixture.discover({ providerPresetId: undefined, apiKey: "fixture-draft-key" });
    await fixture.waitForRequest();
    fixture.store.updateProviderPreset(fixture.provider.id, { model: "fixture-unrelated-model" }, frozenTime);
    fixture.release();
    const response = await pending;
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.models.map((model) => model.id), [upstreamModelId]);
  } finally {
    await fixture.close();
  }
});

for (const outcome of ["success", "error"]) {
  test(`review: materialization ${outcome} callback mutation blocks network dispatch`, testOptions, async (t) => {
    const fixture = await createFixture(t, {
      externalSecret: true,
      resolverFailure: outcome === "error" ? "fixture-private-resolver-error-detail" : undefined,
      onResolve(store, providerId) {
        store.updateProviderPreset(providerId, { model: "fixture-changed-during-materialization" }, frozenTime);
      },
    });
    try {
      const response = await fixture.discover();
      assertConnectionChanged(response);
      assert.equal(fixture.modelRequests.length, 0, "No old credential may leave after a synchronous configuration mutation.");
      assert.doesNotMatch(JSON.stringify(response), /fixture-private-resolver-error-detail/);
    } finally {
      await fixture.close();
    }
  });
}

test("review: stale upstream error does not escape instead of the configuration fence", testOptions, async (t) => {
  const fixture = await createFixture(t);
  try {
    const pending = fixture.discover();
    await fixture.waitForRequest();
    fixture.store.updateProviderPreset(fixture.provider.id, { model: "fixture-changed-model" }, frozenTime);
    fixture.release("auth-error");
    assertConnectionChanged(await pending);
  } finally {
    await fixture.close();
  }
});

test("review: pagination rejects stale first-page evidence without sending a second request", testOptions, async (t) => {
  const fixture = await createFixture(t, { paginated: true });
  try {
    const pending = fixture.discover();
    await fixture.waitForRequest();
    fixture.store.updateProviderPreset(fixture.provider.id, { model: "fixture-changed-model" }, frozenTime);
    fixture.release();
    assertConnectionChanged(await pending);
    assert.equal(fixture.modelRequests.length, 1);
    assert.equal(fixture.modelRequests[0].url, "/models");
  } finally {
    await fixture.close();
  }
});

test("review: ordinary secret resolver exceptions expose no private details", testOptions, async (t) => {
  const privateDetail = "fixture-private-keychain-account-path-and-secret";
  const fixture = await createFixture(t, { externalSecret: true, resolverFailure: privateDetail });
  try {
    const response = await fixture.discover();
    assert.equal(response.status, 400);
    assert.doesNotMatch(JSON.stringify(response), new RegExp(privateDetail));
    assert.equal(response.body.error, "secret_materialization_failed");
    assert.doesNotMatch(JSON.stringify(response), /fixture-managed-discovery-ref/);
    assert.equal(fixture.modelRequests.length, 0);
  } finally {
    await fixture.close();
  }
});

test("review: resolver status messages are not trusted as public materialization failures", testOptions, async (t) => {
  const privateDetail = "fixture-private-resolver-status-secret-and-account";
  const fixture = await createFixture(t, { externalSecret: true, resolverStatusFailure: privateDetail });
  try {
    const response = await fixture.discover({ secretHeaderRefs: { "x-fixture-token": "keychain:fixture-managed-discovery-ref" } });
    assert.equal(response.status, 400);
    assert.equal(response.body.error, "secret_store_unavailable");
    assert.doesNotMatch(JSON.stringify(response), new RegExp(privateDetail));
    assert.doesNotMatch(JSON.stringify(response), /fixture-managed-discovery-ref/);
    assert.equal(fixture.modelRequests.length, 0);
  } finally {
    await fixture.close();
  }
});

test("review: unknown resolver status error codes cannot expose private details", testOptions, async (t) => {
  const privateDetail = "fixture-private-resolver-status-code-secret";
  const fixture = await createFixture(t, {
    externalSecret: true, resolverStatusFailure: privateDetail, resolverStatusCode: privateDetail,
  });
  try {
    const response = await fixture.discover({ secretHeaderRefs: { "x-fixture-token": "keychain:fixture-managed-discovery-ref" } });
    assert.equal(response.status, 400);
    assert.doesNotMatch(JSON.stringify(response), new RegExp(privateDetail));
    assert.equal(response.body.error, "secret_materialization_failed");
    assert.equal(fixture.modelRequests.length, 0);
  } finally {
    await fixture.close();
  }
});

function assertConnectionChanged(response) {
  assert.equal(response.status, 409);
  assert.equal(response.body.error, "provider_model_connection_changed");
  assert.equal(typeof response.body.message, "string");
  for (const field of ["models", "source", "fetchedAt", "catalog"]) {
    assert.equal(Object.hasOwn(response.body, field), false, `stale response must not publish ${field}`);
  }
  assert.doesNotMatch(JSON.stringify(response), new RegExp(fixtureSecret));
  assert.doesNotMatch(JSON.stringify(response), new RegExp(upstreamModelId));
}

async function createFixture(t, {
  media = false, paginated = false, externalSecret = false, onResolve, resolverFailure, resolverStatusFailure,
  resolverStatusCode = "secret_store_unavailable",
} = {}) {
  const root = await mkdtemp(resolve(processRoot, "case-"));
  const cwd = resolve(root, "workspace");
  await mkdir(cwd, { recursive: true });
  let arrive;
  const requestArrived = new Promise((resolveArrived) => { arrive = resolveArrived; });
  let release;
  const responseReleased = new Promise((resolveReleased) => { release = resolveReleased; });
  const modelRequests = [];
  const modelServer = createServer(async (request, response) => {
    const snapshot = { url: request.url, headers: request.headers };
    modelRequests.push(snapshot);
    arrive(snapshot);
    const mode = await responseReleased;
    if (mode === "network-fallback") {
      response.destroy();
      return;
    }
    response.writeHead(mode === "http-fallback" ? 503 : mode === "auth-error" ? 401 : 200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(mode === "http-fallback" ? { error: "fixture-upstream-unavailable" }
      : mode === "auth-error" ? { error: `Fixture authentication error ${fixtureSecret}` }
      : paginated ? { models: [{ name: `models/${upstreamModelId}`, supportedGenerationMethods: ["generateContent"] }], nextPageToken: "fixture-next" }
      : { data: [{ id: upstreamModelId }] }));
  });
  await new Promise((resolveListen) => modelServer.listen(0, "127.0.0.1", resolveListen));
  const address = modelServer.address();
  assert.ok(address && typeof address === "object");
  const modelUrl = `http://127.0.0.1:${address.port}`;
  let store;
  let provider;
  const externalRef = "keychain:fixture-managed-discovery-ref";
  const fakeKeychain = {
    status(ref) {
      if (externalSecret && ref === externalRef) return { ref, kind: "keychain", configured: true };
      return { ref, kind: "keychain", configured: false, errorCode: "secret_missing", message: "Isolated fixture has no Keychain secrets." };
    },
    resolve(ref) {
      if (!externalSecret || ref !== externalRef) return { ref, configured: false, status: this.status(ref) };
      onResolve?.(store, provider.id);
      if (resolverFailure) throw new Error(resolverFailure);
      if (resolverStatusFailure) return {
        ref, configured: false,
        status: { ref, kind: "keychain", configured: false, errorCode: resolverStatusCode, message: resolverStatusFailure },
      };
      return { ref, configured: true, value: fixtureSecret, status: this.status(ref) };
    },
    setSecret() { throw new Error("Local discovery fixture must not write Keychain."); },
    deleteSecret() { throw new Error("Local discovery fixture must not delete Keychain."); },
  };
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd }, {
    externalSecretStore: fakeKeychain,
    secretResolver: createCompositeSecretResolver({ env: {}, keychainResolver: fakeKeychain }),
    storeFactory(requestedCwd) {
      assert.equal(requestedCwd, cwd, "discovery fixture cannot open another workspace");
      store ??= createSqliteRunStore(cwd, resolveStoragePaths(cwd, {
        userRootDir: resolve(root, "storage-home"), workspaceStateLocation: "user-data-dir", env: {},
      }).workspace);
      return store;
    },
  });
  const requests = [];
  async function close() {
    release("success");
    await Promise.allSettled(requests);
    await daemon.stop();
    await new Promise((resolveClose, rejectClose) => {
      modelServer.close((error) => error ? rejectClose(error) : resolveClose());
      modelServer.closeAllConnections();
    });
    await rm(root, { recursive: true, force: true });
  }
  try {
    await daemon.start();
    assert.ok(store);
    const initial = store.createProviderPreset({
      kind: media ? "seedream" : paginated ? "google" : "openai-compatible", displayName: "Isolated discovery fixture",
      providerId: media ? "seedream" : paginated ? "google" : "fixture-local-relay", model: media ? "doubao-seedream-5-0-260128" : "fixture-chat-model",
      api: media ? "media-job" : paginated ? "google-generative-ai" : "openai-completions", baseUrl: modelUrl, authHeader: true,
      capabilities: media ? ["image_generate"] : ["chat"], input: ["text"], enabled: true,
    }, frozenTime);
    store.setProviderSecret(initial.id, fixtureSecret, frozenTime);
    provider = store.updateProviderPreset(initial.id, { apiKeyRef: externalSecret ? externalRef : `local:${initial.id}` }, frozenTime);
    const initialAuthority = store.getProviderCheckAuthority(provider.id);
    assert.ok(initialAuthority);
    const daemonAddress = daemon.server.address();
    assert.ok(daemonAddress && typeof daemonAddress === "object");
    const url = `http://127.0.0.1:${daemonAddress.port}/provider-models?cwd=${encodeURIComponent(cwd)}`;
    return {
      provider, store, modelUrl, modelRequests, initialAuthority,
      authority: () => store.getProviderCheckAuthority(provider.id),
      discover(overrides = {}) {
        const pending = requestJson(url, {
          providerPresetId: provider.id, kind: provider.kind, providerId: provider.providerId,
          api: provider.api, baseUrl: provider.baseUrl, authHeader: provider.authHeader,
          ...(externalSecret ? { apiKeyRef: externalRef } : {}),
          ...overrides,
        }, t.signal);
        requests.push(pending);
        void pending.catch(() => {});
        return pending;
      },
      waitForRequest: () => waitForArrival(requestArrived, t.signal),
      release: (mode = "success") => release(mode),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

async function requestJson(url, body, signal) {
  const response = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal,
  });
  return { status: response.status, body: await response.json() };
}

function waitForArrival(requestArrived, signal) {
  return new Promise((resolveArrived, rejectArrived) => {
    const onAbort = () => rejectArrived(signal.reason ?? new Error("Discovery fixture aborted before HTTP request arrived."));
    signal.addEventListener("abort", onAbort, { once: true });
    requestArrived.then((request) => {
      signal.removeEventListener("abort", onAbort);
      resolveArrived(request);
    }, (error) => {
      signal.removeEventListener("abort", onAbort);
      rejectArrived(error);
    });
    if (signal.aborted) onAbort();
  });
}

function restoreEnvironment(name, previousValue) {
  if (previousValue === undefined) delete process.env[name];
  else process.env[name] = previousValue;
}
