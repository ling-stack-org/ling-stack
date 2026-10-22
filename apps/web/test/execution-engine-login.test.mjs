import assert from "node:assert/strict";
import test from "node:test";
import { ExecutionEngineLoginController, engineLoginMethod, interactiveEngineLoginMethod } from "../src/features/settings/execution-engines/execution-engine-manager.ts";

const profile = {
  id: "profile-codex", revision: 3, status: "configured",
  configuration: { engineId: "codex-app-server", executablePath: "/opt/codex", authProfileId: "ling" },
};
const waiting = {
  id: "login-operation", engineId: "codex-app-server", profileId: "profile-codex", profileRevision: 3,
  status: "waiting", expiresAt: "2026-09-09T00:10:00Z",
  challenge: { type: "device_code", url: "https://auth.openai.com/codex/device", userCode: "TEST-ONLY" },
};

test("native sign-in is explicit, bound to the saved profile, and completed only by the server", async () => {
  const calls = [];
  const controller = new ExecutionEngineLoginController({ kind: "desktop", api: {
    async startLogin(...args) { calls.push(args); return waiting; },
    async getLogin(...args) { calls.push(args); return { ...waiting, profileRevision: 4, status: "completed", authentication: "login_completed" }; },
  } });
  assert.equal(controller.getSnapshot(), undefined);
  assert.deepEqual(calls, []);
  await controller.start(profile);
  assert.deepEqual(calls, [["codex-app-server", 3, "chatgptDeviceCode"]]);
  assert.equal(controller.getSnapshot().operation.status, "waiting");
  assert.equal(controller.getSnapshot().operation.challenge.userCode, "TEST-ONLY");
  await controller.refresh();
  assert.equal(controller.getSnapshot().operation.status, "completed");
  assert.equal(controller.getSnapshot().operation.profileRevision, 4, "native adoption commits a new saved profile revision");
  assert.equal(controller.getSnapshot().operation.challenge, undefined, "completed challenges never remain in the view");
  controller.close();
  assert.equal(controller.getSnapshot(), undefined);
});

test("explicit API-key setup sends only the saved profile revision and reports local configuration", async () => {
  for (const engineId of ["codex-app-server", "claude-agent-sdk", "kimi-acp"]) {
    const keyed = { ...profile, configuration: { ...profile.configuration, engineId, secretRef: "env:OWNED_TEST_KEY",
      ...(engineId === "kimi-acp" ? { kimi: { providerType: "kimi", baseUrl: "https://fixture.example.test/v1",
        modelId: "fixture-model", maxContextSize: 32000 } } : {}) } };
    const calls = [];
    const controller = new ExecutionEngineLoginController({ kind: "desktop", api: {
      async startLogin(...args) {
        calls.push(args);
        return { ...waiting, engineId, profileRevision: 4, status: "completed", challenge: undefined,
          authentication: "configured_unverified" };
      },
    } });
    assert.deepEqual(calls, []);
    await controller.start(keyed);
    assert.deepEqual(calls, [[engineId, 3, "apiKey"]]);
    assert.equal(controller.getSnapshot().method, "apiKey");
    assert.equal(controller.getSnapshot().operation.authentication, "configured_unverified");
    assert.equal(controller.getSnapshot().operation.challenge, undefined);
    controller.close();
    assert.equal(controller.getSnapshot(), undefined);
  }
});

test("foreign or stale login responses cannot replace the owned operation", async () => {
  for (const patch of [{ id: "foreign-operation" }, { profileId: "foreign-profile" }, { profileRevision: 4 },
    { profileRevision: 3, status: "completed" }, { profileRevision: 5, status: "completed" }]) {
    const controller = new ExecutionEngineLoginController({ kind: "desktop", api: {
      async startLogin() { return waiting; },
      async getLogin() { return { ...waiting, ...patch }; },
    } });
    await controller.start(profile);
    await controller.refresh();
    assert.equal(controller.getSnapshot().error, "engine_operation_failed");
    assert.equal(controller.getSnapshot().operation.id, waiting.id);
    assert.equal(controller.getSnapshot().operation.status, "waiting");
    assert.equal(controller.getSnapshot().operation.challenge, undefined);
  }
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("cancelling during start reaps the eventual owned operation without displaying its code", async () => {
  const started = deferred();
  const calls = [];
  const observedChallenges = [];
  const controller = new ExecutionEngineLoginController({ kind: "desktop", api: {
    async startLogin() { calls.push("start"); return started.promise; },
    async cancelLogin(...args) { calls.push(args); return { ...waiting, status: "cancelled" }; },
  } });
  controller.subscribe(() => { if (controller.getSnapshot()?.operation?.challenge) observedChallenges.push("challenge"); });
  const pending = controller.start(profile);
  await controller.start(profile);
  await controller.cancel();
  controller.close();
  assert.equal(controller.getSnapshot().pending, "cancel");
  started.resolve(waiting);
  await pending;
  assert.deepEqual(calls, ["start", ["codex-app-server", "login-operation"]]);
  assert.deepEqual(observedChallenges, []);
  assert.equal(controller.getSnapshot().operation.status, "cancelled");
});

test("a late status read cannot revive a cancelled login or its challenge", async () => {
  const read = deferred();
  const controller = new ExecutionEngineLoginController({ kind: "desktop", api: {
    async startLogin() { return waiting; },
    async getLogin() { return read.promise; },
    async cancelLogin() { return { ...waiting, status: "cancelled" }; },
  } });
  await controller.start(profile);
  const pendingRead = controller.refresh();
  await controller.cancel();
  read.resolve(waiting);
  await pendingRead;
  assert.equal(controller.getSnapshot().operation.status, "cancelled");
  assert.equal(controller.getSnapshot().operation.challenge, undefined);
});

test("failed cancellation stays retryable without leaking server output or losing ownership", async () => {
  let attempts = 0;
  const controller = new ExecutionEngineLoginController({ kind: "desktop", api: {
    async startLogin() { return waiting; },
    async cancelLogin() {
      if (++attempts === 1) throw new Error("private native output");
      return { ...waiting, status: "cancelled" };
    },
  } });
  await controller.start(profile);
  await controller.cancel();
  assert.equal(controller.getSnapshot().error, "engine_operation_failed");
  assert.equal(controller.getSnapshot().operation.challenge, undefined);
  controller.close();
  assert.ok(controller.getSnapshot(), "failed cancellation cannot pretend the operation ended");
  await controller.cancel();
  assert.equal(attempts, 2);
  controller.close();
  assert.equal(controller.getSnapshot(), undefined);
});

test("interactive login never guesses Kimi region or offers unsupported account routes", () => {
  const kimi = { ...profile, configuration: { ...profile.configuration, engineId: "kimi-acp" } };
  assert.equal(interactiveEngineLoginMethod(kimi), undefined);
  assert.equal(interactiveEngineLoginMethod({ ...kimi, configuration: { ...kimi.configuration, kimiLoginRegion: "global" } }), "terminal");
  for (const engineId of ["claude-agent-sdk", "openclaw-acp"]) {
    assert.equal(interactiveEngineLoginMethod({ ...profile, configuration: { ...profile.configuration, engineId } }), undefined);
  }
  assert.equal(interactiveEngineLoginMethod({ ...profile, status: "disconnected" }), undefined);
  assert.equal(interactiveEngineLoginMethod({ ...profile, configuration: { ...profile.configuration, secretRef: "keychain:owned" } }), undefined);
});

test("key setup is absent for disconnected, incomplete Kimi and bridge-only OpenClaw profiles", () => {
  const keyed = { ...profile, configuration: { ...profile.configuration, secretRef: "keychain:owned-test" } };
  assert.equal(engineLoginMethod(keyed), "apiKey");
  assert.equal(engineLoginMethod({ ...keyed, status: "disconnected" }), undefined);
  assert.equal(engineLoginMethod({ ...keyed, configuration: { ...keyed.configuration, engineId: "kimi-acp" } }), undefined);
  assert.equal(engineLoginMethod({ ...keyed, configuration: { ...keyed.configuration, engineId: "openclaw-acp" } }), undefined);
  assert.equal(engineLoginMethod({ ...profile, configuration: { ...profile.configuration, engineId: "claude-agent-sdk" } }), undefined);
});

test("expired management authority drops the private challenge and lets the user leave the lost login", async () => {
  const controller = new ExecutionEngineLoginController({ kind: "desktop", api: {
    async startLogin() { return waiting; },
    async getLogin() { throw Object.assign(new Error("private-token"), { code: "engine_authority_required" }); },
  } });
  await controller.start(profile);
  await controller.refresh();
  assert.equal(controller.getSnapshot().error, "engine_authority_required");
  assert.equal(controller.getSnapshot().operation, undefined, "no longer claim control over an operation owned by expired authority");
  controller.close();
  assert.equal(controller.getSnapshot(), undefined);
});

test("a host-confirmed missing login can be closed without cancelling a replacement operation", async () => {
  for (const action of ["refresh", "cancel"]) {
    const calls = [];
    const controller = new ExecutionEngineLoginController({ kind: "desktop", api: {
      async startLogin() { return waiting; },
      async getLogin() { calls.push("read"); throw { code: "engine_login_not_found" }; },
      async cancelLogin() { calls.push("cancel"); throw { code: "engine_login_not_found" }; },
    } });
    await controller.start(profile);
    await controller[action]();
    assert.equal(controller.getSnapshot().error, "engine_login_not_found");
    assert.equal(controller.getSnapshot().operation, undefined, "do not retain an unaddressable waiting operation");
    assert.equal(controller.getSnapshot().pending, undefined);
    controller.close();
    assert.equal(controller.getSnapshot(), undefined);
    assert.deepEqual(calls, [action === "refresh" ? "read" : "cancel"]);
    await controller.start(profile);
    assert.equal(controller.getSnapshot().operation.status, "waiting");
    assert.equal(controller.getSnapshot().cancelRequested, undefined);
  }
});

test("transient status failure retains ownership and retries the same operation", async () => {
  let reads = 0;
  const ids = [];
  const controller = new ExecutionEngineLoginController({ kind: "desktop", api: {
    async startLogin() { return waiting; },
    async getLogin(engineId, id) {
      ids.push(id);
      if (++reads === 1) throw new Error("private transport diagnostic");
      return waiting;
    },
  } });
  await controller.start(profile);
  await controller.refresh();
  assert.equal(controller.getSnapshot().operation.id, waiting.id);
  assert.equal(controller.getSnapshot().operation.challenge, undefined);
  controller.close();
  assert.ok(controller.getSnapshot(), "unknown network failure is not terminal");
  await controller.refresh();
  assert.equal(controller.getSnapshot().error, undefined);
  assert.equal(controller.getSnapshot().operation.challenge.userCode, "TEST-ONLY");
  assert.deepEqual(ids, [waiting.id, waiting.id]);
});

test("server terminal outcomes clear challenges and never start another login without a user action", async () => {
  for (const status of ["timed_out", "failed", "cancelled"]) {
    let starts = 0;
    const controller = new ExecutionEngineLoginController({ kind: "desktop", api: {
      async startLogin() { starts++; return waiting; },
      async getLogin() { return { ...waiting, status }; },
    } });
    await controller.start(profile);
    await controller.refresh();
    assert.equal(controller.getSnapshot().operation.status, status);
    assert.equal(controller.getSnapshot().operation.challenge, undefined);
    await controller.refresh();
    assert.equal(starts, 1);
    controller.close();
    assert.equal(controller.getSnapshot(), undefined);
    await controller.start(profile);
    assert.equal(starts, 2);
    assert.equal(controller.getSnapshot().operation.status, "waiting");
  }
});
