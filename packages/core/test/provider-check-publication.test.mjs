import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_WORKSPACE_ID,
  createSqliteRunStore,
  resolveStoragePaths,
} from "../dist/index.js";
import { applyProviderCheckMigration } from "../dist/storage/sqlite/provider-check-migration.js";

const NOW = "2026-10-09T02:00:00.000Z";
const SOURCES = ["manual", "startup", "model_import"];

function providerInput(overrides = {}) {
  return {
    kind: "openai-compatible",
    displayName: "Publication fixture",
    providerId: "fixture-relay",
    model: "fixture-model",
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:1/v1",
    apiKeyRef: "env:UNUSED_PROVIDER_PUBLICATION_FIXTURE_KEY",
    capabilities: ["chat", "tool_call"],
    enabled: true,
    ...overrides,
  };
}

function check(message = "Current evidence", overrides = {}) {
  return { ok: true, code: "ready", message, checkedAt: NOW, ...overrides };
}

/** No test can select the user's storage, secrets, default workspace or home. */
async function withStore(body, input = providerInput()) {
  const directory = await mkdtemp(resolve(tmpdir(), "ling-provider-check-publication-"));
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
    const provider = store.createProviderPreset(input, NOW);
    return await body({ store, open, providerId: provider.id, cwd });
  } finally {
    for (const candidate of stores.reverse()) {
      if (candidate.database.isOpen) candidate.close();
    }
    await rm(directory, { recursive: true, force: true });
  }
}

function begin(store, providerId, source = "manual", pendingCheck) {
  const request = store.beginProviderCheckRequest(providerId, source, pendingCheck);
  assert.ok(request, "Existing fixture provider must admit a check request");
  assert.equal(request.provider.id, providerId);
  assert.equal(request.ticket.providerId, providerId);
  assert.equal(request.ticket.source, source);
  return request;
}

function publish(store, request, cwd, result = check()) {
  return store.commitProviderCheckResult(request.ticket, result, cwd);
}

/** A rejected or failed publication must preserve all durable state. */
function state(store, providerId) {
  return {
    provider: store.getProviderPreset(providerId),
    authority: store.getProviderCheckAuthority(providerId),
    authorityRows: store.database.prepare("SELECT * FROM provider_check_authorities ORDER BY provider_id").all(),
    events: store.listControlPlaneEvents({ workspaceId: DEFAULT_WORKSPACE_ID }),
    replay: store.getControlPlaneReplayState(DEFAULT_WORKSPACE_ID),
  };
}

function assertRejected(store, request, cwd, providerId, status, result = check("Obsolete evidence")) {
  const before = state(store, providerId);
  assert.equal(publish(store, request, cwd, result).status, status);
  assert.deepEqual(state(store, providerId), before);
}

test("provider check admission captures durable authority without changing configuration", async () => {
  await withStore(({ store, providerId }) => {
    const before = store.getProviderCheckAuthority(providerId);
    assert.deepEqual(Object.keys(before).sort(), ["configRevision", "publishedRevision", "requestRevision"]);
    assert.ok(Number.isSafeInteger(before.configRevision) && before.configRevision > 0);
    assert.equal(before.requestRevision, 0);
    assert.equal(before.publishedRevision, 0);
    const request = begin(store, providerId);
    assert.deepEqual(Object.keys(request.ticket).sort(), ["configRevision", "providerId", "requestRevision", "source"]);
    assert.equal(request.ticket.configRevision, before.configRevision);
    assert.equal(request.ticket.requestRevision, 1);
    assert.deepEqual(store.getProviderCheckAuthority(providerId), { ...before, requestRevision: 1 });
    assert.equal(store.beginProviderCheckRequest("missing-provider", "manual"), undefined);
    assert.equal(store.getProviderCheckAuthority("missing-provider"), undefined);
  });
});

for (const olderSource of SOURCES) {
  for (const newerSource of SOURCES) {
    test(`latest admitted ${newerSource} supersedes pending ${olderSource} across SQLite connections`, async () => {
      await withStore(({ store, open, providerId, cwd }) => {
        const other = open();
        const earlier = begin(store, providerId, olderSource);
        const later = begin(other, providerId, newerSource);
        assert.ok(later.ticket.requestRevision > earlier.ticket.requestRevision);
        assertRejected(store, earlier, cwd, providerId, "superseded");
        const current = publish(other, later, cwd, check("Latest admitted evidence"));
        assert.equal(current.status, "published");
        assert.equal(current.provider.lastCheck.message, "Latest admitted evidence");
        assert.deepEqual(store.getProviderPreset(providerId), current.provider);
        assert.equal(current.event.action, "provider.preflight_checked");
        assert.equal(current.event.entityId, providerId);
        assert.equal(current.event.cwd, cwd);
        assert.equal(current.event.data.source, newerSource);
        assert.equal(state(store, providerId).events.length, 1);
        assert.equal(state(store, providerId).replay.latestSeq, current.event.seq);
        assertRejected(store, earlier, cwd, providerId, "superseded");
        assertRejected(other, later, cwd, providerId, "already_published");
      });
    });
  }
}

test("a newer failed check remains authoritative over an older successful check", async () => {
  await withStore(({ store, providerId, cwd }) => {
    const earlier = begin(store, providerId, "manual");
    const later = begin(store, providerId, "startup");
    const failed = check("Latest request failed", { ok: false, code: "fixture_unreachable" });
    const current = publish(store, later, cwd, failed);
    assert.equal(current.status, "published");
    assert.deepEqual(current.provider.lastCheck, failed);
    assertRejected(store, earlier, cwd, providerId, "superseded");
  });
});

test("pending evidence is installed during admission without invalidating its own ticket", async () => {
  await withStore(({ store, providerId, cwd }) => {
    const original = publish(store, begin(store, providerId), cwd, check("Previous evidence"));
    assert.equal(original.status, "published");
    const configRevision = store.getProviderCheckAuthority(providerId).configRevision;
    const pending = check("Waiting for imported model check", { ok: false, code: "preflight_pending" });
    const request = begin(store, providerId, "model_import", pending);
    assert.deepEqual(request.provider.lastCheck, pending);
    assert.deepEqual(store.getProviderPreset(providerId).lastCheck, pending);
    assert.equal(request.ticket.configRevision, configRevision);
    assert.equal(store.getProviderCheckAuthority(providerId).configRevision, configRevision);
    const current = publish(store, request, cwd, check("Imported model ready"));
    assert.equal(current.status, "published");
    assert.equal(current.provider.lastCheck.message, "Imported model ready");
    assert.equal(state(store, providerId).events.length, 2);
  });
});

test("every provider configuration update invalidates an older ticket at the same timestamp", async () => {
  await withStore(({ store, providerId, cwd }) => {
    const changes = [
      { displayName: "Changed display name" },
      { kind: "openai" },
      { providerId: "changed-relay" },
      { model: "changed-model" },
      { api: "openai-responses" },
      { providerTransport: "sse" },
      { baseUrl: "http://127.0.0.1:2/v1" },
      { apiKeyRef: "env:OTHER_UNUSED_FIXTURE_KEY" },
      { headers: { "x-fixture-header": "changed" } },
      { secretHeaderRefs: { "x-fixture-secret": "env:UNUSED_HEADER_KEY" } },
      { authHeader: false },
      { reasoning: true },
      { thinkingModes: ["low"] },
      { input: ["text", "image"] },
      { contextWindow: 16000 },
      { maxTokens: 1000 },
      { compat: { fixture: true } },
      { capabilities: ["chat"] },
      { enabled: false },
    ];
    for (const change of changes) {
      const request = begin(store, providerId);
      const updated = store.updateProviderPreset(providerId, change, NOW);
      assert.equal(updated.updatedAt, request.provider.updatedAt, JSON.stringify(change));
      assert.ok(store.getProviderCheckAuthority(providerId).configRevision > request.ticket.configRevision,
        JSON.stringify(change));
      assert.equal(updated.lastCheck, undefined);
      assertRejected(store, request, cwd, providerId, "config_changed");
    }
  });
});

test("config_changed takes precedence when both configuration and request generation changed", async () => {
  await withStore(({ store, providerId, cwd }) => {
    const earlier = begin(store, providerId);
    store.updateProviderPreset(providerId, { model: "fixture-model-B" }, NOW);
    const later = begin(store, providerId, "startup");
    assertRejected(store, earlier, cwd, providerId, "config_changed");
    assert.equal(publish(store, later, cwd).status, "published");
  });
});

test("same-timestamp configuration A to B to A cannot resurrect A's original authority", async () => {
  await withStore(({ store, providerId, cwd }) => {
    const request = begin(store, providerId);
    store.updateProviderPreset(providerId, { model: "fixture-model-B" }, NOW);
    store.updateProviderPreset(providerId, { model: request.provider.model }, NOW);
    assert.equal(store.getProviderPreset(providerId).model, request.provider.model);
    assert.equal(store.getProviderPreset(providerId).updatedAt, request.provider.updatedAt);
    assertRejected(store, request, cwd, providerId, "config_changed");
    assert.equal(publish(store, begin(store, providerId), cwd).status, "published");
  });
});

test("direct SQL update also invalidates same-timestamp pending provider checks", async () => {
  await withStore(({ store, providerId, cwd }) => {
    const request = begin(store, providerId);
    store.database.prepare("UPDATE provider_presets SET model = ? WHERE id = ?")
      .run("SQL-updated-model", providerId);
    assertRejected(store, request, cwd, providerId, "config_changed");
  });
});

test("deleted provider rejects publication without recreating its check or durable event", async () => {
  await withStore(({ store, providerId, cwd }) => {
    const request = begin(store, providerId);
    assert.equal(store.deleteProviderPreset(providerId), true);
    assertRejected(store, request, cwd, providerId, "deleted");
    assert.equal(store.getProviderPreset(providerId), undefined);
    assert.equal(store.beginProviderCheckRequest(providerId, "manual"), undefined);
  });
});

test("SQL delete and reinsert of the same provider ID keeps the tombstone and rejects ABA", async () => {
  await withStore(({ store, providerId, cwd }) => {
    const request = begin(store, providerId);
    const row = store.database.prepare("SELECT * FROM provider_presets WHERE id = ?").get(providerId);
    const columns = Object.keys(row);
    store.database.prepare("DELETE FROM provider_presets WHERE id = ?").run(providerId);
    store.database.prepare(`INSERT INTO provider_presets (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
      .run(...columns.map(column => row[column]));
    assert.deepEqual(store.getProviderPreset(providerId), request.provider);
    assert.ok(store.getProviderCheckAuthority(providerId).configRevision > request.ticket.configRevision);
    assertRejected(store, request, cwd, providerId, "config_changed");
    assert.ok(begin(store, providerId).ticket.requestRevision > request.ticket.requestRevision);
  });
});

test("disabled provider remains checkable and published results do not change config revision", async () => {
  await withStore(({ store, providerId, cwd }) => {
    const request = begin(store, providerId);
    const disabled = check("Provider disabled", { ok: false, code: "disabled" });
    const current = publish(store, request, cwd, disabled);
    assert.equal(current.status, "published");
    assert.equal(current.provider.enabled, false);
    assert.deepEqual(current.provider.lastCheck, disabled);
    assert.equal(store.getProviderCheckAuthority(providerId).configRevision, request.ticket.configRevision);
    assert.equal(store.getProviderCheckAuthority(providerId).publishedRevision, request.ticket.requestRevision);
  }, providerInput({ enabled: false }));
});

for (const operation of ["set", "delete"]) {
  test(`local secret ${operation} invalidates owner and shared key/header consumers without relying on timestamps`, async () => {
    await withStore(({ store, providerId, cwd }) => {
      store.updateProviderPreset(providerId, { apiKeyRef: `local:${providerId}` }, NOW);
      store.setProviderSecret(providerId, "fixture-secret-A-not-real", NOW);
      const keyConsumer = store.createProviderPreset(providerInput({
        displayName: "Shared local key fixture", apiKeyRef: `local:${providerId}`,
      }), NOW);
      const headerConsumer = store.createProviderPreset(providerInput({
        displayName: "Shared local header fixture",
        secretHeaderRefs: { "x-fixture-secret": `local:${providerId}` },
      }), NOW);
      const ids = [providerId, keyConsumer.id, headerConsumer.id];
      for (const id of ids) {
        assert.equal(publish(store, begin(store, id), cwd, check("Pre-rotation evidence")).status, "published");
      }
      const requests = ids.map(id => begin(store, id));
      if (operation === "set") store.setProviderSecret(providerId, "fixture-secret-B-not-real", NOW);
      else assert.equal(store.deleteProviderSecret(providerId), true);
      for (let index = 0; index < ids.length; index += 1) {
        assert.equal(store.getProviderPreset(ids[index]).lastCheck, undefined);
        assert.ok(store.getProviderCheckAuthority(ids[index]).configRevision > requests[index].ticket.configRevision);
        assertRejected(store, requests[index], cwd, ids[index], "config_changed");
      }
    });
  });
}

test("restart preserves admitted authority and successful publication can happen only once", async () => {
  await withStore(({ store, open, providerId, cwd }) => {
    const request = begin(store, providerId, "startup");
    const admitted = store.getProviderCheckAuthority(providerId);
    store.close();
    const reopened = open();
    assert.deepEqual(reopened.getProviderCheckAuthority(providerId), admitted);
    assert.equal(publish(reopened, request, cwd).status, "published");
    const committed = state(reopened, providerId);
    reopened.close();
    const restarted = open();
    assert.deepEqual(state(restarted, providerId), committed);
    assertRejected(restarted, request, cwd, providerId, "already_published");
  });
});

for (const [label, triggerName, trigger] of [
  ["check row update", "fail_provider_check_row", `
    CREATE TRIGGER fail_provider_check_row BEFORE UPDATE OF last_check_json ON provider_presets
    BEGIN SELECT RAISE(ABORT, 'provider check row fault'); END;
  `],
  ["event insert", "fail_provider_check_event", `
    CREATE TRIGGER fail_provider_check_event BEFORE INSERT ON control_plane_events
    WHEN NEW.action = 'provider.preflight_checked'
    BEGIN SELECT RAISE(ABORT, 'provider check event fault'); END;
  `],
  ["replay-state update", "fail_provider_check_replay", `
    CREATE TRIGGER fail_provider_check_replay BEFORE UPDATE ON control_plane_replay_state
    BEGIN SELECT RAISE(ABORT, 'provider check replay fault'); END;
  `],
]) {
  test(`${label} fault rolls back check, ticket consumption, durable event and replay; same ticket retries`, async () => {
    await withStore(({ store, open, providerId, cwd }) => {
      assert.equal(publish(store, begin(store, providerId), cwd, check("Previous evidence")).status, "published");
      const request = begin(store, providerId, "model_import");
      store.database.exec(trigger);
      const before = state(store, providerId);
      assert.throws(() => publish(store, request, cwd, check("Faulted evidence")), /provider check .* fault/u);
      assert.deepEqual(state(store, providerId), before);
      assert.deepEqual(state(open(), providerId), before);
      store.database.exec(`DROP TRIGGER ${triggerName};`);
      const recovered = publish(store, request, cwd, check("Recovered evidence"));
      assert.equal(recovered.status, "published");
      assert.equal(recovered.provider.lastCheck.message, "Recovered evidence");
      assert.equal(state(store, providerId).events.length, before.events.length + 1);
      assert.equal(state(store, providerId).replay.latestSeq, recovered.event.seq);
      assertRejected(store, request, cwd, providerId, "already_published");
    });
  });
}

test("invalid request source is rejected before changing authority or pending evidence", async () => {
  await withStore(({ store, providerId }) => {
    const before = state(store, providerId);
    for (const source of ["unknown", "", undefined, null, 1]) {
      assert.throws(() => store.beginProviderCheckRequest(providerId, source, check("Untrusted pending")), TypeError);
      assert.deepEqual(state(store, providerId), before);
    }
  });
});

test("invalid ticket revisions cannot publish or consume admitted authority", async () => {
  await withStore(({ store, providerId, cwd }) => {
    const request = begin(store, providerId);
    const before = state(store, providerId);
    for (const field of ["configRevision", "requestRevision"]) {
      for (const value of [-1, 0, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "1"]) {
        assert.throws(() => store.commitProviderCheckResult({ ...request.ticket, [field]: value }, check(), cwd), TypeError);
        assert.deepEqual(state(store, providerId), before);
      }
    }
    assert.equal(publish(store, request, cwd).status, "published");
  });
});

for (const operation of ["begin", "commit"]) {
  test(`${operation} does not roll back a caller-owned outer transaction when nested BEGIN is refused`, async () => {
    await withStore(({ store, providerId, cwd }) => {
      const request = begin(store, providerId);
      store.database.exec("CREATE TABLE provider_outer_marker (value TEXT NOT NULL); BEGIN IMMEDIATE;");
      let committed = false;
      try {
        store.database.prepare("INSERT INTO provider_outer_marker (value) VALUES (?)").run("owned_by_caller");
        assert.throws(() => operation === "begin" ? begin(store, providerId) : publish(store, request, cwd), /transaction|BEGIN/iu);
        assert.equal(store.database.prepare("SELECT value FROM provider_outer_marker").get().value, "owned_by_caller");
        store.database.exec("COMMIT;");
        committed = true;
      } finally {
        if (!committed) {
          try { store.database.exec("ROLLBACK;"); } catch {}
        }
      }
      assert.equal(store.database.prepare("SELECT value FROM provider_outer_marker").get().value, "owned_by_caller");
      assert.equal(publish(store, request, cwd).status, "published");
    });
  });
}

test("enumeration-valid ticket source tampering is rejected without publication or consumption", async () => {
  await withStore(({ store, providerId, cwd }) => {
    const request = begin(store, providerId, "startup");
    const before = state(store, providerId);
    assert.throws(() => store.commitProviderCheckResult({ ...request.ticket, source: "manual" }, check(), cwd), TypeError);
    assert.deepEqual(state(store, providerId), before);
    const current = publish(store, request, cwd);
    assert.equal(current.status, "published");
    assert.equal(current.event.data.source, "startup");
  });
});

function verifyMarkedMigration(store) {
  applyProviderCheckMigration({
    database: store.database,
    hasMigration: version => Boolean(store.database.prepare("SELECT version FROM schema_migrations WHERE version = ?").get(version)),
    recordMigration: () => { throw new Error("A marked migration must not rewrite history."); },
  });
}

test("marked provider migration refuses equal-name no-op trigger drift", async () => {
  await withStore(({ store }) => {
    store.database.exec(`
      DROP TRIGGER provider_check_update;
      CREATE TRIGGER provider_check_update AFTER UPDATE ON provider_presets BEGIN SELECT 1; END;
    `);
    const before = store.database.prepare("SELECT name, type, sql FROM sqlite_schema ORDER BY name").all();
    assert.throws(() => verifyMarkedMigration(store), /Provider check migration/iu);
    assert.deepEqual(store.database.prepare("SELECT name, type, sql FROM sqlite_schema ORDER BY name").all(), before);
  });
});

test("marked provider migration refuses required-column drift even when all object names remain", async () => {
  await withStore(({ store }) => {
    store.database.exec("ALTER TABLE provider_check_authorities RENAME COLUMN config_revision TO lost_config_revision;");
    const before = store.database.prepare("SELECT name, type, sql FROM sqlite_schema ORDER BY name").all();
    assert.throws(() => verifyMarkedMigration(store), /Provider check migration/iu);
    assert.deepEqual(store.database.prepare("SELECT name, type, sql FROM sqlite_schema ORDER BY name").all(), before);
  });
});

test("local secret ownership move invalidates both old and new consumers", async () => {
  await withStore(({ store, providerId, cwd }) => {
    store.updateProviderPreset(providerId, { apiKeyRef: `local:${providerId}` }, NOW);
    store.setProviderSecret(providerId, "fixture-moved-secret-not-real", NOW);
    const other = store.createProviderPreset(providerInput({ displayName: "New local secret owner" }), NOW);
    store.updateProviderPreset(other.id, { apiKeyRef: `local:${other.id}` }, NOW);
    const ids = [providerId, other.id];
    const requests = ids.map(id => begin(store, id));
    store.database.prepare("UPDATE provider_secrets SET provider_id = ? WHERE provider_id = ?")
      .run(other.id, providerId);
    assert.equal(store.hasProviderSecret(providerId), false);
    assert.equal(store.hasProviderSecret(other.id), true);
    for (let index = 0; index < ids.length; index += 1) {
      assert.ok(store.getProviderCheckAuthority(ids[index]).configRevision > requests[index].ticket.configRevision,
        "Both the old credential consumer and the new consumer must lose check authority.");
      assertRejected(store, requests[index], cwd, ids[index], "config_changed");
    }
  });
});

test("exhausted provider request authority is refused without wraparound or pending writes", async () => {
  await withStore(({ store, providerId }) => {
    store.database.prepare("UPDATE provider_check_authorities SET request_revision = ? WHERE provider_id = ?")
      .run(Number.MAX_SAFE_INTEGER, providerId);
    const before = state(store, providerId);
    assert.throws(() => begin(store, providerId, "startup", check("Must not become pending")), /exhausted|authority/iu);
    assert.deepEqual(state(store, providerId), before);
  });
});

test("exhausted provider config authority rolls back a configuration mutation instead of wrapping", async () => {
  await withStore(({ store, providerId }) => {
    store.database.prepare("UPDATE provider_check_authorities SET config_revision = ? WHERE provider_id = ?")
      .run(Number.MAX_SAFE_INTEGER, providerId);
    const before = state(store, providerId);
    assert.throws(() => store.updateProviderPreset(providerId, { model: "Must-not-persist" }, NOW), /CHECK constraint|exhausted/iu);
    assert.deepEqual(state(store, providerId), before);
  });
});
