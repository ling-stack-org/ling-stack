import assert from "node:assert/strict";
import test from "node:test";
import { ExecutionEngineManager } from "../src/features/settings/execution-engines/execution-engine-manager.ts";

// Regression: engine lifecycle callbacks must share the existing view/authority fence.
// Found by /qa on 2026-10-28
// Report: output/e6-20260928/main374-integration-and-lifecycle-20261028.md
// Value: protects=late discovery/install cannot leak or overwrite a different editor;
// fails_when=lifecycle callbacks ignore manager scope or editor identity;
// why_new=existing manager tests predate managed install/discovery; seam=none;
// no_claim=actual download/native install (API replies are deferred synthetic fixtures).
const codex = "codex-app-server", claude = "claude-agent-sdk";
const emptyDiscovery = { checkedAt: "2026-10-28T00:00:00.000Z", candidates: [] };
const installed = { engineId: claude, phase: "installed", executablePath: "/synthetic/managed/claude",
  version: "2.1.311", updatedAt: "2026-10-28T00:00:00.000Z" };
const turn = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  return Promise.withResolvers();
}
async function fixture(overrides = {}, kind = "desktop") {
  const api = { async listProfiles() { return { profiles: [] }; },
    async discover() { return emptyDiscovery; }, ...overrides };
  const manager = new ExecutionEngineManager({ kind, api, async revoke() {}, async enroll() {} });
  await manager.load();
  await turn();
  return manager;
}

for (const retire of ["detach", "revoke"]) test(`late discovery cannot publish after ${retire}`, async () => {
  const pending = deferred();
  const manager = await fixture({ async discover() { return pending.promise; } }, retire === "revoke" ? "web" : "desktop");
  await manager[retire]();
  const snapshot = manager.getSnapshot();
  pending.resolve({ ...emptyDiscovery, candidates: [{ engineId: codex, status: "detected", executablePath: "/synthetic/private/codex", installable: true }] });
  await turn();
  assert.equal(manager.getSnapshot(), snapshot, "A retired observation must not publish into current state");
});

test("managed install does not rewrite the other engine's draft while its reply is pending", async () => {
  const pending = deferred();
  const manager = await fixture({ async install() { return pending.promise; } });
  const installing = manager.installEngine(claude);
  manager.edit(codex);
  manager.updateDraft({ executablePath: "/synthetic/user/codex" });
  const editor = structuredClone(manager.getSnapshot().editor);
  pending.resolve({ install: installed });
  await installing;
  assert.deepEqual(manager.getSnapshot().editor, editor);
  assert.equal(manager.getSnapshot().installs[claude].phase, "installed");
});

test("late install completion cannot reopen an editor or publish after detach", async () => {
  const pending = deferred();
  const manager = await fixture({ async install() { return pending.promise; } });
  const installing = manager.installEngine(claude);
  manager.detach();
  const snapshot = manager.getSnapshot();
  pending.resolve({ install: installed });
  await installing;
  assert.equal(manager.getSnapshot(), snapshot);
  assert.equal(manager.getSnapshot().editor, undefined);
});

test("one pending install admits only one POST for the same engine", async () => {
  const pending = deferred();
  let calls = 0;
  const manager = await fixture({ async install() { calls++; return pending.promise; } });
  const first = manager.installEngine(claude), second = manager.installEngine(claude);
  pending.resolve({ install: installed });
  await Promise.all([first, second]);
  assert.equal(calls, 1);
});

for (const method of ["discover", "install"]) test(`${method} authority failure retires private discovery/install state`, async () => {
  let deny = false;
  const error = () => { throw Object.assign(new Error("synthetic-only"), { code: "engine_session_invalid" }); };
  const manager = await fixture({ async discover() { return deny ? error() : emptyDiscovery; }, async install() { return error(); } }, "web");
  deny = true;
  if (method === "discover") await manager.discover();
  else await manager.installEngine(claude);
  assert.equal(manager.getSnapshot().phase, "authorization_required");
  assert.equal(manager.getSnapshot().discovery, undefined);
  assert.deepEqual(manager.getSnapshot().installs, {});
});

test("managed install still prefills its own empty editor on a live view", async () => {
  const manager = await fixture({ async install() { return { install: installed }; } });
  await manager.installEngine(claude);
  assert.equal(manager.getSnapshot().editor.draft.engineId, claude);
  assert.equal(manager.getSnapshot().editor.draft.executablePath, installed.executablePath);
});

test("late discovery cannot replace a newer discovery in the same view", async () => {
  const old = deferred();
  let reads = 0;
  const manager = await fixture({ async discover() { return ++reads === 1 ? old.promise : emptyDiscovery; } });
  await manager.discover();
  const snapshot = manager.getSnapshot();
  old.resolve({ ...emptyDiscovery, candidates: [{ engineId: codex, status: "not_found", installable: true }] });
  await turn();
  assert.equal(manager.getSnapshot(), snapshot);
});

test("late install failure cannot invalidate a replacement authorization", async () => {
  const pending = deferred();
  const manager = await fixture({ async install() { return pending.promise; } }, "web");
  const installing = manager.installEngine(claude);
  await manager.revoke();
  await manager.enroll("synthetic-only");
  await turn();
  const snapshot = manager.getSnapshot();
  pending.reject({ code: "engine_session_invalid" });
  await installing;
  assert.equal(manager.getSnapshot(), snapshot);
  assert.equal(snapshot.phase, "ready");
});

test("enrollment restarts discovery only after the new authority is ready", async () => {
  const enrolled = deferred();
  let discoveries = 0;
  const manager = new ExecutionEngineManager({ kind: "web", api: {
    async listProfiles() { return { profiles: [] }; },
    async discover() { discoveries++; return emptyDiscovery; },
  }, async enroll() { await enrolled.promise; }, async revoke() {} });
  const pending = manager.enroll("synthetic-only");
  await manager.discover();
  assert.equal(discoveries, 0, "pending enrollment must not discover with old authority");
  enrolled.resolve();
  await pending;
  await turn();
  assert.equal(discoveries, 1);
  assert.equal(manager.getSnapshot().discovery, emptyDiscovery);
});

test("a user-opened then closed editor is not reopened by an install reply", async () => {
  const pending = deferred();
  const manager = await fixture({ async install() { return pending.promise; } });
  const installing = manager.installEngine(claude);
  manager.edit(codex);
  manager.cancelEdit();
  pending.resolve({ install: installed });
  await installing;
  assert.equal(manager.getSnapshot().editor, undefined);
  assert.equal(manager.getSnapshot().installs[claude].phase, "installed");
});

test("prefilling a detected engine cannot overwrite an existing different draft", async () => {
  const manager = await fixture();
  manager.edit(codex, "/synthetic/user/codex");
  const editor = manager.getSnapshot().editor;
  manager.edit(claude, installed.executablePath);
  assert.equal(manager.getSnapshot().editor, editor);
});

test("managed installation preserves an already saved executable configuration", async () => {
  const manager = await fixture({
    async listProfiles() { return { profiles: [{ revision: 3, configuration: { engineId: claude, executablePath: "/synthetic/user/claude", authProfileId: "ling" } }] }; },
    async install() { return { install: installed }; },
  });
  await manager.installEngine(claude);
  assert.equal(manager.getSnapshot().editor.draft.executablePath, "/synthetic/user/claude");
  assert.equal(manager.getSnapshot().editor.expectedRevision, 3);
});

test("install reply for another engine fails without prefilling a draft", async () => {
  const manager = await fixture({ async install() { return { install: { ...installed, engineId: codex } }; } });
  await manager.installEngine(claude);
  assert.equal(manager.getSnapshot().installs[claude].phase, "failed");
  assert.equal(manager.getSnapshot().editor, undefined);
});

test("retiring a view during its poll delay prevents further status requests", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let polls = 0;
  const manager = await fixture({ async install() { return { install: { ...installed, phase: "downloading" } }; },
    async installStatus() { polls++; return { install: installed }; } });
  const installing = manager.installEngine(claude);
  await turn();
  manager.detach();
  const snapshot = manager.getSnapshot();
  t.mock.timers.tick(1500);
  await installing;
  assert.equal(polls, 0);
  assert.equal(manager.getSnapshot(), snapshot);
});

test("a pending status read cannot publish after revocation", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const status = deferred(), called = deferred();
  const manager = await fixture({ async install() { return { install: { ...installed, phase: "verifying" } }; },
    async installStatus() { called.resolve(); return status.promise; } }, "web");
  const installing = manager.installEngine(claude);
  await turn();
  t.mock.timers.tick(1500);
  await called.promise;
  await manager.revoke();
  const snapshot = manager.getSnapshot();
  status.resolve({ install: installed });
  await installing;
  assert.equal(manager.getSnapshot(), snapshot);
});
