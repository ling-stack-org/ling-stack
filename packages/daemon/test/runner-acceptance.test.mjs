import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { assessRunnerAcceptance } from "../dist/runtime/runner-acceptance.js";

const now = Date.parse("2026-09-08T00:00:00Z");
const identity = {
  runnerId: "codex-app-server",
  runtimeVersion: "fixture-runtime-1",
  sdkVersion: "native-schema-fixture-1",
  adapterVersion: "fixture-adapter-1",
  executableDigest: "a".repeat(64),
  platform: "darwin",
  architecture: "arm64",
  profileId: "profile_fixture",
  profileRevision: 2,
  configurationFingerprint: "b".repeat(64),
  workspaceId: "workspace_fixture",
  policyFingerprint: "c".repeat(64),
  workflowSurface: "normal_conversation",
};

function evidence(overrides = {}) {
  const { profileId, profileRevision, configurationFingerprint, workspaceId, ...releaseIdentity } = identity;
  return {
    schemaVersion: 1,
    id: "fixture-evidence-not-real-acceptance",
    identity: { ...identity },
    verifiedAt: "2026-09-07T00:00:00Z",
    expiresAt: "2026-09-09T00:00:00Z",
    releaseEvidenceId: "fixture-release-not-real-acceptance",
    release: {
      schemaVersion: 1,
      id: "fixture-release-not-real-acceptance",
      identity: releaseIdentity,
      verifiedAt: "2026-09-07T00:00:00Z",
      expiresAt: "2026-09-09T00:00:00Z",
      checks: {
        protocol: "passed",
        permissions: "passed",
        workspace: "passed",
        artifacts: "passed",
        cancellation: "passed",
        recovery: "passed",
        real_runtime: "passed",
        packaged: "passed",
      },
    },
    checks: { installation: "passed", authentication: "passed", connection: "passed", workspace_binding: "passed" },
    ...overrides,
  };
}

test("a new profile uses fresh host verification without repeating package certification", () => {
  const nextIdentity = { ...identity, profileId: "new-profile", profileRevision: 1, workspaceId: "new-workspace", configurationFingerprint: "d".repeat(64) };
  const nextEvidence = evidence({ id: "new-host-evidence", identity: nextIdentity });
  assert.deepEqual(nextEvidence.release, evidence().release);
  assert.equal(assessRunnerAcceptance(nextIdentity, evidence(), now).status, "blocked");
  assert.equal(assessRunnerAcceptance(nextIdentity, nextEvidence, now).status, "accepted");
});

test("host verification cannot substitute for missing, stale or mismatched release evidence", () => {
  assert.equal(assessRunnerAcceptance(identity, evidence({ release: undefined }), now).reason, "verification_missing");
  assert.equal(assessRunnerAcceptance(identity, evidence({ releaseEvidenceId: "another-release" }), now).reason, "verification_mismatch");
  const release = evidence().release;
  assert.equal(assessRunnerAcceptance(identity, evidence({ release: { ...release, revokedAt: "2026-09-08T00:00:00Z" } }), now).reason, "verification_revoked");
  assert.equal(assessRunnerAcceptance(identity, evidence({ release: { ...release, expiresAt: "2026-09-08T00:00:00Z" } }), now).reason, "verification_expired");
  assert.equal(assessRunnerAcceptance(identity, evidence({ release: { ...release, identity: { ...release.identity, adapterVersion: "old" } } }), now).reason, "verification_mismatch");
  for (const key of Object.keys(release.checks)) {
    assert.equal(assessRunnerAcceptance(identity, evidence({ release: { ...release, checks: { ...release.checks, [key]: "not_run" } } }), now).reason, "verification_incomplete");
  }
});

test("only complete current identity-bound verification is accepted", () => {
  assert.deepEqual(assessRunnerAcceptance(identity, evidence(), now), { status: "accepted" });
  assert.equal(assessRunnerAcceptance(identity, undefined, now).reason, "verification_missing");
  assert.equal(assessRunnerAcceptance(identity, { readinessPassed: true, conformancePassed: true }, now).reason, "verification_invalid");
});

for (const key of Object.keys(identity)) {
  test(`verification for a different ${key} is not reusable`, () => {
    const different = { ...identity, [key]: key === "profileRevision" ? 3 : `${identity[key]}-changed` };
    assert.equal(assessRunnerAcceptance(different, evidence(), now).reason, "verification_mismatch");
  });
}

test("expired, revoked, future and malformed evidence fails closed", () => {
  assert.equal(assessRunnerAcceptance(identity, evidence({ expiresAt: new Date(now).toISOString() }), now).reason, "verification_expired");
  assert.equal(assessRunnerAcceptance(identity, evidence({ revokedAt: "2026-09-07T12:00:00Z" }), now).reason, "verification_revoked");
  for (const patch of [
    { schemaVersion: 2 }, { id: "" }, { identity: {} }, { identity: undefined },
    { verifiedAt: "2026-09-08T00:00:01Z" }, { verifiedAt: "invalid" },
    { expiresAt: "invalid" }, { expiresAt: "2026-09-06T00:00:00Z" },
  ]) {
    assert.equal(assessRunnerAcceptance(identity, evidence(patch), now).status, "blocked");
  }
  assert.equal(assessRunnerAcceptance(identity, evidence(), Number.NaN).reason, "verification_invalid");
});

for (const key of Object.keys(evidence().checks)) {
  test(`${key} cannot be missing, failed or replaced by a truthy flag`, () => {
    for (const value of [undefined, "failed", "not_run", true]) {
      assert.equal(assessRunnerAcceptance(identity, evidence({ checks: { ...evidence().checks, [key]: value } }), now).reason, "verification_incomplete");
    }
  });
}


test("automation and external work cannot reuse task acceptance", async () => {
  const { assertNativeExecutionAccepted } = await import("../dist/features/execution-engines/native-admission.js");
  const { fixtureNativeAcceptance, fixtureNativePolicy } = await import("./support/fixture-native-acceptance.mjs");
  for (const kind of ["automation", "external_work"]) {
    const input = { runRequest: { cwd: "/fixture", threadId: "thread", task: {}, executionBinding: {
      kind: "native_profile", engineId: "codex-app-server", profileId: "profile", profileRevision: 1,
    } }, store: { getLingThread: () => ({ kind }) }, effectivePolicySnapshot: {}, signal: new AbortController().signal };
    const options = { readWorkspaceSettings: () => fixtureNativePolicy("codex-app-server"),
      readAcceptanceEvidence: current => fixtureNativeAcceptance({ ...current, workflowSurface: "task" }) };
    const profile = { id: "profile", revision: 1, configuration: { engineId: "codex-app-server" }, configurationFingerprint: "config" };
    const installation = { runtimeVersion: "fixture", executableDigest: "digest" };
    await assert.rejects(assertNativeExecutionAccepted(options, input, profile, installation), error => error.code === "native_execution_verification_mismatch");
    await assertNativeExecutionAccepted({ ...options, readAcceptanceEvidence: fixtureNativeAcceptance }, input, profile, installation);
  }
});


test("parent-thread inheritance cannot reuse task acceptance", async () => {
  const { assertNativeExecutionAccepted } = await import("../dist/features/execution-engines/native-admission.js");
  const { fixtureNativeAcceptance, fixtureNativePolicy } = await import("./support/fixture-native-acceptance.mjs");
  for (const kind of ["automation", "external_work", "teammate_direct"]) {
    const input = { runRequest: { cwd: "/fixture", parentRunId: "parent", task: {}, executionBinding: {
      kind: "native_profile", engineId: "codex-app-server", profileId: "profile", profileRevision: 1,
    } }, store: { getRun: () => ({ threadId: "inherited-thread" }), getLingThread: () => ({ kind }) }, effectivePolicySnapshot: {}, signal: new AbortController().signal };
    const options = { readWorkspaceSettings: () => fixtureNativePolicy("codex-app-server"),
      readAcceptanceEvidence: current => fixtureNativeAcceptance({ ...current, workflowSurface: "task" }) };
    const profile = { id: "profile", revision: 1, configuration: { engineId: "codex-app-server" }, configurationFingerprint: "config" };
    await assert.rejects(assertNativeExecutionAccepted(options, input, profile, { runtimeVersion: "fixture", executableDigest: "digest" }),
      error => error.code === "native_execution_verification_mismatch");
  }
});

for (const engineId of ["kimi-acp", "openclaw-acp"]) {
  test(`ACP admission for ${engineId} binds verification to the installed SDK version`, async () => {
    const { assertNativeExecutionAccepted } = await import("../dist/features/execution-engines/native-admission.js");
    const { fixtureNativeAcceptance, fixtureNativePolicy } = await import("./support/fixture-native-acceptance.mjs");
    const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.resolve("@agentclientprotocol/sdk")), "utf8"));
    const input = { runRequest: { cwd: "/fixture", task: {}, executionBinding: {
      kind: "native_profile", engineId, profileId: "profile", profileRevision: 1,
    } }, store: {}, effectivePolicySnapshot: {}, signal: new AbortController().signal };
    const profile = { id: "profile", revision: 1, configuration: { engineId }, configurationFingerprint: "config" };
    const installation = { runtimeVersion: "fixture", executableDigest: "digest" };
    const observed = [];
    const options = { readWorkspaceSettings: () => fixtureNativePolicy(engineId), readAcceptanceEvidence(current) {
      observed.push(current);
      return fixtureNativeAcceptance(current);
    } };
    const assertCurrent = await assertNativeExecutionAccepted(options, input, profile, installation);
    assertCurrent();
    assert.ok(observed.length >= 2, "admission and final submission must both check verification");
    for (const current of observed) assert.equal(current.sdkVersion, `@agentclientprotocol/sdk@${version}`);

    const previousSdkEvidence = fixtureNativeAcceptance({ ...observed[0], sdkVersion: "@agentclientprotocol/sdk@1.3.0" });
    await assert.rejects(assertNativeExecutionAccepted({ ...options, readAcceptanceEvidence: () => previousSdkEvidence }, input, profile, installation),
      error => error.code === "native_execution_verification_mismatch");
  });
}
