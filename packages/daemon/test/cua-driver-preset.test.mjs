import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  createCuaDriverDescriptor,
  isCuaDriverPlatformSupported,
  resolveCuaDriverCommand,
} from "../dist/features/plugins/presets.js";

test("Cua Driver preset advertises the selected macOS and Windows provider boundary", () => {
  const descriptor = createCuaDriverDescriptor();
  assert.equal(isCuaDriverPlatformSupported("darwin"), true);
  assert.equal(isCuaDriverPlatformSupported("win32"), true);
  assert.equal(isCuaDriverPlatformSupported("linux"), false);
  assert.deepEqual(descriptor.contributions[0].capabilities, [
    "mcp:stdio",
    "computer-use:macos",
    "computer-use:windows",
  ]);
});

test("Cua Driver command resolution honors PATHEXT for the Windows provider", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "ling-cua-driver-windows-path-"));
  const executable = join(root, "cua-driver.exe");
  await writeFile(executable, "windows-provider-fixture\n");
  await chmod(executable, 0o755);
  try {
    const resolution = resolveCuaDriverCommand({}, {
      platform: "win32",
      path: root,
      pathExt: ".EXE;.CMD",
      homeDir: root,
      localAppData: join(root, "LocalAppData"),
    });
    assert.equal(resolution.ok, true);
    assert.equal(resolution.command, executable);
    assert.equal(resolution.attempted.includes(executable), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Cua Driver command resolution knows the official Windows install location", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "ling-cua-driver-windows-install-"));
  const localAppData = join(root, "LocalAppData");
  const executable = join(
    localAppData,
    "Programs",
    "Cua",
    "cua-driver",
    "bin",
    "cua-driver.exe",
  );
  await mkdir(resolve(executable, ".."), { recursive: true });
  await writeFile(executable, "windows-provider-fixture\n");
  await chmod(executable, 0o755);
  try {
    const resolution = resolveCuaDriverCommand({}, {
      platform: "win32",
      path: "",
      homeDir: root,
      localAppData,
    });
    assert.equal(resolution.ok, true);
    assert.equal(resolution.command, executable);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
