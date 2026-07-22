#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { loadProviderLock } from "./cua-driver-source-build-lib.mjs";
import { verifyToolchain } from "./cua-driver-source-build-toolchain.mjs";

const execFile = promisify(execFileCallback);
const PROFILE_PATH = fileURLToPath(
  new URL("../../../.github/cua-driver-self-hosted-runners.json", import.meta.url),
);

export async function loadSelfHostedRunnerProfiles(path = PROFILE_PATH) {
  const value = JSON.parse(await readFile(path, "utf8"));
  assertExactKeys(value, [
    "allowedActor",
    "eventName",
    "profiles",
    "repository",
    "runnerVersion",
    "schemaVersion",
  ], "self-hosted runner manifest");
  assert(value.schemaVersion === 1, "self-hosted runner manifest version changed");
  assert(value.repository === "tianxiaochannel-oss88/ling-stack", "runner repository changed");
  assert(value.eventName === "workflow_dispatch", "runner event changed");
  assert(value.allowedActor === "tianxiaochannel-oss88", "runner actor changed");
  assert(value.runnerVersion === "2.336.0", "runner version changed");
  assertExactKeys(value.profiles, ["darwin", "win32-x64"], "runner profiles");
  for (const [platform, profile] of Object.entries(value.profiles)) {
    assertExactKeys(profile, [
      "label",
      "runnerArch",
      "runnerName",
      "runnerOS",
      "runnerRoot",
      "workRoot",
    ], `${platform} runner profile`);
    assert(profile.label === profile.runnerName, `${platform} runner label must equal its name`);
    assert(profile.runnerName === `ling-cua-driver-${platform === "darwin" ? "macos-arm64" : "windows-x64"}-v1`, `${platform} runner identity changed`);
    assert(isAbsoluteForPlatform(profile.runnerRoot, platform), `${platform} runner root must be absolute`);
    assert(isAbsoluteForPlatform(profile.workRoot, platform), `${platform} runner work root must be absolute`);
    assert(isPathInside(profile.workRoot, profile.runnerRoot, platform), `${platform} work root escapes its runner root`);
  }
  return value;
}

export async function verifySelfHostedRunnerEnvironment({
  env = process.env,
  hostPlatform = process.platform,
  platform,
  profiles,
  verifyFilesystem = true,
  verifyRunnerBinary = true,
  verifyNativeToolchain = true,
} = {}) {
  assert(platform === "darwin" || platform === "win32-x64", "runner platform is invalid");
  const manifest = profiles ?? await loadSelfHostedRunnerProfiles();
  const profile = manifest.profiles[platform];
  const expectedHost = platform === "darwin" ? "darwin" : "win32";
  assert(hostPlatform === expectedHost, `runner host platform mismatch: ${hostPlatform}`);
  assert(env.GITHUB_ACTIONS === "true", "runner must execute inside GitHub Actions");
  assert(env.RUNNER_ENVIRONMENT === "self-hosted", "runner environment is not self-hosted");
  assert(env.GITHUB_EVENT_NAME === manifest.eventName, "runner accepts only workflow_dispatch");
  assert(env.GITHUB_REPOSITORY === manifest.repository, "runner repository mismatch");
  assert(env.GITHUB_ACTOR === manifest.allowedActor, "runner actor mismatch");
  assert(env.GITHUB_TRIGGERING_ACTOR === manifest.allowedActor, "runner triggering actor mismatch");
  assert(env.RUNNER_NAME === profile.runnerName, "runner name mismatch");
  assert(env.RUNNER_OS === profile.runnerOS, "runner OS mismatch");
  assert(env.RUNNER_ARCH === profile.runnerArch, "runner architecture mismatch");
  assert(isAbsoluteForPlatform(env.RUNNER_TEMP, platform), "RUNNER_TEMP must be absolute");
  assert(isAbsoluteForPlatform(env.GITHUB_WORKSPACE, platform), "GITHUB_WORKSPACE must be absolute");
  assert(isPathInside(env.RUNNER_TEMP, profile.workRoot, platform), "RUNNER_TEMP escapes the locked work root");
  assert(isPathInside(env.GITHUB_WORKSPACE, profile.workRoot, platform), "GITHUB_WORKSPACE escapes the locked work root");
  assert(/^[0-9a-f]{40}$/u.test(env.GITHUB_SHA ?? ""), "GITHUB_SHA is not a full commit");
  assert(env.LING_CUA_EXPECTED_COMMIT === env.GITHUB_SHA, "dispatched commit does not match the caller anchor");

  if (verifyFilesystem) {
    await assertRealDirectory(profile.runnerRoot, "runner root");
    await assertRealDirectory(profile.workRoot, "runner work root");
    await assertRealDirectory(env.RUNNER_TEMP, "runner temp");
    await assertRealDirectory(env.GITHUB_WORKSPACE, "GitHub workspace");
  }
  if (verifyRunnerBinary) {
    const binary = resolve(
      profile.runnerRoot,
      "bin",
      platform === "darwin" ? "Runner.Listener" : "Runner.Listener.exe",
    );
    const { stdout } = await execFile(binary, ["--version"], {
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true,
    });
    assert(stdout.trim() === manifest.runnerVersion, "runner binary version mismatch");
  }
  let toolchain;
  if (verifyNativeToolchain) {
    const { value: lock } = await loadProviderLock();
    assert(lock.toolchain[platform === "darwin" ? "darwin" : "win32X64"].runner === profile.label, "source-build runner pin disagrees with the registered profile");
    toolchain = await verifyToolchain(platform, lock);
  }
  return Object.freeze({
    ok: true,
    platform,
    runnerName: profile.runnerName,
    runnerVersion: manifest.runnerVersion,
    toolchain: toolchain?.evidence,
  });
}

function isAbsoluteForPlatform(value, platform) {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) return false;
  return platform === "darwin" ? value.startsWith("/") : /^[A-Za-z]:[\\/]/u.test(value);
}

function normalizePath(value, platform) {
  const normalized = String(value).replaceAll("\\", "/").replace(/\/+$/u, "");
  return platform === "win32-x64" ? normalized.toLowerCase() : normalized;
}

function isPathInside(candidate, root, platform) {
  const candidateValue = normalizePath(candidate, platform);
  const rootValue = normalizePath(root, platform);
  return candidateValue.startsWith(`${rootValue}/`) && candidateValue !== rootValue;
}

async function assertRealDirectory(path, label) {
  const info = await lstat(path);
  assert(info.isDirectory() && !info.isSymbolicLink(), `${label} is not a real directory`);
  assert(await realpath(path) === resolve(path), `${label} resolves through a symlink`);
}

function assertExactKeys(value, expected, label) {
  assert(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  assert(JSON.stringify(actual) === JSON.stringify(wanted), `${label} keys changed`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) throw new Error(`unexpected argument: ${key}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${key}`);
    result[key.slice(2)] = value;
    index += 1;
  }
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await verifySelfHostedRunnerEnvironment({ platform: args.platform });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
