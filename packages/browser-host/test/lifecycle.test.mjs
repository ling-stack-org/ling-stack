import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { supportsNativeHostBuild } from "../scripts/test.mjs";
import {
  browserHostStatus,
  buildDevelopmentBrowserHost,
  createChromeBrowserRuntimeDescriptor,
  installBrowserHost,
  publishChromeBrowserRuntimeDescriptor,
  readChromeBrowserRuntimeDescriptor,
  removeChromeBrowserRuntimeDescriptor,
  uninstallBrowserHost,
} from "../dist/index.js";

test("development install delegates to the signed native Host build", {
  skip: !supportsNativeHostBuild(process.platform, process.arch),
}, async () => {
  const commands = [];
  const hostPath = await buildDevelopmentBrowserHost({
    runCommand: async (file, args) => { commands.push([file, ...args]); },
  });
  assert.equal(hostPath.endsWith(process.platform === "win32" ? "ling-browser-host.exe" : "ling-browser-host"), true);
  assert.equal(commands.length, 1);
  assert.equal(commands[0][0], process.execPath);
  assert.equal(commands[0][1].endsWith("scripts/build-native.mjs"), true);
});

test("macOS browser Host install is idempotent and uninstall removes only owned manifests", async () => {
  const root = await mkdtemp(join(tmpdir(), "ling-browser-host-mac-"));
  const hostPath = join(root, "ling-browser-host");
  await writeFile(hostPath, "host", { mode: 0o700 });
  const first = await installBrowserHost({ hostPath, platform: "darwin", homeDirectory: root });
  const second = await installBrowserHost({ hostPath, platform: "darwin", homeDirectory: root });
  assert.equal(first.installed, true);
  assert.deepEqual(second, first);
  for (const manifestPath of first.manifestPaths) {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.equal(manifest.name, "com.lingstack.browser");
    assert.equal(manifest.path, hostPath);
    assert.equal((await stat(manifestPath)).mode & 0o777, 0o600);
  }
  const removed = await uninstallBrowserHost({ hostPath, platform: "darwin", homeDirectory: root });
  assert.equal(removed.installed, false);
  assert.deepEqual(removed.missing.sort(), [...first.manifestPaths].sort());
});

test("Windows browser Host install registers HKCU and uninstall removes exact entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "ling-browser-host-win-"));
  const hostPath = join(root, "ling-browser-host.exe");
  await writeFile(hostPath, "host");
  const commands = [];
  const registry = new Map();
  const previousUsername = process.env.USERNAME;
  process.env.USERNAME = "ling-test-user";
  try {
    const status = await installBrowserHost({
      hostPath,
      platform: "win32",
      homeDirectory: root,
      localAppData: join(root, "AppData", "Local"),
      runCommand: async (file, args) => {
        commands.push([file, ...args]);
        if (file === "reg.exe" && args[0] === "ADD") registry.set(args[1], args[6]);
      },
    });
    assert.equal(status.installed, true);
    assert.equal(commands.filter(([file]) => file === "reg.exe").length, 2);
    assert.equal(commands.some(([file]) => file === "icacls.exe"), true);
    await uninstallBrowserHost({
      hostPath,
      platform: "win32",
      homeDirectory: root,
      localAppData: join(root, "AppData", "Local"),
      runCommand: async (file, args) => {
        commands.push([file, ...args]);
        if (file === "reg.exe" && args[0] === "DELETE") registry.delete(args[1]);
        if (file === "reg.exe" && args[0] === "QUERY") {
          return { stdout: registry.get(args[1]) ?? "", stderr: "" };
        }
      },
    });
    assert.equal(commands.filter((entry) => entry[0] === "reg.exe" && entry[1] === "DELETE").length, 2);
  } finally {
    if (previousUsername === undefined) delete process.env.USERNAME;
    else process.env.USERNAME = previousUsername;
  }
});

test("Windows browser Host status requires both manifest and HKCU registration", async () => {
  const root = await mkdtemp(join(tmpdir(), "ling-browser-host-win-status-"));
  const hostPath = join(root, "ling-browser-host.exe");
  const localAppData = join(root, "AppData", "Local");
  await writeFile(hostPath, "host");
  const registry = new Map();
  const previousUsername = process.env.USERNAME;
  process.env.USERNAME = "ling-test-user";
  try {
    const runCommand = async (file, args) => {
      if (file === "reg.exe" && args[0] === "ADD") registry.set(args[1], args[6]);
      if (file === "reg.exe" && args[0] === "QUERY") {
        return { stdout: registry.get(args[1]) ?? "", stderr: "" };
      }
    };
    await installBrowserHost({ hostPath, platform: "win32", localAppData, runCommand });
    assert.equal((await browserHostStatus({ hostPath, platform: "win32", localAppData, runCommand })).installed, true);
    registry.clear();
    const missingRegistry = await browserHostStatus({ hostPath, platform: "win32", localAppData, runCommand });
    assert.equal(missingRegistry.installed, false);
    assert.equal(missingRegistry.missing.some((entry) => entry.includes("NativeMessagingHosts")), true);
  } finally {
    if (previousUsername === undefined) delete process.env.USERNAME;
    else process.env.USERNAME = previousUsername;
  }
});

test("runtime descriptor publication is protected, expiring, and generation fenced", async () => {
  const root = await mkdtemp(join(tmpdir(), "ling-browser-host-runtime-"));
  const path = join(root, "state", "runtime-v1.json");
  const descriptor = createChromeBrowserRuntimeDescriptor({
    port: 43123,
    daemonPid: 42,
    nowMs: 1_000,
    ttlMs: 5_000,
    token: "test-token",
    generation: "generation-a",
  });
  await publishChromeBrowserRuntimeDescriptor(descriptor, path);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(await readChromeBrowserRuntimeDescriptor(path, 2_000), descriptor);
  await assert.rejects(readChromeBrowserRuntimeDescriptor(path, 6_000), /descriptor_expired/);
  assert.equal(await removeChromeBrowserRuntimeDescriptor("generation-b", path), false);
  assert.equal(await removeChromeBrowserRuntimeDescriptor("generation-a", path), true);
});

test("Windows runtime descriptor locks the directory, temporary file, and published file to the current user", async () => {
  const root = await mkdtemp(join(tmpdir(), "ling-browser-host-runtime-win-"));
  const path = join(root, "state", "runtime-v1.json");
  const descriptor = createChromeBrowserRuntimeDescriptor({
    port: 43123,
    token: "test-token",
    generation: "generation-windows",
  });
  const commands = [];
  await publishChromeBrowserRuntimeDescriptor(descriptor, path, {
    platform: "win32",
    username: "ling-test-user",
    runCommand: async (file, args) => { commands.push([file, ...args]); },
  });
  assert.deepEqual(commands, [
    ["icacls.exe", join(root, "state"), "/inheritance:r", "/grant:r", "ling-test-user:(OI)(CI)F"],
    ["icacls.exe", `${path}.coordination.sqlite`, "/inheritance:r", "/grant:r", "ling-test-user:F"],
    ["icacls.exe", `${path}.generation-windows.tmp`, "/inheritance:r", "/grant:r", "ling-test-user:F"],
    ["icacls.exe", path, "/inheritance:r", "/grant:r", "ling-test-user:F"],
  ]);
  assert.deepEqual(await readChromeBrowserRuntimeDescriptor(path), descriptor);
});

test("macOS native Host replaces the linker signature with an explicit ad-hoc signature", {
  skip: process.platform !== "darwin",
}, async () => {
  const hostPath = new URL("../dist/native/ling-browser-host", import.meta.url);
  const metadata = JSON.parse(await readFile(new URL("../dist/native/build-metadata.json", import.meta.url), "utf8"));
  assert.equal(metadata.signing, "adhoc");
  const result = spawnSync("/usr/bin/codesign", ["--display", "--verbose=4", hostPath.pathname], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const details = `${result.stdout}\n${result.stderr}`;
  assert.match(details, /\badhoc\b/u);
  assert.doesNotMatch(details, /linker-signed/u);
});
