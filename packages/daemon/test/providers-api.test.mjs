import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { createSqliteRunStore } from "@ling-stack/core";
import { createDaemonServer } from "../dist/index.js";

test("DELETE /providers/:id blocks channel references and preserves local secret", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-providers-api-delete-blocked-"));
  const stores = new Map();
  const daemon = await startDaemonForTest(stores);
  try {
    const created = await postJson(`${daemon.url}/providers?cwd=${encodeURIComponent(cwd)}`, {
      kind: "openai-compatible",
      displayName: "Local Relay",
      providerId: "local-relay",
      model: "gpt-test",
      api: "openai-responses",
      baseUrl: "https://example.test/v1",
      apiKey: "sk-local-provider-secret",
      capabilities: ["chat"],
      input: ["text"],
      enabled: true,
    });
    const provider = created.provider;
    const store = stores.get(cwd);
    assert.ok(store, "expected daemon store to be created");
    store.createChannel({
      name: "Engineering",
      boundPath: cwd,
      defaultProviderPresetId: provider.id,
    }, "2026-06-30T00:00:00.000Z");

    const disableBlocked = await requestJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}?cwd=${encodeURIComponent(cwd)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(disableBlocked.status, 409);
    assert.equal(disableBlocked.body.error, "provider_update_blocked");
    assert.equal(disableBlocked.body.blockers[0].kind, "channel_default_provider");

    const secretRemovalBlocked = await requestJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}?cwd=${encodeURIComponent(cwd)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clearApiKey: true }),
    });
    assert.equal(secretRemovalBlocked.status, 409);
    assert.equal(secretRemovalBlocked.body.error, "provider_update_blocked");

    const blocked = await requestJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}?cwd=${encodeURIComponent(cwd)}`, {
      method: "DELETE",
    });

    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error, "provider_delete_blocked");
    assert.equal(blocked.body.blockers[0].kind, "channel_default_provider");
    assert.equal(blocked.body.blockers[0].label, "Engineering");
    assert.match(blocked.body.message, /Provider is still used/);

    const providers = await getJson(`${daemon.url}/providers?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(providers.providers.some((item) => item.id === provider.id), true);
    const secret = await getJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/secret?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(secret.configured, true);
    assert.equal(secret.apiKey, "sk-local-provider-secret");
  } finally {
    await daemon.close();
    for (const store of stores.values()) {
      store.close();
    }
    await rm(cwd, { recursive: true, force: true });
  }
});

test("provider secret header refs are validated and materialized for model discovery", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-providers-api-secret-headers-"));
  const stores = new Map();
  const daemon = await startDaemonForTest(stores);
  const modelServer = await startModelServerForSecretHeaderTest();
  const previousHeaderSecret = process.env.LING_STACK_TEST_SECRET_HEADER;
  try {
    process.env.LING_STACK_TEST_SECRET_HEADER = "tenant-secret-value";

    const duplicate = await postJsonAllowFailure(`${daemon.url}/provider-models?cwd=${encodeURIComponent(cwd)}`, {
      kind: "openai-compatible",
      displayName: "Relay",
      providerId: "relay",
      model: "gpt-test",
      api: "openai-completions",
      baseUrl: modelServer.url,
      apiKey: "sk-provider-models-test",
      headers: { "x-tenant-token": "static" },
      secretHeaderRefs: { "X-Tenant-Token": "env:LING_STACK_TEST_SECRET_HEADER" },
      capabilities: ["chat"],
    });
    assert.equal(duplicate.status, 400);
    assert.match(duplicate.body.message, /both a static and secret header/);

    const authConflict = await postJsonAllowFailure(`${daemon.url}/provider-models?cwd=${encodeURIComponent(cwd)}`, {
      kind: "openai-compatible",
      displayName: "Relay",
      providerId: "relay",
      model: "gpt-test",
      api: "openai-completions",
      baseUrl: modelServer.url,
      apiKey: "sk-provider-models-test",
      secretHeaderRefs: { Authorization: "env:LING_STACK_TEST_SECRET_HEADER" },
      capabilities: ["chat"],
    });
    assert.equal(authConflict.status, 400);
    assert.match(authConflict.body.message, /Authorization secret header requires authHeader=false/);

    const missing = await postJsonAllowFailure(`${daemon.url}/provider-check?cwd=${encodeURIComponent(cwd)}`, {
      kind: "openai-compatible",
      displayName: "Relay",
      providerId: "relay",
      model: "gpt-test",
      api: "openai-completions",
      baseUrl: modelServer.url,
      apiKey: "sk-provider-check-test",
      secretHeaderRefs: { "x-missing-token": "env:LING_STACK_TEST_MISSING_SECRET_HEADER" },
      capabilities: ["chat"],
    });
    assert.equal(missing.status, 200);
    assert.equal(missing.body.ok, false);
    assert.equal(missing.body.code, "secret_missing");

    const models = await postJson(`${daemon.url}/provider-models?cwd=${encodeURIComponent(cwd)}`, {
      kind: "openai-compatible",
      displayName: "Relay",
      providerId: "relay",
      model: "gpt-test",
      api: "openai-completions",
      baseUrl: modelServer.url,
      apiKey: "sk-provider-models-test",
      secretHeaderRefs: { "x-tenant-token": "env:LING_STACK_TEST_SECRET_HEADER" },
      capabilities: ["chat"],
    });
    assert.deepEqual(models.models.map((model) => model.id), ["gpt-secret-header"]);
    assert.equal(modelServer.requests[0].headers["x-tenant-token"], "tenant-secret-value");
    assert.equal(modelServer.requests[0].headers.authorization, "Bearer sk-provider-models-test");
  } finally {
    if (previousHeaderSecret === undefined) {
      delete process.env.LING_STACK_TEST_SECRET_HEADER;
    } else {
      process.env.LING_STACK_TEST_SECRET_HEADER = previousHeaderSecret;
    }
    await modelServer.close();
    await daemon.close();
    for (const store of stores.values()) {
      store.close();
    }
    await rm(cwd, { recursive: true, force: true });
  }
});

test("saved local provider secrets can fetch models only through their unchanged preset connection", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-providers-api-local-models-"));
  const stores = new Map();
  const keychain = createFakeKeychainStore();
  const daemon = await startDaemonForTest(stores, { externalSecretStore: keychain });
  const modelServer = await startModelServerForSecretHeaderTest();
  const localSecret = "sk-saved-local-model-discovery";
  const previousReplacementSecret = process.env.LING_STACK_TEST_REPLACEMENT_PROVIDER_KEY;
  try {
    process.env.LING_STACK_TEST_REPLACEMENT_PROVIDER_KEY = "replacement-env-model-discovery-test-value";
    keychain.setSecret("keychain:LING_STACK_TEST_REPLACEMENT_PROVIDER_KEY", "replacement-keychain-model-discovery-test-value");
    const created = await postJson(`${daemon.url}/providers?cwd=${encodeURIComponent(cwd)}`, {
      kind: "openai-compatible",
      displayName: "Saved Relay",
      providerId: "custom-openai-compatible",
      model: "gpt-secret-header",
      api: "openai-completions",
      baseUrl: modelServer.url,
      apiKey: localSecret,
      capabilities: ["chat"],
      input: ["text"],
      enabled: true,
    });

    const models = await postJson(`${daemon.url}/provider-models?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: created.provider.id,
      kind: created.provider.kind,
      providerId: created.provider.providerId,
      api: created.provider.api,
      baseUrl: created.provider.baseUrl,
      authHeader: created.provider.authHeader,
    });
    assert.deepEqual(models.models.map((model) => model.id), ["gpt-secret-header"]);
    assert.equal(modelServer.requests.length, 1);
    assert.equal(modelServer.requests[0].headers.authorization, `Bearer ${localSecret}`);
    assert.doesNotMatch(JSON.stringify(models), new RegExp(localSecret));

    const changedConnection = await postJsonAllowFailure(`${daemon.url}/provider-models?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: created.provider.id,
      kind: created.provider.kind,
      providerId: created.provider.providerId,
      api: created.provider.api,
      baseUrl: `${modelServer.url}/changed`,
      authHeader: created.provider.authHeader,
    });
    assert.equal(changedConnection.status, 409);
    assert.equal(changedConnection.body.error, "provider_model_connection_changed");
    assert.equal(modelServer.requests.length, 1);
    assert.doesNotMatch(JSON.stringify(changedConnection), new RegExp(localSecret));

    for (const [apiKeyRef, secret] of [
      ["env:LING_STACK_TEST_REPLACEMENT_PROVIDER_KEY", "replacement-env-model-discovery-test-value"],
      ["keychain:LING_STACK_TEST_REPLACEMENT_PROVIDER_KEY", "replacement-keychain-model-discovery-test-value"],
    ]) {
      const replacementModels = await postJson(`${daemon.url}/provider-models?cwd=${encodeURIComponent(cwd)}`, {
        providerPresetId: created.provider.id,
        kind: created.provider.kind,
        providerId: created.provider.providerId,
        api: created.provider.api,
        baseUrl: created.provider.baseUrl,
        authHeader: created.provider.authHeader,
        apiKeyRef,
        headers: { "x-discovery-credential": "replacement" },
      });
      assert.deepEqual(replacementModels.models.map((model) => model.id), ["gpt-secret-header"]);
      assert.equal(modelServer.requests.at(-1).headers.authorization, `Bearer ${secret}`);
      assert.equal(modelServer.requests.at(-1).headers["x-discovery-credential"], "replacement");
      assert.doesNotMatch(JSON.stringify(replacementModels), new RegExp(secret));
      assert.doesNotMatch(JSON.stringify(replacementModels), new RegExp(localSecret));
    }
    assert.equal(stores.get(cwd).getProviderSecret(created.provider.id), localSecret);
  } finally {
    if (previousReplacementSecret === undefined) {
      delete process.env.LING_STACK_TEST_REPLACEMENT_PROVIDER_KEY;
    } else {
      process.env.LING_STACK_TEST_REPLACEMENT_PROVIDER_KEY = previousReplacementSecret;
    }
    await modelServer.close();
    await daemon.close();
    for (const store of stores.values()) store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("native Gemini and Mistral model discovery use protocol-specific auth and response shapes", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-providers-native-models-"));
  const stores = new Map();
  const daemon = await startDaemonForTest(stores);
  const modelServer = await startNativeModelDiscoveryServer();
  try {
    const geminiToken = "gemini-test-token";
    const gemini = await postJson(`${daemon.url}/provider-models?cwd=${encodeURIComponent(cwd)}`, {
      kind: "google",
      providerId: "google-gemini",
      api: "google-generative-ai",
      baseUrl: modelServer.url,
      apiKey: geminiToken,
      capabilities: ["chat"],
    });

    assert.deepEqual(gemini.models.map((model) => model.id), ["gemini-3.5-flash"]);
    assert.equal(gemini.models[0].displayName, "Gemini 3.5 Flash");
    assert.equal(gemini.models[0].contextWindow, 1000000);
    assert.equal(gemini.models[0].maxTokens, 65536);
    assert.equal(gemini.source, `${modelServer.url}/models`);
    assert.ok(Date.parse(gemini.fetchedAt));
    assert.equal(gemini.catalog.source, "models.dev");
    assert.match(gemini.catalog.version, /^models\.dev:/);
    assert.equal(modelServer.requests[0].url, "/models");
    assert.equal(modelServer.requests[0].headers["x-goog-api-key"], geminiToken);
    assert.equal(modelServer.requests[0].headers.authorization, undefined);
    assert.doesNotMatch(JSON.stringify(gemini), new RegExp(geminiToken));

    const mistralToken = "mistral-test-token";
    const mistral = await postJson(`${daemon.url}/provider-models?cwd=${encodeURIComponent(cwd)}`, {
      kind: "openai-compatible",
      providerId: "mistral",
      api: "mistral-conversations",
      baseUrl: modelServer.url,
      apiKey: mistralToken,
      capabilities: ["chat"],
    });

    assert.deepEqual(mistral.models.map((model) => model.id), ["mistral-large-latest"]);
    assert.equal(modelServer.requests[1].headers.authorization, `Bearer ${mistralToken}`);
    assert.equal(modelServer.requests[1].headers["x-goog-api-key"], undefined);
    assert.doesNotMatch(JSON.stringify(mistral), new RegExp(mistralToken));
  } finally {
    await modelServer.close();
    await daemon.close();
    for (const store of stores.values()) store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("provider keychain setup saves refs without keeping local provider secret", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-providers-api-keychain-"));
  const stores = new Map();
  const keychain = createFakeKeychainStore();
  const daemon = await startDaemonForTest(stores, { externalSecretStore: keychain });
  try {
    const created = await postJson(`${daemon.url}/providers?cwd=${encodeURIComponent(cwd)}`, {
      kind: "openai-compatible",
      displayName: "Keychain Relay",
      providerId: "keychain-relay",
      model: "gpt-test",
      api: "openai-responses",
      baseUrl: "https://example.test/v1",
      apiKey: "sk-local-before-keychain",
      capabilities: ["chat"],
      input: ["text"],
      enabled: true,
    });
    const provider = created.provider;
    const store = stores.get(cwd);
    assert.equal(store.hasProviderSecret(provider.id), true);

    const configured = await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/secrets/configure?cwd=${encodeURIComponent(cwd)}`, {
      secretRef: "keychain:provider-keychain-relay",
      apiKey: "sk-keychain-secret",
    });

    assert.equal(configured.secretRef, "keychain:provider-keychain-relay");
    assert.equal(configured.status.configured, true);
    assert.equal(configured.provider.apiKeyRef, "keychain:provider-keychain-relay");
    assert.equal(configured.provider.apiKeyConfigured, true);
    assert.equal(store.hasProviderSecret(provider.id), false);
    assert.equal(keychain.values.get("keychain:provider-keychain-relay"), "sk-keychain-secret");

    const secret = await getJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/secret?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(secret.configured, false);
    assert.equal(secret.apiKey, "");
    assert.equal(secret.apiKeyRef, "keychain:provider-keychain-relay");

    const deleted = await deleteJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/secrets/keychain?cwd=${encodeURIComponent(cwd)}`, {
      secretRef: "keychain:provider-keychain-relay",
    });
    assert.equal(deleted.secretRef, "keychain:provider-keychain-relay");
    assert.equal(deleted.provider.id, provider.id);
    assert.equal(deleted.provider.apiKeyRef, undefined);
    assert.equal(keychain.values.has("keychain:provider-keychain-relay"), false);

    const providers = await getJson(`${daemon.url}/providers?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(providers.providers.some((item) => item.id === provider.id), true);
  } finally {
    await daemon.close();
    for (const store of stores.values()) {
      store.close();
    }
    await rm(cwd, { recursive: true, force: true });
  }
});

test("provider keychain setup reports unavailable stores", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-providers-api-keychain-unavailable-"));
  const stores = new Map();
  const daemon = await startDaemonForTest(stores, { externalSecretStore: createUnavailableKeychainStore() });
  try {
    const created = await postJson(`${daemon.url}/providers?cwd=${encodeURIComponent(cwd)}`, {
      kind: "openai-compatible",
      displayName: "Unavailable Keychain Relay",
      providerId: "unavailable-keychain-relay",
      model: "gpt-test",
      api: "openai-responses",
      baseUrl: "https://example.test/v1",
      apiKey: "sk-local-before-keychain",
      capabilities: ["chat"],
      input: ["text"],
      enabled: true,
    });

    const unavailable = await postJsonAllowFailure(
      `${daemon.url}/providers/${encodeURIComponent(created.provider.id)}/secrets/configure?cwd=${encodeURIComponent(cwd)}`,
      {
        secretRef: "keychain:provider-unavailable",
        apiKey: "sk-keychain-secret",
      },
    );

    assert.equal(unavailable.status, 501);
    assert.equal(unavailable.body.error, "secret_store_unavailable");
  } finally {
    await daemon.close();
    for (const store of stores.values()) {
      store.close();
    }
    await rm(cwd, { recursive: true, force: true });
  }
});

test("provider model import returns while bounded background checks continue", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-provider-import-background-check-"));
  const stores = new Map();
  const daemon = await startDaemonForTest(stores);
  const modelServer = await startDelayedChatCheckServer(400);
  try {
    const imported = await postJson(`${daemon.url}/providers/import-models?cwd=${encodeURIComponent(cwd)}`, {
      kind: "openai-compatible",
      displayName: "Background Relay",
      providerId: "background-relay",
      api: "openai-completions",
      baseUrl: modelServer.url,
      apiKey: "background-check-secret",
      authHeader: true,
      capabilities: ["chat"],
      input: ["text"],
      models: [
        { id: "background-model-1" },
        { id: "background-model-2" },
        { id: "background-model-3" },
        { id: "background-model-4" },
      ],
    });

    assert.equal(imported.createdCount, 4);
    assert.deepEqual(imported.providers.map((provider) => provider.lastCheck?.code), [
      "checking",
      "checking",
      "checking",
      "checking",
    ]);

    const pending = await getJson(`${daemon.url}/providers?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(pending.providers.filter((provider) => provider.lastCheck?.code === "checking").length, 4);

    await waitFor(async () => {
      const listed = await getJson(`${daemon.url}/providers?cwd=${encodeURIComponent(cwd)}`);
      return listed.providers.length === 4 && listed.providers.every((provider) => provider.lastCheck?.ok === true);
    }, 3_000);
    assert.equal(modelServer.requestCount, 4);
    assert.equal(modelServer.maxInFlight, 3);
  } finally {
    await daemon.close();
    await modelServer.close();
    for (const store of stores.values()) {
      store.close();
    }
    await rm(cwd, { recursive: true, force: true });
  }
});

test("custom compatible model import stores model identity without repeating the route name", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-provider-import-custom-name-"));
  const stores = new Map();
  const daemon = await startDaemonForTest(stores);
  try {
    const imported = await postJson(`${daemon.url}/providers/import-models?cwd=${encodeURIComponent(cwd)}`, {
      kind: "openai-compatible",
      displayName: "gpt-5.6-luna",
      providerId: "custom-openai-compatible",
      api: "openai-completions",
      baseUrl: "https://relay.example.test/v1",
      apiKey: "custom-name-secret",
      authHeader: true,
      capabilities: ["chat"],
      input: ["text"],
      models: [{ id: "gpt-5.6-luna" }, { id: "gpt-image-2", api: "media-job", capabilities: ["image_generate"] }],
    });

    assert.deepEqual(imported.providers.map((provider) => provider.displayName), ["gpt-5.6-luna", "gpt-image-2"]);
  } finally {
    await daemon.close();
    for (const store of stores.values()) store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("provider import background result does not overwrite a newer edit", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-provider-import-stale-check-"));
  const stores = new Map();
  const daemon = await startDaemonForTest(stores);
  const modelServer = await startDelayedChatCheckServer(300);
  try {
    const imported = await postJson(`${daemon.url}/providers/import-models?cwd=${encodeURIComponent(cwd)}`, {
      kind: "openai-compatible",
      displayName: "Editable Relay",
      providerId: "editable-relay",
      api: "openai-completions",
      baseUrl: modelServer.url,
      apiKey: "editable-check-secret",
      authHeader: true,
      capabilities: ["chat"],
      input: ["text"],
      models: [{ id: "editable-model" }],
    });
    const provider = imported.providers[0];
    assert.equal(provider.lastCheck?.code, "checking");

    const edited = await requestJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}?cwd=${encodeURIComponent(cwd)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "Edited after import" }),
    });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.provider.displayName, "Edited after import");
    assert.equal(edited.body.provider.lastCheck, undefined);

    await new Promise((resolveWait) => setTimeout(resolveWait, 450));
    const listed = await getJson(`${daemon.url}/providers?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(listed.providers[0].displayName, "Edited after import");
    assert.equal(listed.providers[0].lastCheck, undefined);
  } finally {
    await daemon.close();
    await modelServer.close();
    for (const store of stores.values()) {
      store.close();
    }
    await rm(cwd, { recursive: true, force: true });
  }
});

async function startDaemonForTest(stores, dependencies = {}) {
  const daemon = createDaemonServer({
    host: "127.0.0.1",
    port: 0,
  }, {
    ...dependencies,
    storeFactory: (cwd) => {
      const existing = stores.get(cwd);
      if (existing) {
        return existing;
      }
      const store = createSqliteRunStore(cwd);
      stores.set(cwd, store);
      return store;
    },
  });
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => daemon.stop(),
  };
}

function createFakeKeychainStore() {
  const values = new Map();
  return {
    values,
    status(ref) {
      if (!ref.startsWith("keychain:")) {
        return { ref, kind: "env", configured: false, errorCode: "invalid_secret_ref", message: "Only keychain refs are supported." };
      }
      return values.has(ref)
        ? { ref, kind: "keychain", configured: true }
        : { ref, kind: "keychain", configured: false, errorCode: "secret_missing", message: `Secret is not configured: ${ref}` };
    },
    resolve(ref) {
      const status = this.status(ref);
      return status.configured
        ? { ref, configured: true, value: values.get(ref), status }
        : { ref, configured: false, status };
    },
    setSecret(ref, value) {
      if (!ref.startsWith("keychain:")) {
        return { ref, kind: "env", configured: false, errorCode: "invalid_secret_ref", message: "Only keychain refs are supported." };
      }
      values.set(ref, value);
      return { ref, kind: "keychain", configured: true };
    },
    deleteSecret(ref) {
      values.delete(ref);
      return { ref, kind: "keychain", configured: false, errorCode: "secret_missing", message: `Secret is not configured: ${ref}` };
    },
  };
}

function createUnavailableKeychainStore() {
  return {
    status(ref) {
      return { ref, kind: "keychain", configured: false, errorCode: "secret_store_unavailable", message: "Keychain unavailable in test." };
    },
    resolve(ref) {
      return { ref, configured: false, status: this.status(ref) };
    },
    setSecret(ref) {
      return this.status(ref);
    },
    deleteSecret(ref) {
      return this.status(ref);
    },
  };
}

async function startModelServerForSecretHeaderTest() {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ url: request.url, headers: request.headers });
    if (request.url !== "/models") {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "not found" }));
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "gpt-secret-header" }] }));
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    requests,
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose());
    }),
  };
}

async function startNativeModelDiscoveryServer() {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ url: request.url, headers: request.headers });
    if (request.url !== "/models") {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "not found" }));
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    if (request.headers["x-goog-api-key"]) {
      response.end(JSON.stringify({
        models: [
          {
            name: "models/gemini-3.5-flash",
            displayName: "Gemini 3.5 Flash",
            inputTokenLimit: 1000000,
            outputTokenLimit: 65536,
            supportedGenerationMethods: ["generateContent", "countTokens"],
          },
          {
            name: "models/text-embedding-004",
            displayName: "Text Embedding 004",
            supportedGenerationMethods: ["embedContent"],
          },
        ],
      }));
      return;
    }
    response.end(JSON.stringify({ data: [{ id: "mistral-large-latest", owned_by: "mistral" }] }));
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    requests,
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose());
    }),
  };
}

async function startDelayedChatCheckServer(delayMs) {
  let requestCount = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const server = createServer((_request, response) => {
    requestCount += 1;
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    setTimeout(() => {
      inFlight -= 1;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }));
    }, delayMs);
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    get requestCount() {
      return requestCount;
    },
    get maxInFlight() {
      return maxInFlight;
    },
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose());
    }),
  };
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  assert.fail(`condition was not met within ${timeoutMs}ms`);
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    assert.fail(`${response.status} ${response.statusText}: ${await response.text()}`);
  }
  return await response.json();
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    assert.fail(`${response.status} ${response.statusText}: ${await response.text()}`);
  }
  return await response.json();
}

async function postJsonAllowFailure(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let responseBody = {};
  try {
    responseBody = await response.json();
  } catch {
    responseBody = {};
  }
  return { status: response.status, body: responseBody };
}

async function deleteJson(url, body) {
  const response = await fetch(url, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    assert.fail(`${response.status} ${response.statusText}: ${await response.text()}`);
  }
  return await response.json();
}

async function requestJson(url, init) {
  const response = await fetch(url, init);
  let body = {};
  try {
    body = await response.json();
  } catch {
    body = {};
  }
  return { status: response.status, body };
}
