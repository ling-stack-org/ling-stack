import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  DEFAULT_WORKSPACE_ID,
  createSqliteRunStore,
  resolveStoragePaths,
} from "../dist/index.js";
import { applyMcpMetadataMigration } from "../dist/storage/sqlite/mcp-metadata-migration.js";

const NOW = "2026-10-09T00:00:00.000Z";
const SERVER_ID = "mcp_metadata_fixture";

function serverInput(overrides = {}) {
  return {
    id: SERVER_ID,
    displayName: "Metadata fixture",
    transport: {
      type: "stdio",
      command: "/fixture/mcp",
      args: [],
      env: {},
      secretEnvRefs: {},
    },
    enabled: true,
    ...overrides,
  };
}

function tool(rawName) {
  return {
    rawName,
    displayName: rawName,
    inputSchema: { type: "object" },
    callableNamespace: SERVER_ID,
    callableName: rawName,
    sideEffectLevel: "read",
    defaultApproval: "allow",
    enabled: true,
  };
}

function snapshot(message = "Current check", status = "ready") {
  return {
    serverId: SERVER_ID,
    checkedAt: NOW,
    expiresAt: "2026-10-09T00:05:00.000Z",
    status,
    message,
    authStatus: { kind: "not_required", refs: [], missingRefs: [] },
    missingSecretRefs: [],
  };
}

/** Every database and user-config path is owned by this temporary fixture. */
async function withStore(body, input = serverInput()) {
  const directory = await mkdtemp(resolve(tmpdir(), "ling-mcp-metadata-publication-"));
  const cwd = resolve(directory, "workspace");
  const paths = resolveStoragePaths(cwd, {
    homeDir: resolve(directory, "home"),
    env: {},
    workspaceStateLocation: "repo-local",
  }).workspace;
  const stores = [];
  const open = () => {
    const store = createSqliteRunStore(cwd, paths);
    stores.push(store);
    return store;
  };
  const store = open();
  try {
    store.createMcpServer(input, NOW);
    return await body({ store, open, cwd });
  } finally {
    for (const candidate of stores.reverse()) {
      if (candidate.database.isOpen) candidate.close();
    }
    await rm(directory, { recursive: true, force: true });
  }
}

function begin(store, kind = "check") {
  const request = store.beginMcpMetadataRequest(SERVER_ID, kind);
  assert.ok(request, "Existing fixture server must admit a metadata request");
  return request;
}

function publish(store, request, cwd, statusSnapshot = snapshot(), tools) {
  return store.commitMcpMetadataResult({ request, statusSnapshot, tools, cwd, now: NOW });
}

/** Include durable revisions and replay state, not just the visible snapshot. */
function state(store) {
  return {
    server: store.getMcpServer(SERVER_ID),
    snapshot: store.getMcpStatusSnapshot(SERVER_ID),
    catalog: store.listMcpTools({ serverId: SERVER_ID, limit: 500 }),
    catalogRows: store.database.prepare(
      "SELECT * FROM mcp_tools WHERE server_id = ? ORDER BY raw_name",
    ).all(SERVER_ID),
    // Legacy authority columns permit SQLite integers beyond JS's safe range.
    // Read their exact text so a deliberately corrupted fixture stays inspectable.
    authority: store.database.prepare(`
      SELECT server_id,
        CAST(server_revision AS TEXT) AS server_revision,
        CAST(tools_revision AS TEXT) AS tools_revision,
        CAST(metadata_request_revision AS TEXT) AS metadata_request_revision,
        CAST(metadata_published_revision AS TEXT) AS metadata_published_revision
      FROM mcp_authority_revisions WHERE server_id = ?
    `).get(SERVER_ID),
    events: store.listControlPlaneEvents({ workspaceId: DEFAULT_WORKSPACE_ID }),
    replay: store.getControlPlaneReplayState(DEFAULT_WORKSPACE_ID),
  };
}

test("metadata admission preserves legacy authority getter and records migration 155", async () => {
  await withStore(({ store }) => {
    assert.ok(store.database.prepare(
      "SELECT version FROM schema_migrations WHERE version = 155 AND name = 'add_mcp_metadata_publication_revisions'",
    ).get());
    const legacy = store.getMcpAuthorityRevision(SERVER_ID);
    const request = begin(store);
    assert.deepEqual(store.getMcpAuthorityRevision(SERVER_ID), legacy);
    assert.deepEqual(Object.keys(legacy).sort(), ["serverRevision", "toolsRevision"]);
    assert.equal(request.requestRevision, 1);
    assert.equal(request.serverRevision, legacy.serverRevision);
    assert.equal(request.toolsRevision, legacy.toolsRevision);
    assert.equal(request.kind, "check");
    assert.equal(request.server.id, SERVER_ID);
    assert.equal(store.beginMcpMetadataRequest("missing_server", "check"), undefined);
  });
});

test("two SQLite connections publish only the latest admitted same-config check", async () => {
  await withStore(({ store, open, cwd }) => {
    const other = open();
    const first = begin(store);
    const second = begin(other);
    assert.ok(second.requestRevision > first.requestRevision);
    const current = publish(other, second, cwd, snapshot("Newer check"));
    assert.equal(current.published, true);
    assert.equal(current.event.action, "mcp.status_checked");
    const committed = state(other);
    assert.deepEqual(publish(store, first, cwd, snapshot("Older check")), {
      published: false, reason: "superseded",
    });
    assert.deepEqual(state(store), committed);
    assert.equal(committed.snapshot.message, "Newer check");
    assert.equal(committed.events.length, 1);
    assert.equal(committed.replay.latestSeq, current.event.seq);
  });
});

for (const [olderKind, newerKind] of [["check", "sync-tools"], ["sync-tools", "check"]]) {
  test(`later ${newerKind} supersedes pending ${olderKind} before either completes`, async () => {
    await withStore(({ store, open, cwd }) => {
      store.replaceMcpServerTools(SERVER_ID, [tool("previous")], NOW);
      const older = begin(store, olderKind);
      const newer = begin(open(), newerKind);
      const before = state(store);
      assert.deepEqual(publish(store, older, cwd, snapshot("Obsolete"),
        olderKind === "sync-tools" ? [tool("obsolete")] : undefined), {
        published: false, reason: "superseded",
      });
      assert.deepEqual(state(store), before);
      const current = publish(store, newer, cwd, snapshot("Winner"),
        newerKind === "sync-tools" ? [tool("winner")] : undefined);
      assert.equal(current.published, true);
      assert.equal(current.event.action, newerKind === "check" ? "mcp.status_checked" : "mcp.tools_synced");
      assert.deepEqual(store.listMcpTools({ serverId: SERVER_ID }).map((item) => item.rawName),
        newerKind === "check" ? ["previous"] : ["winner"]);
    });
  });
}

test("a later failed sync still supersedes an earlier successful check", async () => {
  await withStore(({ store, cwd }) => {
    const earlier = begin(store);
    const later = begin(store, "sync-tools");
    const failed = publish(store, later, cwd, snapshot("Unavailable", "failed"));
    assert.equal(failed.published, true);
    assert.equal(failed.event.action, "mcp.tools_sync_failed");
    const committed = state(store);
    assert.deepEqual(publish(store, earlier, cwd), { published: false, reason: "superseded" });
    assert.deepEqual(state(store), committed);
  });
});

test("same-timestamp delete/recreate rejects the original ticket instead of ABA publication", async () => {
  await withStore(({ store, cwd }) => {
    const request = begin(store);
    assert.equal(store.deleteMcpServer(SERVER_ID), true);
    store.createMcpServer(serverInput(), NOW);
    assert.equal(store.getMcpServer(SERVER_ID).updatedAt, request.server.updatedAt);
    const before = state(store);
    assert.deepEqual(publish(store, request, cwd), { published: false, reason: "server_changed" });
    assert.deepEqual(state(store), before);
    assert.ok(begin(store).requestRevision > request.requestRevision);
  });
});

test("deleted server rejects publication without recreating snapshot or catalog", async () => {
  await withStore(({ store, cwd }) => {
    const request = begin(store, "sync-tools");
    store.deleteMcpServer(SERVER_ID);
    const before = state(store);
    assert.deepEqual(publish(store, request, cwd, snapshot(), [tool("late")]), {
      published: false, reason: "deleted",
    });
    assert.deepEqual(state(store), before);
  });
});

for (const [label, change] of [
  ["config", (store) => store.updateMcpServer(SERVER_ID, {
    transport: { ...serverInput().transport, args: ["changed"] },
  }, NOW)],
  ["enabled state", (store) => store.updateMcpServer(SERVER_ID, { enabled: false }, NOW)],
  ["catalog", (store) => store.replaceMcpServerTools(SERVER_ID, [tool("externally_changed")], NOW)],
]) {
  test(`${label} mutation at identical timestamp invalidates pending metadata`, async () => {
    await withStore(({ store, cwd }) => {
      const request = begin(store, "sync-tools");
      change(store);
      const before = state(store);
      assert.deepEqual(publish(store, request, cwd, snapshot(), [tool("late")]), {
        published: false, reason: label === "catalog" ? "tools_changed" : "server_changed",
      });
      assert.deepEqual(state(store), before);
    });
  });
}

test("restart preserves admission and one-time publication authority", async () => {
  await withStore(({ store, open, cwd }) => {
    const request = begin(store);
    store.close();
    const reopened = open();
    const result = publish(reopened, request, cwd);
    assert.equal(result.published, true);
    reopened.close();
    const afterRestart = open();
    const committed = state(afterRestart);
    assert.deepEqual(publish(afterRestart, request, cwd, snapshot("Duplicate")), {
      published: false, reason: "already_published",
    });
    assert.deepEqual(state(afterRestart), committed);
  });
});

test("disabled servers remain checkable and return current server data", async () => {
  await withStore(({ store, cwd }) => {
    const request = begin(store);
    store.updateMcpServer(SERVER_ID, { displayName: "Current display name" }, NOW);
    const result = publish(store, request, cwd, snapshot("Disabled", "disabled"));
    assert.equal(result.published, true);
    assert.equal(result.server.enabled, false);
    assert.equal(result.server.displayName, "Current display name");
    assert.equal(result.statusSnapshot.status, "disabled");
    assert.notEqual(request.server.displayName, result.server.displayName);
  }, serverInput({ enabled: false }));
});

test("successful sync publishes snapshot, catalog and one durable event atomically", async () => {
  await withStore(({ store, open, cwd }) => {
    store.replaceMcpServerTools(SERVER_ID, [tool("previous")], NOW);
    const request = begin(store, "sync-tools");
    const result = publish(store, request, cwd, { ...snapshot(), toolCount: 999 }, [tool("current")]);
    assert.equal(result.published, true);
    assert.equal(result.statusSnapshot.toolCount, 1);
    assert.deepEqual(result.tools.map((item) => item.rawName), ["current"]);
    assert.equal(result.event.action, "mcp.tools_synced");
    assert.equal(result.event.entityId, SERVER_ID);
    assert.equal(result.event.cwd, cwd);
    assert.equal(result.event.data.toolCount, 1);
    assert.deepEqual(open().getMcpStatusSnapshot(SERVER_ID), result.statusSnapshot);
    assert.deepEqual(open().listMcpTools({ serverId: SERVER_ID }), result.tools);
    const committed = state(store);
    assert.deepEqual(publish(store, request, cwd, snapshot("Duplicate"), [tool("duplicate")]), {
      published: false, reason: "already_published",
    });
    assert.deepEqual(state(store), committed);
  });
});

test("sync count reflects all persisted tools rather than the capped 500-item response", async () => {
  await withStore(({ store, cwd }) => {
    const request = begin(store, "sync-tools");
    const tools = Array.from({ length: 503 }, (_, index) => tool(`read_${String(index).padStart(3, "0")}`));
    const result = publish(store, request, cwd, snapshot(), tools);
    assert.equal(result.published, true);
    assert.equal(result.tools.length, 500);
    assert.equal(result.statusSnapshot.toolCount, 503);
    assert.equal(result.event.data.toolCount, 503);
    assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM mcp_tools WHERE server_id = ?")
      .get(SERVER_ID).count, 503);
  });
});

test("resync preserves first-seen lineage for tools beyond the public catalog page", async () => {
  await withStore(({ store, cwd }) => {
    const tools = Array.from({ length: 503 }, (_, index) => tool(`read_${String(index).padStart(3, "0")}`));
    assert.equal(publish(store, begin(store, "sync-tools"), cwd, snapshot(), tools).published, true);
    const later = "2026-10-09T00:01:00.000Z";
    const request = begin(store, "sync-tools");
    assert.equal(store.commitMcpMetadataResult({ request, statusSnapshot: snapshot(), tools, cwd, now: later }).published, true);
    const rows = store.database.prepare("SELECT raw_name, first_seen_at, last_seen_at FROM mcp_tools ORDER BY raw_name").all();
    assert.equal(rows.length, 503);
    assert.equal(rows.every(row => row.first_seen_at === NOW), true, "Every tool must retain its original admission lineage");
    assert.equal(rows.every(row => row.last_seen_at === later), true);
  });
});

test("failed sync preserves prior catalog and its revision while committing failure evidence", async () => {
  await withStore(({ store, cwd }) => {
    store.replaceMcpServerTools(SERVER_ID, [tool("known_good")], NOW);
    const beforeTools = store.listMcpTools({ serverId: SERVER_ID });
    const beforeAuthority = store.getMcpAuthorityRevision(SERVER_ID);
    const request = begin(store, "sync-tools");
    const failedSnapshot = { ...snapshot("Broker failed", "failed"), errorCode: "fixture_failed" };
    const result = publish(store, request, cwd, failedSnapshot, [tool("partial_untrusted")]);
    assert.equal(result.published, true);
    assert.equal(result.event.action, "mcp.tools_sync_failed");
    assert.deepEqual(store.getMcpStatusSnapshot(SERVER_ID), failedSnapshot);
    assert.deepEqual(store.listMcpTools({ serverId: SERVER_ID }), beforeTools);
    assert.deepEqual(store.getMcpAuthorityRevision(SERVER_ID), beforeAuthority);
    assert.equal(store.listControlPlaneEvents({ workspaceId: DEFAULT_WORKSPACE_ID }).length, 1);
  });
});

test("snapshot server mismatch is rejected before any durable write or ticket consumption", async () => {
  await withStore(({ store, cwd }) => {
    const request = begin(store);
    const before = state(store);
    assert.throws(() => publish(store, request, cwd, { ...snapshot(), serverId: "another_server" }),
      /Invalid MCP metadata/u);
    assert.deepEqual(state(store), before);
    assert.equal(publish(store, request, cwd).published, true);
  });
});

test("noninteger, negative, zero request and unsafe ticket revisions cannot publish", async () => {
  await withStore(({ store, cwd }) => {
    const request = begin(store);
    const before = state(store);
    for (const field of ["requestRevision", "serverRevision", "toolsRevision"]) {
      for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "1"])
        assert.throws(() => publish(store, { ...request, [field]: value }, cwd), /Invalid MCP metadata/u);
    }
    assert.throws(() => publish(store, { ...request, requestRevision: 0 }, cwd), /Invalid MCP metadata/u);
    assert.deepEqual(state(store), before);
    assert.equal(publish(store, request, cwd).published, true);
  });
});

test("admission refuses exhausted request authority without wrapping or changing any state", async () => {
  await withStore(({ store }) => {
    store.database.prepare(
      "UPDATE mcp_authority_revisions SET metadata_request_revision = ? WHERE server_id = ?",
    ).run(Number.MAX_SAFE_INTEGER, SERVER_ID);
    const before = state(store);
    assert.throws(() => begin(store), /Invalid MCP metadata/u);
    assert.deepEqual(state(store), before);
  });
});

for (const field of ["server_revision", "tools_revision"]) {
  test(`admission refuses unsafe persisted ${field} authority`, async () => {
    await withStore(({ store }) => {
      store.database.prepare(`UPDATE mcp_authority_revisions SET ${field} = ? WHERE server_id = ?`)
        .run(Number.MAX_SAFE_INTEGER + 1, SERVER_ID);
      const before = state(store);
      assert.throws(() => begin(store), /Invalid MCP metadata/u);
      assert.deepEqual(state(store), before);
    });
  });
}

for (const [label, trigger] of [
  ["catalog insert", `
    CREATE TRIGGER fail_metadata_catalog BEFORE INSERT ON mcp_tools
    WHEN NEW.raw_name = 'fault_second'
    BEGIN SELECT RAISE(ABORT, 'metadata catalog insert fault'); END;
  `],
  ["event insert", `
    CREATE TRIGGER fail_metadata_event BEFORE INSERT ON control_plane_events
    WHEN NEW.entity_id = '${SERVER_ID}'
    BEGIN SELECT RAISE(ABORT, 'metadata event insert fault'); END;
  `],
  ["replay-state update", `
    CREATE TRIGGER fail_metadata_replay BEFORE UPDATE ON control_plane_replay_state
    BEGIN SELECT RAISE(ABORT, 'metadata replay-state update fault'); END;
  `],
]) {
  test(`${label} fault rolls back snapshot, catalog, authority, event and replay; same ticket retries`, async () => {
    await withStore(({ store, open, cwd }) => {
      store.replaceMcpServerTools(SERVER_ID, [tool("previous")], NOW);
      store.upsertMcpStatusSnapshot(snapshot("Previous evidence"), NOW);
      store.appendControlPlaneEvent({
        workspaceId: DEFAULT_WORKSPACE_ID,
        cwd,
        domain: "mcp",
        entityType: "mcp_server",
        entityId: "unrelated_fixture",
        action: "fixture.seeded",
        data: {},
      }, NOW);
      const request = begin(store, "sync-tools");
      store.database.exec(trigger);
      const before = state(store);
      assert.throws(() => publish(store, request, cwd, snapshot("New evidence"),
        [tool("first_inserted"), tool("fault_second")]), /metadata .* fault/u);
      assert.deepEqual(state(store), before);
      assert.deepEqual(state(open()), before);
      store.database.exec(`DROP TRIGGER ${label === "catalog insert" ? "fail_metadata_catalog"
        : label === "event insert" ? "fail_metadata_event" : "fail_metadata_replay"};`);
      const result = publish(store, request, cwd, snapshot("Recovered evidence"), [tool("recovered")]);
      assert.equal(result.published, true);
      assert.equal(store.getMcpStatusSnapshot(SERVER_ID).message, "Recovered evidence");
      assert.deepEqual(store.listMcpTools({ serverId: SERVER_ID }).map((item) => item.rawName), ["recovered"]);
      assert.equal(state(store).events.length, before.events.length + 1);
      assert.equal(state(store).replay.latestSeq, result.event.seq);
    });
  });
}

for (const operation of ["begin", "commit"]) {
  test(`${operation} cannot roll back a caller-owned outer transaction on nested BEGIN failure`, async () => {
    await withStore(({ store, cwd }) => {
      const request = begin(store);
      store.database.exec("CREATE TABLE metadata_outer_marker (value TEXT NOT NULL); BEGIN IMMEDIATE;");
      let committed = false;
      try {
        store.database.prepare("INSERT INTO metadata_outer_marker (value) VALUES (?)").run("owned_by_caller");
        assert.throws(() => operation === "begin" ? begin(store) : publish(store, request, cwd),
          /transaction|BEGIN/iu);
        assert.equal(store.database.prepare("SELECT value FROM metadata_outer_marker").get().value, "owned_by_caller");
        store.database.exec("COMMIT;");
        committed = true;
      } finally {
        // Preserve the original assertion if a broken implementation already
        // rolled the caller's transaction back.
        if (!committed) {
          try { store.database.exec("ROLLBACK;"); } catch {}
        }
      }
      assert.equal(store.database.prepare("SELECT value FROM metadata_outer_marker").get().value, "owned_by_caller");
      assert.equal(publish(store, request, cwd).published, true);
    });
  });
}

test("real 154 to 155 reopen preserves server, catalog, tombstones, triggers and execution authority", async () => {
  await withStore(({ store, open }) => {
    store.replaceMcpServerTools(SERVER_ID, [tool("old_read")], NOW);
    store.upsertMcpStatusSnapshot(snapshot("Pre-migration evidence"), NOW);
    store.createMcpServer(serverInput({ id: "mcp_pre155_deleted" }), NOW);
    store.deleteMcpServer("mcp_pre155_deleted");
    const legacyAuthority = store.getMcpAuthorityRevision(SERVER_ID);
    const server = store.getMcpServer(SERVER_ID);
    const catalog = store.listMcpTools({ serverId: SERVER_ID });
    const status = store.getMcpStatusSnapshot(SERVER_ID);
    const oldAuthorityRows = store.database.prepare(`
      SELECT server_id, server_revision, tools_revision FROM mcp_authority_revisions ORDER BY server_id
    `).all();
    const oldTriggers = store.database.prepare(`
      SELECT name, sql FROM sqlite_schema WHERE type = 'trigger' AND name LIKE 'trg_mcp_authority_%' ORDER BY name
    `).all();
    assert.ok(oldTriggers.length >= 6);
    const old154 = store.database.prepare("SELECT * FROM schema_migrations WHERE version = 154").get();
    assert.equal(old154.name, "create_delegation_tree_v1");

    // Downgrade only this disposable fixture to the actual pre-155 table shape.
    // DROP COLUMN preserves existing rows, the old triggers and their tombstones.
    store.database.exec(`
      ALTER TABLE mcp_authority_revisions DROP COLUMN metadata_published_revision;
      ALTER TABLE mcp_authority_revisions DROP COLUMN metadata_request_revision;
      DELETE FROM schema_migrations WHERE version = 155;
    `);
    assert.deepEqual(store.database.prepare("PRAGMA table_info(mcp_authority_revisions)").all()
      .map(column => column.name), ["server_id", "server_revision", "tools_revision"]);
    store.close();
    const reopened = open();
    assert.deepEqual(reopened.getMcpServer(SERVER_ID), server);
    assert.deepEqual(reopened.getMcpStatusSnapshot(SERVER_ID), status);
    assert.deepEqual(reopened.listMcpTools({ serverId: SERVER_ID }), catalog);
    assert.deepEqual(reopened.getMcpAuthorityRevision(SERVER_ID), legacyAuthority);
    assert.deepEqual(Object.keys(reopened.getMcpAuthorityRevision(SERVER_ID)).sort(), ["serverRevision", "toolsRevision"]);
    assert.deepEqual(reopened.database.prepare(`
      SELECT server_id, server_revision, tools_revision FROM mcp_authority_revisions ORDER BY server_id
    `).all(), oldAuthorityRows);
    assert.deepEqual(reopened.database.prepare(`
      SELECT name, sql FROM sqlite_schema WHERE type = 'trigger' AND name LIKE 'trg_mcp_authority_%' ORDER BY name
    `).all(), oldTriggers);
    assert.deepEqual(reopened.database.prepare("SELECT * FROM schema_migrations WHERE version = 154").get(), old154);
    assert.deepEqual(reopened.database.prepare(`
      SELECT DISTINCT metadata_request_revision, metadata_published_revision FROM mcp_authority_revisions
    `).all().map(row => ({ ...row })), [{ metadata_request_revision: 0, metadata_published_revision: 0 }]);
    assert.deepEqual(reopened.database.prepare("SELECT version, name FROM schema_migrations WHERE version = 155")
      .all().map(row => ({ ...row })), [{ version: 155, name: "add_mcp_metadata_publication_revisions" }]);
    const beforeUpdate = reopened.getMcpAuthorityRevision(SERVER_ID);
    reopened.updateMcpServer(SERVER_ID, { enabled: false }, NOW);
    assert.equal(reopened.getMcpAuthorityRevision(SERVER_ID).serverRevision, beforeUpdate.serverRevision + 1);
    reopened.replaceMcpServerTools(SERVER_ID, [tool("post_upgrade")], NOW);
    assert.ok(reopened.getMcpAuthorityRevision(SERVER_ID).toolsRevision > beforeUpdate.toolsRevision);
  });
});

/** Run migration fault tests on real in-memory SQLite, without any global paths. */
function withOldAuthorityDatabase(body) {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
      INSERT INTO schema_migrations VALUES (154, 'create_delegation_tree_v1', '${NOW}');
      CREATE TABLE mcp_authority_revisions (
        server_id TEXT PRIMARY KEY,
        server_revision INTEGER NOT NULL DEFAULT 0 CHECK (server_revision >= 0),
        tools_revision INTEGER NOT NULL DEFAULT 0 CHECK (tools_revision >= 0)
      );
      INSERT INTO mcp_authority_revisions VALUES ('live_server', 8, 13), ('deleted_tombstone', 17, 21);
    `);
    return body(database);
  } finally {
    database.close();
  }
}

function migrationInput(database, overrides = {}) {
  return {
    database,
    hasMigration: version => Boolean(database.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(version)),
    hasColumn: (tableName, columnName) => database.prepare(`PRAGMA table_info(${tableName})`).all()
      .some(column => column.name === columnName),
    recordMigration: (version, name) => database.prepare(
      "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
    ).run(version, name, NOW),
    ...overrides,
  };
}

function migrationState(database) {
  return {
    schema: database.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name").all(),
    authority: database.prepare("SELECT * FROM mcp_authority_revisions ORDER BY server_id").all(),
    migrations: database.prepare("SELECT * FROM schema_migrations ORDER BY version").all(),
    schemaVersion: database.prepare("PRAGMA schema_version").get().schema_version,
  };
}

test("155 migration directly preserves populated 154 authority and repeats without recording twice", () => {
  withOldAuthorityDatabase(database => {
    const before = database.prepare("SELECT * FROM mcp_authority_revisions ORDER BY server_id").all();
    applyMcpMetadataMigration(migrationInput(database));
    assert.deepEqual(database.prepare(`
      SELECT server_id, server_revision, tools_revision FROM mcp_authority_revisions ORDER BY server_id
    `).all(), before);
    assert.deepEqual(database.prepare(`
      SELECT metadata_request_revision, metadata_published_revision FROM mcp_authority_revisions ORDER BY server_id
    `).all().map(row => ({ ...row })), [
      { metadata_request_revision: 0, metadata_published_revision: 0 },
      { metadata_request_revision: 0, metadata_published_revision: 0 },
    ]);
    const after = migrationState(database);
    applyMcpMetadataMigration(migrationInput(database, {
      recordMigration: () => assert.fail("155 must not be recorded twice"),
    }));
    assert.deepEqual(migrationState(database), after);
  });
});

test("155 DDL failure after the first real ALTER rolls back both schema and marker", () => {
  withOldAuthorityDatabase(database => {
    const before = migrationState(database);
    let injected = false;
    // Delegate all operations to SQLite. The failure is an actual second DDL
    // error after SQLite has successfully added the first metadata column.
    const faultDatabase = {
      prepare: database.prepare.bind(database),
      exec(sql) {
        if (sql.includes("ALTER TABLE mcp_authority_revisions ADD COLUMN metadata_request_revision")) {
          injected = true;
          database.exec(`
            ALTER TABLE mcp_authority_revisions ADD COLUMN metadata_request_revision INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE missing_metadata_fixture ADD COLUMN fail INTEGER;
          `);
        } else {
          database.exec(sql);
        }
      },
    };
    assert.throws(() => applyMcpMetadataMigration(migrationInput(database, { database: faultDatabase })),
      /no such table.*missing_metadata_fixture/u);
    assert.equal(injected, true);
    assert.deepEqual(migrationState(database), before);
    applyMcpMetadataMigration(migrationInput(database));
    assert.equal(database.prepare("SELECT name FROM schema_migrations WHERE version = 155").get().name,
      "add_mcp_metadata_publication_revisions");
  });
});

for (const phase of ["insert", "after insert"]) {
  test(`155 marker ${phase} failure leaves no half-columns and safely retries`, () => {
    withOldAuthorityDatabase(database => {
      const before = migrationState(database);
      const recordMigration = migrationInput(database).recordMigration;
      const fault = phase === "insert"
        ? (version, name) => database.prepare(
          "INSERT INTO missing_metadata_migration_marker (version, name) VALUES (?, ?)",
        ).run(version, name)
        : (version, name) => {
          recordMigration(version, name);
          throw new Error("metadata post-marker fault");
        };
      assert.throws(() => applyMcpMetadataMigration(migrationInput(database, { recordMigration: fault })),
        /missing_metadata_migration_marker|metadata post-marker fault/u);
      assert.deepEqual(migrationState(database), before);
      applyMcpMetadataMigration(migrationInput(database));
      assert.equal(database.prepare("SELECT count(*) AS count FROM schema_migrations WHERE version = 155").get().count, 1);
    });
  });
}

test("155 savepoint failure preserves the caller-owned outer transaction", () => {
  withOldAuthorityDatabase(database => {
    database.exec("CREATE TABLE migration_outer_marker (value TEXT); BEGIN IMMEDIATE;");
    let committed = false;
    try {
      database.exec("INSERT INTO migration_outer_marker VALUES ('caller_owned');");
      const before = migrationState(database);
      assert.throws(() => applyMcpMetadataMigration(migrationInput(database, {
        recordMigration: () => { throw new Error("metadata nested-marker fault"); },
      })), /metadata nested-marker fault/u);
      assert.deepEqual(migrationState(database), before);
      assert.equal(database.prepare("SELECT value FROM migration_outer_marker").get().value, "caller_owned");
      database.exec("COMMIT;");
      committed = true;
    } finally {
      if (!committed) {
        try { database.exec("ROLLBACK;"); } catch {}
      }
    }
    assert.equal(database.prepare("SELECT value FROM migration_outer_marker").get().value, "caller_owned");
    applyMcpMetadataMigration(migrationInput(database));
  });
});

for (const [label, corrupt] of [
  ["wrong version-155 name", database => database.exec(
    `INSERT INTO schema_migrations VALUES (155, 'conflicting_migration', '${NOW}');`,
  )],
  ["correct name under wrong version", database => database.exec(
    `INSERT INTO schema_migrations VALUES (153, 'add_mcp_metadata_publication_revisions', '${NOW}');`,
  )],
  ["155 marker without columns", database => database.exec(
    `INSERT INTO schema_migrations VALUES (155, 'add_mcp_metadata_publication_revisions', '${NOW}');`,
  )],
  ["unmarked request-only column", database => database.exec(
    "ALTER TABLE mcp_authority_revisions ADD COLUMN metadata_request_revision INTEGER NOT NULL DEFAULT 0;",
  )],
  ["unmarked published-only column", database => database.exec(
    "ALTER TABLE mcp_authority_revisions ADD COLUMN metadata_published_revision INTEGER NOT NULL DEFAULT 0;",
  )],
  ["unmarked both columns", database => database.exec(`
    ALTER TABLE mcp_authority_revisions ADD COLUMN metadata_request_revision INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE mcp_authority_revisions ADD COLUMN metadata_published_revision INTEGER NOT NULL DEFAULT 0;
  `)],
  ["marked request-only column", database => database.exec(`
    ALTER TABLE mcp_authority_revisions ADD COLUMN metadata_request_revision INTEGER NOT NULL DEFAULT 0;
    INSERT INTO schema_migrations VALUES (155, 'add_mcp_metadata_publication_revisions', '${NOW}');
  `)],
]) {
  test(`155 migration fails closed on ${label} without altering suspect history`, () => {
    withOldAuthorityDatabase(database => {
      corrupt(database);
      const before = migrationState(database);
      assert.throws(() => applyMcpMetadataMigration(migrationInput(database)),
        /MCP metadata migration marker conflicts/u);
      assert.deepEqual(migrationState(database), before);
    });
  });
}
