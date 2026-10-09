import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { createSqliteRunStore, resolveStoragePaths } from "../dist/index.js";
import { SqliteProviderCheckPublicationStore } from "../dist/storage/sqlite/provider-check-publication-store.js";

const NOW = "2026-10-09T03:00:00.000Z";
const INPUT = {
  kind: "openai-compatible", displayName: "Snapshot fixture", providerId: "fixture",
  model: "fixture-model", api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1",
  capabilities: ["chat"], enabled: true,
};

async function withStore(body) {
  const directory = await mkdtemp(resolve(tmpdir(), "ling-provider-config-snapshot-"));
  const cwd = resolve(directory, "workspace");
  const paths = resolveStoragePaths(cwd, { homeDir: resolve(directory, "home"), env: {},
    workspaceStateLocation: "repo-local" }).workspace;
  const stores = [];
  const open = () => {
    const store = createSqliteRunStore(cwd, paths);
    stores.push(store);
    return store;
  };
  const store = open();
  try {
    return await body({ store, open, cwd, provider: store.createProviderPreset(INPUT, NOW) });
  } finally {
    for (const candidate of stores.reverse()) if (candidate.database.isOpen) candidate.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test("configuration snapshot is read-only and does not consume a check request", async () => {
  await withStore(({ store, provider }) => {
    const before = store.getProviderCheckAuthority(provider.id);
    const snapshot = store.getProviderConfigurationSnapshot(provider.id);
    assert.deepEqual(Object.keys(snapshot).sort(), ["configRevision", "provider"]);
    assert.deepEqual(snapshot.provider, provider);
    assert.equal(snapshot.configRevision, before.configRevision);
    assert.deepEqual(store.getProviderCheckAuthority(provider.id), before);
    assert.equal(Object.hasOwn(snapshot.provider, "configRevision"), false);
    store.beginProviderCheckRequest(provider.id, "manual");
    assert.deepEqual(store.getProviderConfigurationSnapshot(provider.id), snapshot);
  });
});

test("configuration and its authority come from one SQLite read, never a separate preset getter", async () => {
  await withStore(({ store, provider }) => {
    const forbidden = () => { throw new Error("Separate preset read can combine configuration A with revision B."); };
    const reader = new SqliteProviderCheckPublicationStore(store.database,
      { getProviderPreset: forbidden }, { appendControlPlaneEventWithinTransaction: forbidden });
    const snapshot = reader.getProviderConfigurationSnapshot(provider.id);
    assert.deepEqual(snapshot.provider, provider);
    assert.equal(snapshot.configRevision, store.getProviderCheckAuthority(provider.id).configRevision);
  });
});

test("configuration snapshot observes same-time ABA and SQLite reopen without timestamp authority", async () => {
  await withStore(({ store, open, provider }) => {
    const first = store.getProviderConfigurationSnapshot(provider.id);
    const other = open();
    other.updateProviderPreset(provider.id, { baseUrl: "http://127.0.0.1:2/v1" }, NOW);
    const second = store.getProviderConfigurationSnapshot(provider.id);
    assert.equal(second.provider.baseUrl, "http://127.0.0.1:2/v1");
    assert.ok(second.configRevision > first.configRevision);
    other.updateProviderPreset(provider.id, { baseUrl: provider.baseUrl }, NOW);
    const third = open().getProviderConfigurationSnapshot(provider.id);
    assert.deepEqual(third.provider, first.provider);
    assert.ok(third.configRevision > second.configRevision);
  });
});

test("missing and deleted providers cannot produce a snapshot from a tombstone", async () => {
  await withStore(({ store, provider }) => {
    assert.equal(store.getProviderConfigurationSnapshot("missing"), undefined);
    store.deleteProviderPreset(provider.id);
    assert.equal(store.getProviderConfigurationSnapshot(provider.id), undefined);
    assert.ok(store.database.prepare("SELECT 1 FROM provider_check_authorities WHERE provider_id=?").get(provider.id));
  });
});

test("snapshot can read inside an existing transaction without opening or committing it", async () => {
  await withStore(({ store, provider }) => {
    store.database.exec("BEGIN IMMEDIATE");
    try {
      store.updateProviderPreset(provider.id, { model: "uncommitted-model" }, NOW);
      assert.equal(store.getProviderConfigurationSnapshot(provider.id).provider.model, "uncommitted-model");
    } finally {
      store.database.exec("ROLLBACK");
    }
    assert.equal(store.getProviderConfigurationSnapshot(provider.id).provider.model, provider.model);
  });
});

test("snapshot rejects missing, invalid or unsafe authority instead of defaulting to revision zero", async () => {
  await withStore(({ store, provider }) => {
    const row = store.database.prepare("SELECT * FROM provider_presets WHERE id=?").get(provider.id);
    for (const config_revision of [undefined, null, 0, -1, 1.5, BigInt(Number.MAX_SAFE_INTEGER) + 1n]) {
      const reader = new SqliteProviderCheckPublicationStore({ prepare() {
        return { setReadBigInts() {}, get() { return { ...row, config_revision }; } };
      } }, {}, {});
      assert.throws(() => reader.getProviderConfigurationSnapshot(provider.id), /authority|config_revision/i);
    }
  });
});
