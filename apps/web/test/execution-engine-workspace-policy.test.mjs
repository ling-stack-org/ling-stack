import assert from "node:assert/strict";
import test from "node:test";
import { WorkspaceEnginePolicyController } from "../src/features/settings/execution-engines/workspace-engine-policy.ts";

const saved = { workspaceId: "workspace", defaultRunnerId: "pi", allowedRunnerIds: ["pi"],
  explicitRunnerFallback: "disabled", implicitRunnerFallback: "allow_to_default", updatedAt: "2026-09-09T00:00:00.000Z" };
const runners = [
  { id: "pi", displayName: "Pi", status: "enabled" },
  { id: "plugin-test", displayName: "Test plugin", status: "enabled" },
  { id: "codex-app-server", displayName: "Codex", status: "disabled" },
];
function fixture(overrides = {}) {
  const calls = [];
  const api = {
    async listRunners(cwd) { return { cwd, runners }; },
    async getRuntimeSettings(cwd) { return { cwd, settings: saved }; },
    async updateRuntimeSettings(cwd, input) {
      calls.push({ cwd, input });
      return { cwd, settings: { ...saved, ...input, updatedAt: "2026-09-09T00:00:01.000Z" } };
    }, ...overrides,
  };
  return { controller: new WorkspaceEnginePolicyController("/test/workspace", api), calls };
}

test("workspace selection is a draft; cancel writes nothing and save preserves fallback policy", async () => {
  const { controller, calls } = fixture();
  await controller.load();
  controller.setAllowed("plugin-test", true);
  controller.setDefault("plugin-test");
  assert.equal(controller.getSnapshot().draft.defaultRunnerId, "plugin-test");
  assert.deepEqual(calls, []);
  controller.cancel();
  assert.deepEqual(controller.getSnapshot().draft.allowedRunnerIds, ["pi"]);
  controller.setAllowed("plugin-test", true);
  controller.setDefault("plugin-test");
  assert.equal(await controller.save(), true);
  assert.deepEqual(calls, [{ cwd: "/test/workspace", input: {
    allowedRunnerIds: ["pi", "plugin-test"], defaultRunnerId: "plugin-test", expectedUpdatedAt: saved.updatedAt,
  } }]);
  assert.equal(controller.getSnapshot().saved.explicitRunnerFallback, "disabled");
  assert.equal(controller.dirty, false);
});

test("unavailable grants are blocked, changing defaults never grants access, and deny-all is valid", async () => {
  const { controller, calls } = fixture();
  await controller.load();
  controller.setAllowed("codex-app-server", true);
  controller.setAllowed("unknown", true);
  controller.setDefault("plugin-test");
  assert.deepEqual(controller.getSnapshot().draft.allowedRunnerIds, ["pi"]);
  assert.equal(controller.getSnapshot().draft.defaultRunnerId, "pi");
  controller.setAllowed("plugin-test", true);
  controller.setAllowed("pi", false);
  assert.equal(controller.valid, false);
  assert.equal(await controller.save(), false);
  controller.setAllowed("plugin-test", false);
  assert.equal(controller.valid, true);
  assert.equal(await controller.save(), true);
  assert.deepEqual(calls[0].input.allowedRunnerIds, []);
  assert.equal(calls[0].input.defaultRunnerId, "pi");
});

test("saved disabled entries can be removed and restored in the draft but not newly selected as default", async () => {
  const { controller } = fixture({ async getRuntimeSettings(cwd) { return { cwd,
    settings: { ...saved, defaultRunnerId: "codex-app-server", allowedRunnerIds: ["pi", "codex-app-server"] } }; } });
  await controller.load();
  controller.setAllowed("codex-app-server", false);
  assert.equal(controller.valid, false);
  controller.setAllowed("codex-app-server", true);
  assert.equal(controller.valid, true);
  assert.equal(controller.dirty, false);
  controller.setDefault("pi");
  controller.setDefault("codex-app-server");
  assert.equal(controller.getSnapshot().draft.defaultRunnerId, "pi");
});

test("conflict retains the draft, blocks blind retry, and reload adopts the latest policy", async () => {
  let revision = 0;
  let writes = 0;
  const { controller } = fixture({
    async getRuntimeSettings(cwd) { return { cwd, settings: { ...saved, updatedAt: String(revision) } }; },
    async updateRuntimeSettings() { writes++; revision++; throw Object.assign(new Error("private server detail"), { code: "runtime_settings_conflict" }); },
  });
  await controller.load();
  controller.setAllowed("plugin-test", true);
  assert.equal(await controller.save(), false);
  assert.equal(controller.getSnapshot().error, "conflict");
  assert.deepEqual(controller.getSnapshot().draft.allowedRunnerIds, ["pi", "plugin-test"]);
  assert.equal(await controller.save(), false);
  assert.equal(writes, 1);
  await controller.load();
  assert.equal(controller.getSnapshot().saved.updatedAt, "1");
  assert.equal(controller.dirty, false);
  assert.equal(controller.getSnapshot().error, undefined);
});

test("load/save failures are redacted and retryable without losing a local draft", async () => {
  let failLoad = true, failSave = true;
  const { controller } = fixture({
    async getRuntimeSettings(cwd) { if (failLoad) throw new Error("private auth message"); return { cwd, settings: saved }; },
    async updateRuntimeSettings(cwd, input) {
      if (failSave) throw new Error("private token");
      return { cwd, settings: { ...saved, ...input } };
    },
  });
  await controller.load();
  assert.equal(controller.getSnapshot().phase, "error");
  assert.equal(controller.getSnapshot().error, "load");
  failLoad = false;
  await controller.load();
  controller.setAllowed("pi", false);
  assert.equal(await controller.save(), false);
  assert.equal(controller.getSnapshot().error, "save");
  assert.deepEqual(controller.getSnapshot().draft.allowedRunnerIds, []);
  assert.ok(!JSON.stringify(controller.getSnapshot()).includes("private"));
  failSave = false;
  assert.equal(await controller.save(), true);
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("pending saves cannot be duplicated or replaced by edits, cancel or reload", async () => {
  const pending = deferred();
  let writes = 0;
  const { controller } = fixture({ async updateRuntimeSettings(cwd, input) {
    writes++; await pending.promise; return { cwd, settings: { ...saved, ...input } };
  } });
  await controller.load();
  controller.setAllowed("pi", false);
  const save = controller.save();
  controller.setAllowed("pi", true);
  controller.cancel();
  await controller.load();
  assert.deepEqual(controller.getSnapshot().draft.allowedRunnerIds, []);
  assert.equal(await controller.save(), false);
  assert.equal(writes, 1);
  pending.resolve();
  await save;
  assert.deepEqual(controller.getSnapshot().saved.allowedRunnerIds, []);
});

test("detached workspace controllers discard late results and cannot mutate the previous workspace", async () => {
  const pending = deferred();
  const { controller, calls } = fixture({ async getRuntimeSettings() { return pending.promise; } });
  const load = controller.load();
  controller.detach();
  pending.resolve({ cwd: "/test/workspace", settings: saved });
  await load;
  assert.equal(controller.getSnapshot().saved, undefined);
  controller.setAllowed("pi", false);
  assert.equal(await controller.save(), false);
  assert.deepEqual(calls, []);
});

test("a load cannot adopt another workspace response", async () => {
  const { controller } = fixture({ async getRuntimeSettings() { return { cwd: "/another/workspace", settings: saved }; } });
  await controller.load();
  assert.equal(controller.getSnapshot().phase, "error");
  assert.equal(controller.getSnapshot().saved, undefined);
});

test("native migration saves an explicit confirmed profile binding with CAS", async () => {
  const profile = { id: "codex-profile", revision: 3, status: "configured", configuration: { engineId: "codex-app-server" } };
  const { controller, calls } = fixture({ async listRunners(cwd) { return { cwd, runners: [...runners.filter(runner => runner.id !== "codex-app-server"),
    { id: "codex-app-server", displayName: "Codex", status: "disabled", profileSelection: "supported" }] }; } });
  await controller.load();
  controller.setProfiles([profile]);
  controller.setAllowed("codex-app-server", true);
  controller.setDefault("codex-app-server");
  assert.equal(controller.getSnapshot().draft.defaultRunnerId, "codex-app-server");
  controller.setNativeModel("fixture-native-model");
  assert.equal(await controller.save(), false, "native authorization requires explicit acknowledgement");
  controller.confirmMigration(true);
  assert.equal(await controller.save(), true);
  assert.deepEqual(calls[0].input.defaultExecutionBinding, { kind: "native_profile", engineId: "codex-app-server", profileId: "codex-profile", profileRevision: 3, nativeModelId: "fixture-native-model" });
  assert.equal(calls[0].input.schemaVersion, 2);
  assert.equal(calls[0].input.confirmNativeMigration, true);
  assert.equal(calls[0].input.expectedUpdatedAt, saved.updatedAt);
  controller.setProfiles([{ ...profile, revision: 4 }]);
  assert.equal(controller.valid, false, "a changed profile cannot silently replace the saved binding");
});

test("allowing the retired current default exposes its native model without switching defaults", async () => {
  const { controller, calls } = fixture({
    async getRuntimeSettings(cwd) { return { cwd, settings: { ...saved, defaultRunnerId: "codex-app-server",
      migration: { legacyDefaultRunnerId: "codex-app-server" } } }; },
    async listRunners(cwd) { return { cwd, runners: [{ id: "codex-app-server", displayName: "Codex", status: "disabled", profileSelection: "supported" }] }; },
  });
  await controller.load();
  controller.setProfiles([{ id: "profile", revision: 1, status: "configured", configuration: { engineId: "codex-app-server" } }]);
  controller.setAllowed("codex-app-server", true);
  assert.equal(controller.getSnapshot().draft.defaultExecutionBinding?.profileId, "profile");
  controller.setNativeModel("fixture-model");
  assert.equal(controller.valid, true);
  assert.equal(await controller.save(), false, "migration still requires explicit confirmation");
  assert.deepEqual(calls, []);
});

test("adopting Kimi API key configuration clears an OAuth model override", async () => {
  const { controller, calls } = fixture({
    async getRuntimeSettings(cwd) { return { cwd, settings: { ...saved, schemaVersion: 2, defaultRunnerId: "kimi-acp", allowedRunnerIds: ["kimi-acp"],
      defaultExecutionBinding: { kind: "native_profile", engineId: "kimi-acp", profileId: "kimi", profileRevision: 1, nativeModelId: "oauth-model" } } }; },
    async listRunners(cwd) { return { cwd, runners: [{ id: "kimi-acp", displayName: "Kimi", status: "disabled", profileSelection: "supported" }] }; },
  });
  await controller.load();
  controller.setProfiles([{ id: "kimi", revision: 2, status: "configured", configuration: { engineId: "kimi-acp", secretRef: "fixture" } }]);
  controller.setDefault("kimi-acp");
  assert.equal(controller.valid, true);
  assert.equal(controller.getSnapshot().draft.defaultExecutionBinding.nativeModelId, undefined);
  controller.confirmMigration(true);
  assert.equal(await controller.save(), true);
  assert.equal(calls[0].input.defaultExecutionBinding.profileRevision, 2);
});
