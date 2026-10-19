import assert from "node:assert/strict";
import test from "node:test";
import { ExecutionEngineManager, engineProbeOutcome } from "../src/features/settings/execution-engines/execution-engine-manager.ts";

test("opening and saving engine settings reads profiles without running or enabling an engine", async () => {
  const calls = [];
  const profile = savedProfile(3);
  const api = {
    async listProfiles() { calls.push("list"); return { profiles: [profile] }; },
    async saveProfile(id, input) {
      calls.push({ id, input });
      return { profile: { ...profile, revision: 4, configuration: input.configuration } };
    },
  };
  const manager = new ExecutionEngineManager({ kind: "desktop", api });
  assert.deepEqual(calls, [], "constructing the view is passive");
  await manager.load();
  manager.edit("codex-app-server");
  manager.updateDraft({ executablePath: "/opt/tools/codex" });
  assert.equal(manager.getSnapshot().editor.expectedRevision, 3);
  assert.equal(await manager.save(), true);
  assert.deepEqual(calls, ["list", {
    id: "codex-app-server",
    input: { expectedRevision: 3, configuration: { ...profile.configuration, executablePath: "/opt/tools/codex" } },
  }]);
  assert.equal(manager.getSnapshot().profiles[0].revision, 4);
  assert.equal(manager.getSnapshot().editor, undefined);
});

function savedProfile(revision = 1) {
  return {
    schemaVersion: 1, id: "profile-codex", revision, status: "configured",
    configuration: { engineId: "codex-app-server", executablePath: "/usr/local/bin/codex", authProfileId: "ling" },
    configurationFingerprint: "fingerprint", updatedAt: "2026-09-09T00:00:00.000Z",
  };
}

test("direct secret save uses only its write-only API and never publishes the value into view state", async () => {
  const calls = [];
  const profile = savedProfile();
  const manager = new ExecutionEngineManager({ kind: "desktop", api: {
    async listProfiles() { return { profiles: [profile] }; },
    async saveProfile() { throw new Error("raw secret must not use ordinary profile API"); },
    async saveProfileWithSecret(id, request) {
      calls.push({ id, request: structuredClone(request) });
      assert.equal(JSON.stringify(manager.getSnapshot()).includes("synthetic-only-key"), false);
      return { profile: { ...profile, revision: 2, configuration: { ...profile.configuration, secretRef: "keychain:generated" } } };
    },
  } });
  await manager.load();
  manager.edit("codex-app-server");
  manager.setAuthenticationMode("apiKey");
  assert.equal(await manager.save("synthetic-only-key"), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].request.secret, "synthetic-only-key");
  assert.equal("secretRef" in calls[0].request.configuration, false);
  assert.equal(JSON.stringify(manager.getSnapshot()).includes("synthetic-only-key"), false);
});

test("switching native authentication edits only the draft and removes incompatible fields", async () => {
  const manager = new ExecutionEngineManager({ kind: "desktop", api: {
    async listProfiles() { return { profiles: [] }; },
  } });
  await manager.load();
  manager.edit("kimi-acp");
  manager.updateDraft({ executablePath: "/opt/kimi", kimiLoginRegion: "global" });
  manager.setAuthenticationMode("apiKey");
  let draft = manager.getSnapshot().editor.draft;
  assert.equal(draft.secretRef, "", "key mode is an unfinished draft, not a guessed secret");
  assert.equal(draft.kimiLoginRegion, undefined);
  assert.deepEqual(draft.kimi, { providerType: "kimi", baseUrl: "", modelId: "", maxContextSize: 0 });
  manager.updateDraft({ secretRef: "env:OWNED_TEST_KEY", kimi: {
    providerType: "openai_responses", baseUrl: "https://fixture.example.test/v1", modelId: "chosen-model", maxContextSize: 32000,
  } });
  manager.setAuthenticationMode("apiKey");
  assert.equal(manager.getSnapshot().editor.draft.kimi.modelId, "chosen-model", "same mode does not clear current fields");
  manager.setAuthenticationMode("account");
  draft = manager.getSnapshot().editor.draft;
  assert.equal(draft.secretRef, undefined);
  assert.equal(draft.kimi, undefined);
  assert.equal(draft.kimiLoginRegion, undefined, "account region must be explicitly chosen again");
  assert.equal(draft.executablePath, "/opt/kimi");
  assert.deepEqual(manager.getSnapshot().profiles, [], "mode selection cannot save or launch");
  manager.cancelEdit();
  manager.edit("claude-agent-sdk");
  manager.setAuthenticationMode("account");
  assert.equal(manager.getSnapshot().editor.draft.kimiLoginRegion, undefined);
  assert.equal(manager.getSnapshot().editor.draft.engineId, "claude-agent-sdk");
});

test("save conflicts retain the draft and revision until an explicit reload", async () => {
  const manager = new ExecutionEngineManager({ kind: "desktop", api: {
    async listProfiles() { return { profiles: [savedProfile(3)] }; },
    async saveProfile() { throw new Error("Error invoking remote method 'engine-save': Error: profile_revision_conflict"); },
    async getProfile() { return { profile: savedProfile(4) }; },
  } });
  await manager.load();
  manager.edit("codex-app-server");
  manager.updateDraft({ executablePath: "/my/draft/codex" });
  assert.equal(await manager.save(), false);
  assert.equal(manager.getSnapshot().editor.draft.executablePath, "/my/draft/codex");
  assert.equal(manager.getSnapshot().editor.expectedRevision, 3);
  assert.equal(manager.getSnapshot().editor.error, "profile_revision_conflict");
  await manager.reloadEditor();
  assert.equal(manager.getSnapshot().editor.expectedRevision, 4);
  assert.equal(manager.getSnapshot().editor.draft.executablePath, "/usr/local/bin/codex");
});

test("an in-flight save owns a snapshot and cannot be submitted twice or overwritten by late loading", async () => {
  const save = deferred();
  const load = deferred();
  let reads = 0;
  let saves = 0;
  const manager = new ExecutionEngineManager({ kind: "desktop", api: {
    async listProfiles() { return ++reads === 1 ? { profiles: [savedProfile(3)] } : load.promise; },
    async saveProfile(_id, input) {
      saves++;
      await save.promise;
      return { profile: { ...savedProfile(4), configuration: input.configuration } };
    },
  } });
  await manager.load();
  const pendingLoad = manager.load();
  manager.edit("codex-app-server");
  manager.updateDraft({ executablePath: "/my/draft/codex" });
  const pendingSave = manager.save();
  manager.updateDraft({ executablePath: "/must/not/replace/codex" });
  assert.equal(await manager.save(), false);
  assert.equal(saves, 1);
  assert.equal(manager.getSnapshot().busy["codex-app-server"], "save");
  save.resolve();
  await pendingSave;
  load.resolve({ profiles: [savedProfile(3)] });
  await pendingLoad;
  assert.equal(manager.getSnapshot().profiles[0].revision, 4);
  assert.equal(manager.getSnapshot().profiles[0].configuration.executablePath, "/my/draft/codex");
});

test("cancel changes no remote state and reopening uses the saved profile", async () => {
  const manager = new ExecutionEngineManager({ kind: "desktop", api: {
    async listProfiles() { return { profiles: [savedProfile()] }; },
  } });
  await manager.load();
  manager.edit("codex-app-server");
  manager.updateDraft({ executablePath: "/unsaved" });
  manager.cancelEdit();
  assert.equal(manager.getSnapshot().editor, undefined);
  manager.edit("codex-app-server");
  assert.equal(manager.getSnapshot().editor.draft.executablePath, "/usr/local/bin/codex");
});

test("local Web authorization has an explicit enrollment and never exposes raw server failures", async () => {
  let authorized = false;
  const manager = new ExecutionEngineManager({ kind: "web", api: {
    async listProfiles() {
      if (!authorized) throw Object.assign(new Error("credential-sensitive native error"), { code: "engine_authority_required" });
      return { profiles: [] };
    },
    async saveProfile() { throw new Error("do-not-display-this-secret"); },
  }, async enroll(code) { assert.equal(code, "one-use-code"); authorized = true; }, async revoke() { authorized = false; } });
  await manager.load();
  assert.equal(manager.getSnapshot().phase, "authorization_required");
  await manager.enroll("one-use-code");
  assert.equal(manager.getSnapshot().phase, "ready");
  manager.edit("codex-app-server");
  manager.updateDraft({ executablePath: "/opt/codex" });
  await manager.save();
  assert.equal(manager.getSnapshot().editor.error, "engine_operation_failed");
  assert.ok(!JSON.stringify(manager.getSnapshot()).includes("do-not-display"));
  await manager.revoke();
  assert.equal(manager.getSnapshot().phase, "authorization_required");
  assert.equal(manager.getSnapshot().editor, undefined, "revocation also retires an unsaved private draft");
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("explicit connection checks are row-local, reject stale evidence and never enable execution", async () => {
  const probe = deferred();
  const calls = [];
  const manager = new ExecutionEngineManager({ kind: "desktop", api: {
    async listProfiles() { return { profiles: [savedProfile(3)] }; },
    async probeConnection(id, revision) { calls.push([id, revision]); return probe.promise; },
  } });
  await manager.load();
  assert.deepEqual(calls, []);
  const pending = manager.checkConnection("codex-app-server");
  assert.equal(manager.getSnapshot().busy["codex-app-server"], "probe");
  assert.equal(manager.getSnapshot().busy["kimi-acp"], undefined);
  await manager.checkConnection("codex-app-server");
  probe.resolve({ profileId: "profile-codex", profileRevision: 2, configurationFingerprint: "fingerprint", status: "connected" });
  await pending;
  assert.deepEqual(calls, [["codex-app-server", 3]]);
  assert.equal(manager.getSnapshot().probes["codex-app-server"], undefined);
  assert.equal(manager.getSnapshot().errors["codex-app-server"], "profile_revision_conflict");
});

test("disconnect keeps referenced profiles and successful disconnect uses the current revision", async () => {
  let blocked = true;
  const manager = new ExecutionEngineManager({ kind: "desktop", api: {
    async listProfiles() { return { profiles: [savedProfile(3)] }; },
    async disconnectProfile(_id, revision) {
      assert.equal(revision, 3);
      if (blocked) throw Object.assign(new Error(""), { code: "profile_in_use" });
      return { profile: { ...savedProfile(4), status: "disconnected" } };
    },
  } });
  await manager.load();
  await manager.disconnect("codex-app-server");
  assert.equal(manager.getSnapshot().errors["codex-app-server"], "profile_in_use");
  assert.equal(manager.getSnapshot().profiles[0].status, "configured");
  blocked = false;
  await manager.disconnect("codex-app-server");
  assert.equal(manager.getSnapshot().profiles[0].status, "disconnected");
});

test("a successful protocol handshake with missing authentication is not displayed as a ready connection", () => {
  assert.equal(engineProbeOutcome({ status: "connected", connection: "connected", authentication: "required" }), "auth_required");
  assert.equal(engineProbeOutcome({ status: "connected", connection: "connected", authentication: "configured_unverified" }), "connected");
});

test("reloading an externally changed profile invalidates its old connection evidence", async () => {
  let revision = 3;
  const manager = new ExecutionEngineManager({ kind: "desktop", api: {
    async listProfiles() { return { profiles: [savedProfile(revision)] }; },
    async probeConnection() { return { profileId: "profile-codex", profileRevision: 3,
      configurationFingerprint: "fingerprint", status: "connected", authentication: "required" }; },
  } });
  await manager.load();
  await manager.checkConnection("codex-app-server");
  assert.equal(manager.getSnapshot().probes["codex-app-server"].profileRevision, 3);
  revision = 4;
  await manager.load();
  assert.equal(manager.getSnapshot().probes["codex-app-server"], undefined);
});

test("passive revalidation coalesces focus reads and preserves an editing draft", async () => {
  const refresh = deferred();
  let reads = 0;
  const manager = new ExecutionEngineManager({ kind: "desktop", api: {
    async listProfiles() { return ++reads === 1 ? { profiles: [savedProfile(3)] } : refresh.promise; },
    async probeConnection() { return { profileId: "profile-codex", profileRevision: 3,
      configurationFingerprint: "fingerprint", status: "connected", authentication: "required" }; },
  } });
  await manager.load();
  await manager.checkConnection("codex-app-server");
  manager.edit("codex-app-server");
  manager.updateDraft({ executablePath: "/unsaved/codex" });
  const editor = manager.getSnapshot().editor;
  const first = manager.revalidate();
  const second = manager.revalidate();
  assert.equal(reads, 2);
  refresh.resolve({ profiles: [savedProfile(4)] });
  await first;
  await second;
  assert.equal(manager.getSnapshot().profiles[0].revision, 4);
  assert.deepEqual(manager.getSnapshot().editor, editor);
  assert.equal(manager.getSnapshot().probes["codex-app-server"], undefined);
});

test("passive revalidation does not race an owned management operation or retry lost authority", async () => {
  const save = deferred();
  let reads = 0;
  const manager = new ExecutionEngineManager({ kind: "desktop", api: {
    async listProfiles() { reads++; return { profiles: [savedProfile()] }; },
    async saveProfile() { await save.promise; return { profile: savedProfile(2) }; },
  } });
  await manager.revalidate();
  assert.equal(reads, 0);
  await manager.load();
  manager.edit("codex-app-server");
  const saving = manager.save();
  await manager.revalidate();
  assert.equal(reads, 1);
  save.resolve();
  await saving;
  await manager.revalidate();
  assert.equal(reads, 2);

  const unauthorized = new ExecutionEngineManager({ kind: "web", api: {
    async listProfiles() { reads++; throw { code: "engine_session_invalid" }; },
  } });
  await unauthorized.load();
  await unauthorized.revalidate();
  assert.equal(reads, 3, "focus does not start an authorization retry loop");
});

test("lost authority clears private drafts/evidence and aborts late connection results", async () => {
  const probe = deferred();
  let reads = 0;
  let signal;
  const manager = new ExecutionEngineManager({ kind: "desktop", api: {
    async listProfiles() {
      if (++reads > 1) throw { code: "engine_authority_required" };
      return { profiles: [savedProfile()] };
    },
    async probeConnection(_id, _revision, abort) { signal = abort; return probe.promise; },
  } });
  await manager.load();
  manager.edit("codex-app-server");
  manager.updateDraft({ executablePath: "/unsaved/private/path" });
  const pending = manager.checkConnection("codex-app-server");
  await manager.load();
  assert.equal(signal.aborted, true);
  assert.equal(manager.getSnapshot().editor, undefined);
  assert.deepEqual(manager.getSnapshot().profiles, []);
  probe.resolve({ profileId: "profile-codex", profileRevision: 1,
    configurationFingerprint: "fingerprint", status: "connected", authentication: "configured_unverified" });
  await pending;
  assert.equal(manager.getSnapshot().phase, "authorization_required");
  assert.deepEqual(manager.getSnapshot().probes, {});
  assert.deepEqual(manager.getSnapshot().busy, {});
});

test("authentication metadata cannot hide a failed installation or protocol check", () => {
  for (const status of ["not_found", "not_executable", "unexpected_runtime", "protocol_error", "timed_out", "cancelled"]) {
    assert.equal(engineProbeOutcome({ status, authentication: "required" }), status);
  }
});
