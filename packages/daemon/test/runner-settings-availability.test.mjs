import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRunnerRegistry } from "../dist/runtime/runners.js";
import { loadWorkspaceRuntimeSettings, patchWorkspaceRuntimeSettings } from "../dist/runtime/runner-settings.js";

function registry(externalStatus = "disabled") {
  const adapter = { async runTask() { throw new Error("unexpected execution"); } };
  return createRunnerRegistry([
    { id: "pi", displayName: "Pi", status: "enabled", adapter },
    ...["codex-app-server", "claude-agent-sdk", "kimi-acp", "openclaw-acp"].map((id) => ({ id, displayName: id, status: externalStatus, adapter })),
    { id: "plugin-fixture", displayName: "Existing plugin", status: "enabled", adapter },
  ]);
}

function fixture(t, settings) {
  const cwd = mkdtempSync(join(tmpdir(), "ling-runner-policy-"));
  const rootDir = join(cwd, ".ling-stack");
  mkdirSync(rootDir);
  const path = join(rootDir, "runtime-settings.json");
  if (settings) writeFileSync(path, JSON.stringify(settings));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return { store: { paths: { cwd, rootDir } }, path };
}

test("legacy endpoint grants are previewed without authorizing native execution or rewriting settings", (t) => {
  const { store, path } = fixture(t, { defaultRunnerId: "codex-app-server", allowedRunnerIds: ["pi", "codex-app-server"] });
  const before = readFileSync(path, "utf8");
  const settings = loadWorkspaceRuntimeSettings(store, registry("enabled"), { userRuntimeDefaults: {} });
  assert.equal(settings.schemaVersion, 1);
  assert.deepEqual(settings.allowedRunnerIds, ["pi"]);
  assert.equal(settings.defaultRunnerId, "codex-app-server", "preserve the default that requires migration");
  assert.deepEqual(settings.migration, { status: "required", legacyAllowedRunnerIds: ["codex-app-server"], legacyDefaultRunnerId: "codex-app-server" });
  assert.throws(() => registry("enabled").resolve(settings), /not allowed/);
  assert.equal(readFileSync(path, "utf8"), before);
});

test("native migration requires confirmation, CAS and a complete default binding", (t) => {
  const { store, path } = fixture(t, { defaultRunnerId: "codex-app-server", allowedRunnerIds: ["pi", "codex-app-server"] });
  const runners = registry("enabled");
  const current = loadWorkspaceRuntimeSettings(store, runners, { userRuntimeDefaults: {} });
  const binding = { kind: "native_profile", engineId: "codex-app-server", profileId: "codex-profile", profileRevision: 3, nativeModelId: "gpt-fixture" };
  const patch = { schemaVersion: 2, defaultRunnerId: "codex-app-server", allowedRunnerIds: ["pi", "codex-app-server"], defaultExecutionBinding: binding };
  const before = readFileSync(path, "utf8");
  assert.throws(() => patchWorkspaceRuntimeSettings(store, runners, patch), /migration_confirmation_required/);
  assert.throws(() => patchWorkspaceRuntimeSettings(store, runners, { ...patch, confirmNativeMigration: true }), /migration_confirmation_required/);
  assert.equal(readFileSync(path, "utf8"), before);
  const next = patchWorkspaceRuntimeSettings(store, runners, { ...patch, confirmNativeMigration: true, expectedUpdatedAt: current.updatedAt });
  assert.equal(next.schemaVersion, 2);
  assert.equal(next.migration, undefined);
  assert.deepEqual(next.defaultExecutionBinding, binding);
  assert.deepEqual(next.allowedRunnerIds, patch.allowedRunnerIds);
  assert.deepEqual(loadWorkspaceRuntimeSettings(store, runners, { userRuntimeDefaults: {} }), next);
  const saved = readFileSync(path, "utf8");
  assert.throws(() => patchWorkspaceRuntimeSettings(store, runners, { expectedUpdatedAt: current.updatedAt, allowedRunnerIds: [] }), /runtime_settings_conflict/);
  assert.throws(() => patchWorkspaceRuntimeSettings(store, runners, { defaultExecutionBinding: null, schemaVersion: 2, confirmNativeMigration: true, expectedUpdatedAt: next.updatedAt }), /native_default_binding_required/);
  assert.equal(readFileSync(path, "utf8"), saved);
});

test("retired runner policy intent stays readable without blocking an explicit Pi run", (t) => {
  const { store, path } = fixture(t, { defaultRunnerId: "codex-app-server", allowedRunnerIds: ["pi", "codex-app-server"] });
  const before = readFileSync(path, "utf8");
  const runners = registry();
  const settings = loadWorkspaceRuntimeSettings(store, runners, { userRuntimeDefaults: {} });
  assert.equal(settings.defaultRunnerId, "codex-app-server");
  assert.deepEqual(settings.allowedRunnerIds, ["pi"]);
  assert.equal(runners.resolve({ ...settings, requestedRunnerId: "pi" }).effectiveRunnerId, "pi");
  assert.throws(() => runners.resolve({ ...settings, requestedRunnerId: "codex-app-server" }), /not allowed/);
  assert.equal(readFileSync(path, "utf8"), before);
  const repaired = patchWorkspaceRuntimeSettings(store, runners, { defaultRunnerId: "pi", allowedRunnerIds: ["pi"] });
  assert.deepEqual(repaired.allowedRunnerIds, ["pi"]);
  assert.equal(repaired.defaultRunnerId, "pi");
});

test("missing workspace policy never adopts newly available external engines", (t) => {
  const { store } = fixture(t);
  const disabled = loadWorkspaceRuntimeSettings(store, registry(), { userRuntimeDefaults: {} });
  const enabled = loadWorkspaceRuntimeSettings(store, registry("enabled"), { userRuntimeDefaults: {} });
  assert.deepEqual(disabled.allowedRunnerIds, ["pi", "plugin-fixture"]);
  assert.deepEqual(enabled.allowedRunnerIds, disabled.allowedRunnerIds);
  const inherited = loadWorkspaceRuntimeSettings(store, registry("enabled"), { userRuntimeDefaults: { defaultRunnerId: "codex-app-server" } });
  assert.equal(inherited.defaultRunnerId, "codex-app-server");
  assert.throws(() => registry("enabled").resolve(inherited), /not allowed/);
});

test("explicit empty workspace policy means deny all, not every enabled runner", (t) => {
  const { store } = fixture(t, { defaultRunnerId: "pi", allowedRunnerIds: [] });
  const settings = loadWorkspaceRuntimeSettings(store, registry("enabled"), { userRuntimeDefaults: {} });
  assert.deepEqual(settings.allowedRunnerIds, []);
  assert.throws(() => registry("enabled").resolve(settings), /not allowed/);
  assert.deepEqual(patchWorkspaceRuntimeSettings(store, registry(), { allowedRunnerIds: [] }).allowedRunnerIds, []);
});

test("new policy writes cannot authorize an unavailable target or invalid default", (t) => {
  const { store } = fixture(t);
  assert.throws(() => patchWorkspaceRuntimeSettings(store, registry(), { schemaVersion: 2, confirmNativeMigration: true, expectedUpdatedAt: loadWorkspaceRuntimeSettings(store, registry()).updatedAt, allowedRunnerIds: ["pi", "codex-app-server"] }), /disabled runner/);
  assert.throws(() => patchWorkspaceRuntimeSettings(store, registry(), { schemaVersion: 2, confirmNativeMigration: true, expectedUpdatedAt: loadWorkspaceRuntimeSettings(store, registry()).updatedAt, defaultRunnerId: "codex-app-server" }), /native_default_binding_required/);
  assert.throws(() => patchWorkspaceRuntimeSettings(store, registry(), { allowedRunnerIds: ["plugin-fixture"], defaultRunnerId: "pi" }), /must be included/);
});

test("legacy disabled intent needs explicit migration before native authorization", (t) => {
  const { store } = fixture(t, { defaultRunnerId: "codex-app-server", allowedRunnerIds: ["pi", "codex-app-server"] });
  const runners = registry();
  assert.throws(() => patchWorkspaceRuntimeSettings(store, runners, {
    defaultRunnerId: "codex-app-server", allowedRunnerIds: ["pi", "codex-app-server", "plugin-fixture"],
  }), /migration_confirmation_required/);
  assert.throws(() => patchWorkspaceRuntimeSettings(store, runners, {
    allowedRunnerIds: ["pi", "codex-app-server", "kimi-acp"],
  }), /migration_confirmation_required/);
  patchWorkspaceRuntimeSettings(store, runners, { defaultRunnerId: "pi", allowedRunnerIds: ["pi"] });
  assert.throws(() => patchWorkspaceRuntimeSettings(store, runners, {
    schemaVersion: 2, confirmNativeMigration: true, expectedUpdatedAt: loadWorkspaceRuntimeSettings(store, runners).updatedAt,
    allowedRunnerIds: ["pi", "codex-app-server"],
  }), /disabled runner/);
});

test("stale workspace saves leave policy unchanged and same-clock writes advance its version", (t) => {
  const { store, path } = fixture(t);
  const runners = registry();
  const initial = loadWorkspaceRuntimeSettings(store, runners);
  const timestamp = "2026-09-09T00:00:00.000Z";
  const first = patchWorkspaceRuntimeSettings(store, runners, {
    expectedUpdatedAt: initial.updatedAt, allowedRunnerIds: ["pi"],
  }, timestamp);
  const bytes = readFileSync(path, "utf8");
  assert.throws(() => patchWorkspaceRuntimeSettings(store, runners, {
    expectedUpdatedAt: initial.updatedAt, allowedRunnerIds: [],
  }, timestamp), { message: "runtime_settings_conflict" });
  assert.equal(readFileSync(path, "utf8"), bytes);
  const second = patchWorkspaceRuntimeSettings(store, runners, {
    expectedUpdatedAt: first.updatedAt, allowedRunnerIds: [],
  }, timestamp);
  assert.ok(Date.parse(second.updatedAt) > Date.parse(first.updatedAt));
  assert.deepEqual(second.allowedRunnerIds, []);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).expectedUpdatedAt, undefined);
});

test("fresh and existing v2 native grants require explicit confirmation and CAS", (t) => {
  const { store, path } = fixture(t);
  const runners = registry("enabled");
  const initial = loadWorkspaceRuntimeSettings(store, runners);
  const grant = { allowedRunnerIds: ["pi", "kimi-acp"] };
  assert.throws(() => patchWorkspaceRuntimeSettings(store, runners, grant), /migration_confirmation_required/);
  assert.throws(() => patchWorkspaceRuntimeSettings(store, runners, { ...grant, schemaVersion: 2, confirmNativeMigration: true }), /migration_confirmation_required/);
  const next = patchWorkspaceRuntimeSettings(store, runners, { ...grant, schemaVersion: 2, confirmNativeMigration: true, expectedUpdatedAt: initial.updatedAt });
  assert.deepEqual(next.allowedRunnerIds, ["pi", "kimi-acp"]);
  const bytes = readFileSync(path, "utf8");
  assert.throws(() => patchWorkspaceRuntimeSettings(store, runners, { allowedRunnerIds: [] }), /runtime_settings_conflict/);
  assert.equal(readFileSync(path, "utf8"), bytes);
  const denied = patchWorkspaceRuntimeSettings(store, runners, { allowedRunnerIds: [], expectedUpdatedAt: next.updatedAt });
  assert.throws(() => patchWorkspaceRuntimeSettings(store, runners, { ...grant, schemaVersion: 2, confirmNativeMigration: true, expectedUpdatedAt: next.updatedAt }), /runtime_settings_conflict/);
  assert.deepEqual(loadWorkspaceRuntimeSettings(store, runners).allowedRunnerIds, denied.allowedRunnerIds);
});
