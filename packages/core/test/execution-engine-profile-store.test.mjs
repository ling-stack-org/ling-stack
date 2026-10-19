import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { resolveUserConfigPaths } from "../dist/runtime-paths.js";
import { ExecutionEngineProfileStore } from "../dist/storage/execution-engine-profile-store.js";

const draft = () => ({
  engineId: "codex-app-server",
  executablePath: process.execPath,
  authProfileId: "auth_fixture",
});

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "ling-engine-profile-"));
  const paths = resolveUserConfigPaths({ userRootDir: root });
  const store = new ExecutionEngineProfileStore(paths);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { store, paths };
}

test("profile preparation runs inside revision/reference fences and rolls back failed saves", (t) => {
  const { store } = fixture(t);
  let prepared = 0;
  const prepare = () => { prepared++; throw new Error("synthetic-storage-failure"); };
  assert.throws(() => store.save(draft(), 0, prepare), /synthetic-storage-failure/);
  assert.equal(prepared, 1);
  assert.equal(store.get("codex-app-server"), undefined);
  const first = store.save(draft(), 0);
  assert.throws(() => store.save({ ...draft(), authProfileId: "changed" }, 0, prepare), { code: "profile_revision_conflict" });
  assert.equal(prepared, 1);
  store.retainReference("codex-app-server", 1, { workspaceId: "saved-workspace", referenceId: "thread" });
  assert.throws(() => store.save({ ...draft(), authProfileId: "changed" }, 1, prepare), { code: "profile_in_use" });
  assert.equal(prepared, 1);
  assert.deepEqual(store.get("codex-app-server"), first);
});

test("host profiles persist with stable ids, revisions and no implicit activation", (t) => {
  const { store, paths } = fixture(t);
  assert.deepEqual(store.list(), []);
  const first = store.save(draft(), 0);
  assert.equal(first.revision, 1);
  assert.equal(first.status, "configured");
  assert.deepEqual(first.configuration, draft());
  const secondStore = new ExecutionEngineProfileStore(paths);
  try {
    assert.deepEqual(secondStore.get("codex-app-server"), first);
    const second = secondStore.save({ ...draft(), authProfileId: "auth_other" }, 1);
    assert.equal(second.id, first.id);
    assert.equal(second.revision, 2);
    assert.notEqual(second.configurationFingerprint, first.configurationFingerprint);
    assert.equal(second.status, "configured");
    assert.equal(Object.hasOwn(second, "enabled"), false);
    assert.equal(Object.hasOwn(second, "readinessPassed"), false);
  } finally {
    secondStore.close();
  }
});

test("switching Codex or Kimi authentication allocates a fresh native identity without changing the engine profile", (t) => {
  const { store, paths } = fixture(t);
  for (const engineId of ["codex-app-server", "kimi-acp"]) {
    const account = store.save({ ...draft(), engineId }, 0);
    const keyed = store.save({ ...account.configuration, secretRef: "env:OWNED_KEY" }, account.revision);
    assert.notEqual(keyed.configuration.authProfileId, account.configuration.authProfileId);
    assert.equal(keyed.id, account.id);
    assert.equal(keyed.configuration.secretRef, "env:OWNED_KEY");
    const changedPath = store.save({ ...keyed.configuration, executablePath: join(paths.rootDir, "another-executable") }, keyed.revision);
    assert.equal(changedPath.configuration.authProfileId, keyed.configuration.authProfileId, "ordinary edits retain the selected auth identity");
    const accountAgain = store.save({ ...changedPath.configuration, secretRef: undefined }, changedPath.revision);
    assert.notEqual(accountAgain.configuration.authProfileId, keyed.configuration.authProfileId);
    assert.notEqual(accountAgain.configuration.authProfileId, account.configuration.authProfileId, "switching back cannot resurrect a prior account");
    assert.equal(accountAgain.id, account.id);
    assert.deepEqual(store.save(accountAgain.configuration, accountAgain.revision), accountAgain, "unchanged saves are idempotent");
    assert.throws(() => store.save(keyed.configuration, changedPath.revision), { code: "profile_revision_conflict" });
    assert.deepEqual(store.get(engineId), accountAgain);
  }
});

test("two writers using the same revision cannot overwrite each other", (t) => {
  const { store, paths } = fixture(t);
  const other = new ExecutionEngineProfileStore(paths);
  try {
    const first = store.save(draft(), 0);
    assert.throws(() => other.save({ ...draft(), authProfileId: "auth_lost" }, 0), { code: "profile_revision_conflict" });
    assert.deepEqual(other.get(draft().engineId), first);
    const updated = other.save({ ...draft(), authProfileId: "auth_other" }, 1);
    assert.throws(() => store.save(draft(), 1), { code: "profile_revision_conflict" });
    assert.deepEqual(store.get(draft().engineId), updated);
  } finally {
    other.close();
  }
});

test("disconnect retains configuration and revision; stale forms cannot recreate it", (t) => {
  const { store } = fixture(t);
  const first = store.save(draft(), 0);
  const disconnected = store.disconnect(draft().engineId, 1);
  assert.equal(disconnected.status, "disconnected");
  assert.equal(disconnected.revision, 2);
  assert.equal(disconnected.id, first.id);
  assert.deepEqual(disconnected.configuration, draft());
  assert.throws(() => store.save(draft(), 1), { code: "profile_revision_conflict" });
  assert.throws(() => store.disconnect(draft().engineId, 1), { code: "profile_revision_conflict" });
  const restored = store.save(draft(), 2);
  assert.equal(restored.id, first.id);
  assert.equal(restored.revision, 3);
  assert.equal(restored.status, "configured");
});

test("invalid input cannot store raw secrets, shell strings or verification claims", (t) => {
  const { store } = fixture(t);
  for (const patch of [
    { engineId: "pi" }, { engineId: "unknown" }, { executablePath: "codex" },
    { executablePath: `${process.execPath}\n--run` }, { authProfileId: "../../native" },
    { apiKey: "sensitive-fixture" }, { env: { API_KEY: "sensitive-fixture" } },
    { args: ["--dangerously-skip-permissions"] }, { readinessPassed: true },
    { secretRef: "sensitive-fixture" }, { openclaw: { gatewayUrl: "wss://example.com" } },
  ]) {
    assert.throws(() => store.save({ ...draft(), ...patch }, 0), (error) => error.code === "profile_invalid" && !error.message.includes("sensitive-fixture"));
  }
  for (const revision of [-1, 0.5, undefined, Number.NaN]) {
    assert.throws(() => store.save(draft(), revision), { code: "profile_invalid" });
  }
  assert.deepEqual(store.list(), []);
  assert.equal(store.save({ ...draft(), secretRef: "keychain:ling-engine@example.com" }, 0).configuration.secretRef, "keychain:ling-engine@example.com");
});

test("OpenClaw stores only an explicit existing connection and secret reference", (t) => {
  const { store } = fixture(t);
  const profile = {
    ...draft(),
    engineId: "openclaw-acp",
    secretRef: "keychain:ling-openclaw-fixture",
    openclaw: { gatewayUrl: "wss://example.com/bridge", agentId: "fixture" },
  };
  assert.deepEqual(store.save(profile, 0).configuration, profile);
  for (const openclaw of [
    undefined,
    { gatewayUrl: "wss://user:password@example.com", agentId: "fixture" },
    { gatewayUrl: "wss://example.com/?token=sensitive-fixture", agentId: "fixture" },
    { gatewayUrl: "ws://example.com", agentId: "fixture" },
    { gatewayUrl: "wss://example.com", agentId: "" },
    { gatewayUrl: "wss://example.com", agentId: "with.dot" },
    { gatewayUrl: "wss://example.com", agentId: "a".repeat(65) },
    { gatewayUrl: "wss://example.com", agentId: "fixture", autoStartGateway: true },
    { gatewayUrl: "wss://example.com", agentId: "fixture", sessionKey: "shared-main" },
  ]) {
    assert.throws(() => store.save({ ...profile, openclaw }, 1), { code: "profile_invalid" });
  }
  assert.equal(store.get(profile.engineId).revision, 1);
});

test("OpenClaw profile Agent ids use the same canonical form as persistent session routing", (t) => {
  const { store } = fixture(t);
  const saved = store.save({
    ...draft(),
    engineId: "openclaw-acp",
    secretRef: "env:OPENCLAW_KEY",
    openclaw: { gatewayUrl: "wss://example.com", agentId: "Existing_Agent" },
  }, 0);
  assert.equal(saved.configuration.openclaw.agentId, "existing_agent");
});

test("OpenClaw credential type is saved and revisioned without accepting credentials or session controls", (t) => {
  const { store, paths } = fixture(t);
  const configuration = { ...draft(), engineId: "openclaw-acp", secretRef: "env:OPENCLAW_KEY",
    openclaw: { gatewayUrl: "wss://gateway.example.test", agentId: "existing", credentialType: "password" } };
  const saved = store.save(configuration, 0);
  const other = new ExecutionEngineProfileStore(paths);
  try {
    assert.deepEqual(other.get("openclaw-acp"), saved);
    assert.deepEqual(store.save(configuration, 1), saved);
    const changed = other.save({ ...configuration, openclaw: { ...configuration.openclaw, credentialType: "token" } }, 1);
    assert.equal(changed.revision, 2);
    assert.notEqual(changed.configurationFingerprint, saved.configurationFingerprint);
    for (const credentialType of ["oauth", null, " token", { token: "private" }]) {
      assert.throws(() => store.save({ ...configuration, openclaw: { ...configuration.openclaw, credentialType } }, 2), { code: "profile_invalid" });
    }
    store.retainReference("openclaw-acp", 2, { workspaceId: "workspace", referenceId: "chat" });
    assert.throws(() => store.save(configuration, 2), { code: "profile_in_use" });
  } finally { other.close(); }
});

test("Kimi terminal region is explicit, persists and cannot be mixed with other engines or API keys", (t) => {
  const { store, paths } = fixture(t);
  const configuration = { ...draft(), engineId: "kimi-acp", kimiLoginRegion: "global" };
  const saved = store.save(configuration, 0);
  const other = new ExecutionEngineProfileStore(paths);
  try {
    assert.deepEqual(other.get("kimi-acp"), saved);
    assert.deepEqual(store.save(configuration, 1), saved);
    const changed = other.save({ ...configuration, kimiLoginRegion: "mainland-cn" }, 1);
    assert.equal(changed.revision, 2);
    assert.notEqual(changed.configurationFingerprint, saved.configurationFingerprint);
    assert.throws(() => store.save(configuration, 1), { code: "profile_revision_conflict" });
    for (const patch of [{ kimiLoginRegion: "elsewhere" }, { kimiLoginRegion: " global" },
      { kimiLoginRegion: null }, { engineId: "codex-app-server" }, { secretRef: "env:KEY" }]) {
      assert.throws(() => store.save({ ...configuration, ...patch }, 2), { code: "profile_invalid" });
    }
    store.retainReference("kimi-acp", 2, { workspaceId: "workspace", referenceId: "chat" });
    assert.throws(() => store.save(configuration, 2), { code: "profile_in_use" });
  } finally { other.close(); }
});

test("Kimi native key configuration persists without a raw key and fences model/endpoint changes", (t) => {
  const { store, paths } = fixture(t);
  const configuration = { ...draft(), engineId: "kimi-acp", secretRef: "env:KIMI_FIXTURE_KEY",
    kimi: { providerType: "kimi", baseUrl: "https://api.moonshot.ai/v1", modelId: "kimi-fixture", maxContextSize: 262144 } };
  const saved = store.save(configuration, 0);
  const other = new ExecutionEngineProfileStore(paths);
  try {
    assert.deepEqual(other.get("kimi-acp"), saved);
    assert.deepEqual(store.save(configuration, 1), saved);
    const updated = other.save({ ...configuration, kimi: { ...configuration.kimi, modelId: "kimi-fixture-next" } }, 1);
    assert.equal(updated.revision, 2);
    assert.notEqual(updated.configurationFingerprint, saved.configurationFingerprint);
    assert.throws(() => store.save(configuration, 1), { code: "profile_revision_conflict" });
    store.retainReference("kimi-acp", 2, { workspaceId: "workspace", referenceId: "conversation" });
    assert.throws(() => store.save(configuration, 2), { code: "profile_in_use" });
  } finally { other.close(); }
});

test("Kimi configuration rejects secret-bearing or ambiguous fields and preserves legacy profiles", (t) => {
  const { store } = fixture(t);
  const base = { ...draft(), engineId: "kimi-acp", secretRef: "env:KIMI_KEY_FIXTURE" };
  const kimi = { providerType: "kimi", baseUrl: "https://api.moonshot.ai/v1", modelId: "explicit-model", maxContextSize: 262144 };
  const legacy = store.save(base, 0);
  assert.deepEqual(store.get("kimi-acp"), legacy);
  for (const patch of [
    { providerType: "shell" }, { providerType: null }, { modelId: "" }, { modelId: " model " }, { modelId: "x\ny" },
    { baseUrl: "file:///tmp/config" }, { baseUrl: "https://user:private-fixture@example.com" },
    { baseUrl: "https://example.com/?key=private-fixture" }, { baseUrl: "https://example.com/#private-fixture" },
    { baseUrl: " https://example.com" }, { baseUrl: "not-a-url" }, { maxContextSize: 0 }, { maxContextSize: -1 },
    { maxContextSize: "262144" }, { maxContextSize: 0.5 }, { maxContextSize: Number.MAX_SAFE_INTEGER + 1 },
    { apiKey: "private-fixture" }, { env: {} }, { hooks: [] },
  ]) {
    assert.throws(() => store.save({ ...base, kimi: { ...kimi, ...patch } }, 1),
      error => error.code === "profile_invalid" && !error.message.includes("private-fixture"));
  }
  for (const configuration of [{ ...base, secretRef: undefined, kimi }, { ...base, engineId: "codex-app-server", kimi }]) {
    assert.throws(() => store.save(configuration, 1), { code: "profile_invalid" });
  }
  assert.deepEqual(store.get("kimi-acp"), legacy);
});

test("database write failure rolls back the profile and leaves later repair possible", (t) => {
  const { store, paths } = fixture(t);
  const first = store.save(draft(), 0);
  const database = new DatabaseSync(paths.globalDatabasePath);
  try {
    database.exec("CREATE TRIGGER reject_engine_update BEFORE UPDATE ON execution_engine_profiles BEGIN SELECT RAISE(ABORT, 'injected_write_failure'); END;");
    assert.throws(() => store.save({ ...draft(), authProfileId: "auth_other" }, 1), /injected_write_failure/);
    assert.deepEqual(store.get(draft().engineId), first);
    database.exec("DROP TRIGGER reject_engine_update");
    assert.equal(store.save({ ...draft(), authProfileId: "auth_other" }, 1).revision, 2);
  } finally {
    database.close();
  }
});

test("malformed stored configuration is rejected without exposing its contents", (t) => {
  const { store, paths } = fixture(t);
  store.save(draft(), 0);
  const database = new DatabaseSync(paths.globalDatabasePath);
  try {
    database.prepare("UPDATE execution_engine_profiles SET configuration_json = ?").run('{"apiKey":"sensitive-fixture"');
    assert.throws(() => store.get(draft().engineId), (error) => error.code === "profile_store_invalid" && !error.message.includes("sensitive-fixture"));
    assert.throws(() => store.list(), { code: "profile_store_invalid" });
  } finally {
    database.close();
  }
});

test("durable cross-workspace references fence profile changes and disconnects", (t) => {
  const { store, paths } = fixture(t);
  const first = store.save(draft(), 0);
  const archived = { workspaceId: "archived-workspace", referenceId: "conversation-old" };
  const pending = { workspaceId: "other-workspace", referenceId: "submission-pending" };
  store.retainReference(draft().engineId, first.revision, archived);
  store.retainReference(draft().engineId, first.revision, archived);
  const other = new ExecutionEngineProfileStore(paths);
  try {
    other.retainReference(draft().engineId, first.revision, pending);
    assert.equal(other.listReferences(draft().engineId).length, 2);
    assert.throws(() => other.save({ ...draft(), authProfileId: "new-account" }, 1), { code: "profile_in_use" });
    assert.throws(() => other.disconnect(draft().engineId, 1), { code: "profile_in_use" });
    assert.deepEqual(other.save(draft(), 1), first);
    store.releaseReference(draft().engineId, 1, archived);
    assert.throws(() => other.disconnect(draft().engineId, 1), { code: "profile_in_use" });
    other.releaseReference(draft().engineId, 1, pending);
    assert.equal(store.disconnect(draft().engineId, 1).status, "disconnected");
  } finally {
    other.close();
  }
});

test("reference reservation and configuration edits serialize on the same database", (t) => {
  const { store, paths } = fixture(t);
  const other = new ExecutionEngineProfileStore(paths);
  const reference = { workspaceId: "fixture-workspace", referenceId: "first-submission" };
  try {
    store.save(draft(), 0);
    other.save({ ...draft(), authProfileId: "new-account" }, 1);
    assert.throws(() => store.retainReference(draft().engineId, 1, reference), { code: "profile_revision_conflict" });
    assert.deepEqual(store.listReferences(draft().engineId), []);
    store.retainReference(draft().engineId, 2, reference);
    assert.throws(() => other.save(draft(), 2), { code: "profile_in_use" });
    assert.throws(() => store.releaseReference(draft().engineId, 1, reference), { code: "profile_revision_conflict" });
    store.releaseReference(draft().engineId, 2, reference);
    other.disconnect(draft().engineId, 2);
    assert.throws(() => store.retainReference(draft().engineId, 3, reference), { code: "profile_unavailable" });
  } finally {
    other.close();
  }
});
