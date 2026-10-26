import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { desktopCandidatePackageSelection, parseDesktopCandidateArguments } from "./prepare-desktop-candidate.mjs";
import { hostedRunnerStorage } from "./resource-workspace.mjs";

test("desktop candidate CLI requires explicit native tools and one storage policy", () => {
  const args = ["--workspace", "/new/root", "--bun", "/tool/bun", "--shell", "/bin/bash"];
  assert.equal(parseDesktopCandidateArguments(args)["stop-after"], undefined);
  assert.equal(parseDesktopCandidateArguments([...args, "--ci-ephemeral"]).ciEphemeral, true);
  for (const more of [["--release-ready"], ["--workspace", "/other"], ["--stop-after", "publish"], ["--ci-ephemeral", "--mount", "/mount"]]) {
    assert.throws(() => parseDesktopCandidateArguments([...args, ...more]), /gstack_desktop|Usage/);
  }
  assert.throws(() => parseDesktopCandidateArguments(["--workspace", "relative", "--bun", "/bun", "--shell", "/bash"]), /absolute_path/);
});

test("ephemeral storage stays bound to one hosted job and its canonical temporary directory", async t => {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "gstack-ci-policy-")));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = join(temporary, "resources");
  const env = { GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted", GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "2", GITHUB_JOB: "macos", RUNNER_TEMP: temporary };
  const admitted = await hostedRunnerStorage(root, env);
  assert.deepEqual(admitted.runnerIdentity, { runId: "123", runAttempt: "2", job: "macos" });
  assert.equal(admitted.storagePolicy, "github-hosted-ephemeral");
  for (const mutation of [{ RUNNER_ENVIRONMENT: "self-hosted" }, { GITHUB_RUN_ID: "" }, { GITHUB_ACTIONS: "false" }, { GITHUB_JOB: "../bad" }]) {
    await assert.rejects(hostedRunnerStorage(root, { ...env, ...mutation }), /hosted_identity_required/);
  }
  await assert.rejects(hostedRunnerStorage(temporary, env), /ephemeral_path_invalid/);
  await assert.rejects(hostedRunnerStorage(join(temporary, "../outside"), env), /ephemeral_path_invalid/);
  await mkdir(root);
});

test("desktop SDK exclusions stay limited to independently reviewed native targets", () => {
  assert.equal(desktopCandidatePackageSelection({ platform: "darwin", arch: "arm64" }), "reviewed-sdk-only");
  assert.equal(desktopCandidatePackageSelection({ platform: "win32", arch: "x64" }), "reviewed-sdk-only");
  for (const target of [{ platform: "win32", arch: "arm64" }, { platform: "darwin", arch: "x64" },
    { platform: "linux", arch: "arm64" }]) {
    assert.equal(desktopCandidatePackageSelection(target), "retain-complete-upstream");
  }
});
