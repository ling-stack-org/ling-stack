import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { buildCuaDriverSetupView } from "../dist/features/plugins/cua-driver.js";
import { defaultCuaDriverCommandCandidates, resolveCuaDriverCommand } from "../dist/features/plugins/presets.js";

test("Cua Driver detection resolves PATH and explicit executable paths", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "ling-stack-cua-detection-"));
  const command = join(root, "cua-driver");
  const originalPath = process.env.PATH;
  try {
    await writeFile(command, "#!/bin/sh\nexit 0\n");
    await chmod(command, 0o755);
    process.env.PATH = root;

    assert.deepEqual(resolveCuaDriverCommand(), {
      ok: true,
      command,
      attempted: [command],
    });
    assert.deepEqual(resolveCuaDriverCommand({ command }), {
      ok: true,
      command,
      attempted: [command],
    });
  } finally {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("Cua Driver detection rejects non-executable files and directories", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "ling-stack-cua-invalid-"));
  try {
    const file = join(root, "cua-driver");
    const directory = join(root, "cua-driver-directory");
    await writeFile(file, "not executable\n");
    await mkdir(directory);
    await chmod(directory, 0o755);

    assert.equal(resolveCuaDriverCommand({ command: file }).errorCode, "plugin_command_not_executable");
    assert.equal(resolveCuaDriverCommand({ command: directory }).errorCode, "plugin_command_not_executable");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Cua Driver setup projection blocks unsupported platforms without probing the store", () => {
  assert.deepEqual(buildCuaDriverSetupView({
    store: {},
    now: "2026-07-13T00:00:00.000Z",
    platform: "linux",
  }), {
    kind: "local_binary",
    state: "unsupported",
    checkedAt: "2026-07-13T00:00:00.000Z",
  });
});

test("Cua Driver detection includes system and user macOS app bundles", () => {
  assert.deepEqual(defaultCuaDriverCommandCandidates("/Users/test").slice(-4), [
    "/Applications/CuaDriver.app/Contents/MacOS/cua-driver",
    "/Applications/Cua Driver.app/Contents/MacOS/cua-driver",
    "/Users/test/Applications/CuaDriver.app/Contents/MacOS/cua-driver",
    "/Users/test/Applications/Cua Driver.app/Contents/MacOS/cua-driver",
  ]);
});
