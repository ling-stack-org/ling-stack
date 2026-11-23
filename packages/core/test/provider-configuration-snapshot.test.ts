import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { test } from "node:test";
import {
  createSqliteRunStore, resolveStoragePaths, type ProviderPreset, type ProviderPresetInput, type SqliteRunStore,
} from "../dist/index.js";
import type { SqliteControlPlaneStore } from "../dist/storage/sqlite/control-plane-store.js";
import { SqliteProviderCheckPublicationStore } from "../dist/storage/sqlite/provider-check-publication-store.js";
import type { SqliteProviderStore } from "../dist/storage/sqlite/provider-store.js";
import { testDatabase } from "./support/sqlite-test-database.ts";

const NOW = "2026-10-09T03:00:00.000Z";
const INPUT: ProviderPresetInput = {
  kind: "openai-compatible", displayName: "Snapshot fixture", providerId: "fixture",
  model: "fixture-model", api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1",
  capabilities: ["chat"], enabled: true,
};

interface SnapshotFixture {
  store: SqliteRunStore;
  database: DatabaseSync;
  open: () => SqliteRunStore;
  provider: ProviderPreset;
}

function unexpectedDependencyCall(): never {
  assert.fail("Reading a configuration snapshot must use the SQLite query directly.");
}

const providers: Pick<SqliteProviderStore, "getProviderPreset"> = {
  getProviderPreset: unexpectedDependencyCall,
};
const events: Pick<SqliteControlPlaneStore, "appendControlPlaneEventWithinTransaction"> = {
  appendControlPlaneEventWithinTransaction: unexpectedDependencyCall,
};

async function withStore(body: (fixture: SnapshotFixture) => void | Promise<void>) {
  const directory = await mkdtemp(resolve(tmpdir(), "ling-provider-config-snapshot-"));
  const cwd = resolve(directory, "workspace");
  const paths = resolveStoragePaths(cwd, { homeDir: resolve(directory, "home"), env: {},
    workspaceStateLocation: "repo-local" }).workspace;
  const stores: SqliteRunStore[] = [];
  const open = () => {
    const store = createSqliteRunStore(cwd, paths);
    stores.push(store);
    return store;
  };
  const store = open();
  try {
    return await body({ store, database: testDatabase(store), open, provider: store.createProviderPreset(INPUT, NOW) });
  } finally {
    for (const candidate of stores.reverse()) if (testDatabase(candidate).isOpen) candidate.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test("configuration snapshot is read-only and does not consume a check request", async () => {
  await withStore(({ store, provider }) => {
    const before = store.getProviderCheckAuthority(provider.id);
    const snapshot = store.getProviderConfigurationSnapshot(provider.id);
    assert.ok(before);
    assert.ok(snapshot);
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
  await withStore(({ store, database, provider }) => {
    const reader = new SqliteProviderCheckPublicationStore(database,
      providers as SqliteProviderStore, events as SqliteControlPlaneStore);
    const snapshot = reader.getProviderConfigurationSnapshot(provider.id);
    const authority = store.getProviderCheckAuthority(provider.id);
    assert.ok(snapshot);
    assert.ok(authority);
    assert.deepEqual(snapshot.provider, provider);
    assert.equal(snapshot.configRevision, authority.configRevision);
  });
});

test("configuration snapshot observes same-time ABA and SQLite reopen without timestamp authority", async () => {
  await withStore(({ store, open, provider }) => {
    const first = store.getProviderConfigurationSnapshot(provider.id);
    assert.ok(first);
    const other = open();
    other.updateProviderPreset(provider.id, { baseUrl: "http://127.0.0.1:2/v1" }, NOW);
    const second = store.getProviderConfigurationSnapshot(provider.id);
    assert.ok(second);
    assert.equal(second.provider.baseUrl, "http://127.0.0.1:2/v1");
    assert.ok(second.configRevision > first.configRevision);
    other.updateProviderPreset(provider.id, { baseUrl: provider.baseUrl }, NOW);
    const third = open().getProviderConfigurationSnapshot(provider.id);
    assert.ok(third);
    assert.deepEqual(third.provider, first.provider);
    assert.ok(third.configRevision > second.configRevision);
  });
});

test("missing and deleted providers cannot produce a snapshot from a tombstone", async () => {
  await withStore(({ store, database, provider }) => {
    assert.equal(store.getProviderConfigurationSnapshot("missing"), undefined);
    store.deleteProviderPreset(provider.id);
    assert.equal(store.getProviderConfigurationSnapshot(provider.id), undefined);
    assert.ok(database.prepare("SELECT 1 FROM provider_check_authorities WHERE provider_id=?").get(provider.id));
  });
});

test("snapshot can read inside an existing transaction without opening or committing it", async () => {
  await withStore(({ store, database, provider }) => {
    database.exec("BEGIN IMMEDIATE");
    try {
      store.updateProviderPreset(provider.id, { model: "uncommitted-model" }, NOW);
      assert.equal(store.getProviderConfigurationSnapshot(provider.id)?.provider.model, "uncommitted-model");
    } finally {
      database.exec("ROLLBACK");
    }
    assert.equal(store.getProviderConfigurationSnapshot(provider.id)?.provider.model, provider.model);
  });
});

test("snapshot rejects missing, invalid or unsafe authority instead of defaulting to revision zero", async () => {
  await withStore(({ database, provider }) => {
    const row = database.prepare("SELECT * FROM provider_presets WHERE id=?").get(provider.id);
    assert.ok(row);
    for (const configRevision of [undefined, null, 0, -1, 1.5, BigInt(Number.MAX_SAFE_INTEGER) + 1n]) {
      const statement: Pick<StatementSync, "setReadBigInts" | "get"> = {
        setReadBigInts() {},
        get: () => {
          const result = { ...row };
          if (configRevision === undefined) delete result.config_revision;
          else result.config_revision = configRevision;
          return result;
        },
      };
      const connection: Pick<DatabaseSync, "prepare"> = { prepare: () => statement as StatementSync };
      const reader = new SqliteProviderCheckPublicationStore(connection as DatabaseSync,
        providers as SqliteProviderStore, events as SqliteControlPlaneStore);
      assert.throws(() => reader.getProviderConfigurationSnapshot(provider.id), /authority|config_revision/i);
    }
  });
});
