import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ExecutionEngineManagementClient, LingDaemonClient } from "@ling-stack/api-client";
import { WorkspaceEnginePolicyController } from "../src/features/settings/execution-engines/workspace-engine-policy.ts";
import { startExecutionEngineFixture } from "../e2e/support/execution-engine-fixture.mjs";
import { ExecutionEngineLoginController, ExecutionEngineManager, engineProbeOutcome } from "../src/features/settings/execution-engines/execution-engine-manager.ts";

test("settings actions preserve authority, revisions and lifecycle through the real Daemon and owned protocol process", {
  timeout: 25_000,
}, async (t) => {
  const origin = "http://127.0.0.1:5176";
  const fixture = await startExecutionEngineFixture({ origin });
  t.after(() => fixture.close());
  const client = new ExecutionEngineManagementClient({ baseUrl: fixture.baseUrl, origin });
  const manager = new ExecutionEngineManager({ kind: "web", api: client,
    enroll: (code) => client.enroll(code), revoke: () => client.revokeSession() });
  await manager.load();
  assert.equal(manager.getSnapshot().phase, "authorization_required");
  await manager.enroll((await fixture.enroll()).code);
  assert.equal(manager.getSnapshot().phase, "ready");
  manager.edit("codex-app-server");
  manager.updateDraft({ executablePath: fixture.executablePath });
  assert.equal(await manager.save(), true);
  assert.deepEqual(fixture.launches, [], "load/edit/save must never spawn");
  await manager.checkConnection("codex-app-server");
  const probe = manager.getSnapshot().probes["codex-app-server"];
  assert.ok(probe);
  assert.equal(engineProbeOutcome(probe), "auth_required");
  assert.deepEqual(fixture.launches, ["--version", "app-server"]);
  manager.edit("codex-app-server");
  manager.updateDraft({ executablePath: "/unsaved/draft/codex" });
  const { profile } = await fixture.request("/codex-app-server/profile");
  await fixture.request("/codex-app-server/profile", "PUT", { expectedRevision: profile.revision,
    configuration: { ...profile.configuration, authProfileId: "another-window" } });
  assert.equal(await manager.save(), false);
  assert.equal(manager.getSnapshot().editor.error, "profile_revision_conflict");
  assert.equal(manager.getSnapshot().editor.draft.executablePath, "/unsaved/draft/codex");
  await manager.reloadEditor();
  assert.equal(manager.getSnapshot().editor.draft.authProfileId, "another-window");
  manager.cancelEdit();
  await manager.disconnect("codex-app-server");
  assert.equal(manager.getSnapshot().profiles[0].status, "disconnected");
  assert.equal((await fixture.request("/codex-app-server/profile")).profile.status, "disconnected");
  await manager.revoke();
  await manager.load();
  assert.equal(manager.getSnapshot().phase, "authorization_required");
  assert.deepEqual(fixture.launches, ["--version", "app-server"], "disconnect/revocation cannot create work");
});

test("the login view follows actual HTTP/process cancellation and committed native-profile adoption", { timeout: 25_000 }, async (t) => {
  const origin = "http://127.0.0.1:5176";
  const fixture = await startExecutionEngineFixture({ origin });
  t.after(() => fixture.close());
  const client = new ExecutionEngineManagementClient({ baseUrl: fixture.baseUrl, origin });
  await client.enroll((await fixture.enroll()).code);
  const { profile } = await client.saveProfile("codex-app-server", { expectedRevision: 0,
    configuration: { engineId: "codex-app-server", executablePath: fixture.executablePath, authProfileId: "ling" } });
  const controller = new ExecutionEngineLoginController({ kind: "desktop", api: client });
  async function until(status) {
    const deadline = performance.now() + 8_000;
    while (controller.getSnapshot()?.operation?.status !== status && performance.now() < deadline) {
      await delay(20);
      await controller.refresh();
      assert.equal(controller.getSnapshot()?.error, undefined);
    }
    assert.equal(controller.getSnapshot()?.operation?.status, status);
  }
  await controller.start(profile);
  await until("waiting");
  assert.equal(controller.getSnapshot().operation.challenge.userCode, "TEST-ONLY");
  await controller.cancel();
  await until("cancelled");
  assert.equal(controller.getSnapshot().operation.challenge, undefined);
  assert.equal((await client.getProfile("codex-app-server")).profile.revision, 1);
  controller.close();
  await controller.start(profile);
  await until("waiting");
  fixture.completeLogin();
  await until("completed");
  assert.equal(controller.getSnapshot().operation.profileRevision, 2);
  assert.equal(controller.getSnapshot().operation.authentication, "login_completed");
  const saved = (await client.getProfile("codex-app-server")).profile;
  assert.equal(saved.revision, 2);
  assert.notEqual(saved.configuration.authProfileId, "ling");
  assert.equal("enabled" in saved, false);
  assert.equal(JSON.stringify(controller.getSnapshot()).includes("TEST-ONLY"), false);
});

test("workspace policy uses the real API: deny-all, conflict, reload, old clients and workspace isolation", { timeout: 15_000 }, async (t) => {
  const fixture = await startExecutionEngineFixture();
  t.after(() => fixture.close());
  const client = new LingDaemonClient({ baseUrl: fixture.baseUrl });
  const first = new WorkspaceEnginePolicyController(fixture.root, client);
  const second = new WorkspaceEnginePolicyController(fixture.root, client);
  await first.load();
  await second.load();
  first.setAllowed("pi", false);
  assert.equal(await first.save(), true);
  assert.deepEqual((await client.getRuntimeSettings(fixture.root)).settings.allowedRunnerIds, []);
  second.setAllowed("pi", false);
  assert.equal(await second.save(), false);
  assert.equal(second.getSnapshot().error, "conflict");
  assert.deepEqual(second.getSnapshot().draft.allowedRunnerIds, []);
  await second.load();
  second.setAllowed("pi", true);
  assert.equal(await second.save(), true);
  const existing = await client.getRuntimeSettings(fixture.root);
  const race = await Promise.allSettled([
    client.updateRuntimeSettings(fixture.root, { expectedUpdatedAt: existing.settings.updatedAt, allowedRunnerIds: [] }),
    client.updateRuntimeSettings(fixture.root, { expectedUpdatedAt: existing.settings.updatedAt, allowedRunnerIds: ["pi"] }),
  ]);
  assert.equal(race.filter((item) => item.status === "fulfilled").length, 1);
  const rejected = race.find((item) => item.status === "rejected");
  assert.equal(rejected.reason.code, "runtime_settings_conflict");
  assert.equal(rejected.reason.status, 409);
  await client.updateRuntimeSettings(fixture.root, { allowedRunnerIds: ["pi"] });
  await assert.rejects(client.updateRuntimeSettings(fixture.root, { allowedRunnerIds: ["pi", "codex-app-server"] }), { status: 400 });
  await client.updateRuntimeSettings(`${fixture.root}/other-workspace`, { allowedRunnerIds: [] });
  assert.deepEqual((await client.getRuntimeSettings(fixture.root)).settings.allowedRunnerIds, ["pi"]);
  assert.deepEqual((await client.getRuntimeSettings(`${fixture.root}/other-workspace`)).settings.allowedRunnerIds, []);
  assert.deepEqual(fixture.launches, [], "policy changes never start native engines");
});

test("a replaced terminal login releases only the stale view through the actual host API", { timeout: 20_000 }, async (t) => {
  const fixture = await startExecutionEngineFixture();
  t.after(() => fixture.close());
  const client = new ExecutionEngineManagementClient({ baseUrl: fixture.baseUrl, origin: "http://127.0.0.1:5176" });
  await client.enroll((await fixture.enroll()).code);
  const { profile } = await client.saveProfile("codex-app-server", { expectedRevision: 0,
    configuration: { engineId: "codex-app-server", executablePath: fixture.executablePath, authProfileId: "ling" } });
  const controller = new ExecutionEngineLoginController({ kind: "desktop", api: client });
  await controller.start(profile);
  const oldId = controller.getSnapshot().operation.id;
  await client.cancelLogin("codex-app-server", oldId);
  const replacement = await client.startLogin("codex-app-server", profile.revision, "chatgptDeviceCode");
  assert.notEqual(replacement.id, oldId);
  await controller.refresh();
  assert.equal(controller.getSnapshot().error, "engine_login_not_found");
  assert.equal(controller.getSnapshot().operation, undefined);
  controller.close();
  assert.equal(controller.getSnapshot(), undefined);
  const current = await client.getLogin("codex-app-server", replacement.id);
  assert.ok(["starting", "waiting"].includes(current.status), "closing the old view must not cancel its replacement");
  assert.equal((await client.getProfile("codex-app-server")).profile.revision, profile.revision);
  await client.cancelLogin("codex-app-server", replacement.id);
});

test("native timeout and failure retire challenges and keep the saved profile until an explicit retry", { timeout: 25_000 }, async (t) => {
  const fixture = await startExecutionEngineFixture({ loginTimeoutMs: 2_000 });
  t.after(() => fixture.close());
  const client = new ExecutionEngineManagementClient({ baseUrl: fixture.baseUrl, origin: "http://127.0.0.1:5176" });
  await client.enroll((await fixture.enroll()).code);
  const { profile } = await client.saveProfile("codex-app-server", { expectedRevision: 0,
    configuration: { engineId: "codex-app-server", executablePath: fixture.executablePath, authProfileId: "ling" } });
  const controller = new ExecutionEngineLoginController({ kind: "desktop", api: client });
  async function until(status) {
    const deadline = performance.now() + 8_000;
    while (controller.getSnapshot()?.operation?.status !== status && performance.now() < deadline) {
      await delay(20);
      await controller.refresh();
      assert.equal(controller.getSnapshot()?.error, undefined);
    }
    assert.equal(controller.getSnapshot()?.operation?.status, status);
  }
  for (const terminal of ["failed", "timed_out"]) {
    await controller.start(profile);
    await until("waiting");
    if (terminal === "failed") fixture.failLogin();
    await until(terminal);
    assert.equal(controller.getSnapshot().operation.challenge, undefined);
    assert.equal(controller.getSnapshot().operation.authentication, undefined);
    assert.equal(JSON.stringify(controller.getSnapshot()).includes("private synthetic"), false);
    assert.deepEqual((await client.getProfile("codex-app-server")).profile, profile);
    const launches = [...fixture.launches];
    await controller.refresh();
    controller.close();
    assert.deepEqual(fixture.launches, launches, "closing a terminal state does not retry login");
  }
  await controller.start(profile);
  await until("waiting");
  await controller.cancel();
  assert.equal(controller.getSnapshot().operation.status, "cancelled");
  assert.deepEqual((await client.getProfile("codex-app-server")).profile, profile);
});

test("key configuration saves references only, applies explicitly, and missing secrets preserve the profile", { timeout: 25_000 }, async (t) => {
  const origin = "http://127.0.0.1:5176";
  const fixture = await startExecutionEngineFixture({ origin });
  t.after(() => fixture.close());
  const client = new ExecutionEngineManagementClient({ baseUrl: fixture.baseUrl, origin });
  await client.enroll((await fixture.enroll()).code);
  const manager = new ExecutionEngineManager({ kind: "desktop", api: client });
  const controller = new ExecutionEngineLoginController({ kind: "desktop", api: client });
  await manager.load();
  manager.edit("codex-app-server");
  manager.setAuthenticationMode("apiKey");
  manager.updateDraft({ executablePath: fixture.executablePath, secretRef: "env:MISSING_FIXTURE_KEY" });
  assert.equal(await manager.save(), true);
  assert.deepEqual(fixture.launches, [], "save does not read keys, launch a process or log in");
  const before = (await client.getProfile("codex-app-server")).profile;
  async function terminal() {
    const deadline = performance.now() + 8_000;
    while (!["failed", "completed"].includes(controller.getSnapshot()?.operation?.status) && performance.now() < deadline) {
      await delay(20);
      await controller.refresh();
      assert.equal(controller.getSnapshot()?.error, undefined);
    }
    return controller.getSnapshot()?.operation;
  }
  await controller.start(before);
  assert.equal((await terminal()).status, "failed");
  assert.equal(controller.getSnapshot().operation.errorCode, "engine_secret_missing");
  assert.deepEqual((await client.getProfile("codex-app-server")).profile, before);
  controller.close();
  manager.edit("codex-app-server");
  manager.updateDraft({ secretRef: "synthetic-raw-value-must-be-rejected" });
  assert.equal(await manager.save(), false);
  assert.equal(manager.getSnapshot().editor.error, "profile_invalid");
  assert.equal(manager.getSnapshot().editor.draft.secretRef, "synthetic-raw-value-must-be-rejected");
  manager.updateDraft({ secretRef: "env:LING_ENGINE_UI_TEST_KEY" });
  assert.equal(await manager.save(), true);
  const keyed = (await client.getProfile("codex-app-server")).profile;
  await controller.start(keyed);
  const completed = await terminal();
  assert.equal(completed.status, "completed");
  assert.equal(completed.authentication, "configured_unverified");
  assert.equal(completed.profileRevision, keyed.revision + 1);
  await manager.load();
  assert.equal(manager.getSnapshot().profiles[0].revision, completed.profileRevision);
  assert.equal(JSON.stringify({ manager: manager.getSnapshot(), login: controller.getSnapshot() }).includes("synthetic-ui-key-not-a-real-credential"), false);
  assert.equal("enabled" in manager.getSnapshot().profiles[0], false);
  await manager.checkConnection("codex-app-server");
  assert.equal(manager.getSnapshot().probes["codex-app-server"].authentication, "configured_unverified");
  const keyHome = manager.getSnapshot().profiles[0].configuration.authProfileId;
  manager.edit("codex-app-server");
  manager.setAuthenticationMode("account");
  assert.equal(await manager.save(), true);
  const account = manager.getSnapshot().profiles[0];
  assert.notEqual(account.configuration.authProfileId, keyHome);
  assert.equal(account.configuration.secretRef, undefined);
  await manager.checkConnection("codex-app-server");
  assert.equal(engineProbeOutcome(manager.getSnapshot().probes["codex-app-server"]), "auth_required",
    "account mode cannot inspect or reuse the key left in the previous native home");
});
