import assert from "node:assert/strict";
import test from "node:test";

import {
  loadSelfHostedRunnerProfiles,
  verifySelfHostedRunnerEnvironment,
} from "../scripts/verify-cua-driver-self-hosted-runner.mjs";

const SHA = "a".repeat(40);

function macEnvironment(overrides = {}) {
  return {
    GITHUB_ACTIONS: "true",
    GITHUB_ACTOR: "tianxiaochannel-oss88",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REPOSITORY: "tianxiaochannel-oss88/ling-stack",
    GITHUB_SHA: SHA,
    GITHUB_TRIGGERING_ACTOR: "tianxiaochannel-oss88",
    GITHUB_WORKSPACE: "/Users/tianxiao/.github-actions/ling-cua-driver-macos-arm64-v1/_work/ling-stack/ling-stack",
    LING_CUA_EXPECTED_COMMIT: SHA,
    RUNNER_ARCH: "ARM64",
    RUNNER_ENVIRONMENT: "self-hosted",
    RUNNER_NAME: "ling-cua-driver-macos-arm64-v1",
    RUNNER_OS: "macOS",
    RUNNER_TEMP: "/Users/tianxiao/.github-actions/ling-cua-driver-macos-arm64-v1/_work/_temp",
    ...overrides,
  };
}

test("self-hosted runner manifest pins one dedicated identity per platform", async () => {
  const profiles = await loadSelfHostedRunnerProfiles();
  assert.equal(profiles.runnerVersion, "2.336.0");
  assert.deepEqual(Object.keys(profiles.profiles).sort(), ["darwin", "win32-x64"]);
  assert.equal(profiles.profiles.darwin.label, "ling-cua-driver-macos-arm64-v1");
  assert.equal(profiles.profiles["win32-x64"].label, "ling-cua-driver-windows-x64-v1");
});

test("macOS runner accepts only the fixed dispatch, actor, commit, host and work roots", async () => {
  const result = await verifySelfHostedRunnerEnvironment({
    env: macEnvironment(),
    hostPlatform: "darwin",
    platform: "darwin",
    verifyFilesystem: false,
    verifyNativeToolchain: false,
    verifyRunnerBinary: false,
  });
  assert.equal(result.ok, true);

  const rejected = [
    ["GITHUB_ACTIONS", "false", /inside GitHub Actions/u],
    ["RUNNER_ENVIRONMENT", "github-hosted", /not self-hosted/u],
    ["GITHUB_EVENT_NAME", "pull_request", /only workflow_dispatch/u],
    ["GITHUB_REPOSITORY", "someone/fork", /repository mismatch/u],
    ["GITHUB_ACTOR", "mallory", /actor mismatch/u],
    ["GITHUB_TRIGGERING_ACTOR", "mallory", /triggering actor mismatch/u],
    ["RUNNER_NAME", "generic-mac", /runner name mismatch/u],
    ["RUNNER_OS", "Linux", /runner OS mismatch/u],
    ["RUNNER_ARCH", "X64", /runner architecture mismatch/u],
    ["RUNNER_TEMP", "/tmp", /escapes the locked work root/u],
    ["GITHUB_WORKSPACE", "/tmp/repo", /escapes the locked work root/u],
    ["LING_CUA_EXPECTED_COMMIT", "b".repeat(40), /caller anchor/u],
    ["GITHUB_SHA", "main", /full commit/u],
  ];
  for (const [key, value, pattern] of rejected) {
    await assert.rejects(
      verifySelfHostedRunnerEnvironment({
        env: macEnvironment({ [key]: value }),
        hostPlatform: "darwin",
        platform: "darwin",
        verifyFilesystem: false,
        verifyNativeToolchain: false,
        verifyRunnerBinary: false,
      }),
      pattern,
      key,
    );
  }
});

test("runner profile cannot cross the host platform", async () => {
  await assert.rejects(
    verifySelfHostedRunnerEnvironment({
      env: macEnvironment(),
      hostPlatform: "linux",
      platform: "darwin",
      verifyFilesystem: false,
      verifyNativeToolchain: false,
      verifyRunnerBinary: false,
    }),
    /host platform mismatch/u,
  );
});
