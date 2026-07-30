import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { buildCuaDriverSetupView } from "../dist/features/plugins/cua-driver.js";
import { defaultCuaDriverCommandCandidates, resolveCuaDriverCommand } from "../dist/features/plugins/presets.js";

test("Cua Driver detection resolves PATH and explicit executable paths", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "ling-stack-cua-detection-"));
  const command = join(root, process.platform === "win32" ? "cua-driver.exe" : "cua-driver");
  const originalPath = process.env.PATH;
  const originalPathExt = process.env.PATHEXT;
  try {
    await writeFile(command, "#!/bin/sh\nexit 0\n");
    if (process.platform !== "win32") {
      await chmod(command, 0o755);
    }
    process.env.PATH = root;
    if (process.platform === "win32") {
      process.env.PATHEXT = ".EXE";
    }

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
    if (originalPathExt === undefined) {
      delete process.env.PATHEXT;
    } else {
      process.env.PATHEXT = originalPathExt;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("Cua Driver detection rejects non-executable files and directories", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "ling-stack-cua-invalid-"));
  try {
    const file = join(root, process.platform === "win32" ? "cua-driver.txt" : "cua-driver");
    const directory = join(root, "cua-driver-directory");
    await writeFile(file, "not executable\n");
    await mkdir(directory);
    if (process.platform !== "win32") {
      await chmod(directory, 0o755);
    }

    assert.equal(resolveCuaDriverCommand({ command: file }).errorCode, "plugin_command_not_executable");
    assert.equal(resolveCuaDriverCommand({ command: directory }).errorCode, "plugin_command_not_executable");
    const windowsRoot = join(root, "windows");
    await mkdir(windowsRoot);
    const extensionless = join(windowsRoot, "cua-driver");
    const executable = join(windowsRoot, "cua-driver.exe");
    await writeFile(extensionless, "not a Windows executable\n");
    await writeFile(executable, "fixture\n");

    const environment = {
      platform: "win32",
      path: windowsRoot,
      pathExt: ".EXE;.CMD",
      homeDir: windowsRoot,
      localAppData: join(windowsRoot, "local-app-data"),
    };
    assert.deepEqual(resolveCuaDriverCommand({}, environment), {
      ok: true,
      command: executable,
      attempted: [join(windowsRoot, "cua-driver.exe")],
    });
    await rm(executable);
    assert.equal(
      resolveCuaDriverCommand({ command: extensionless }, environment).errorCode,
      "plugin_command_not_executable",
    );
    const commandScript = join(windowsRoot, "cua-driver.cmd");
    await writeFile(commandScript, "@exit /b 0\n");
    assert.equal(
      resolveCuaDriverCommand({ command: commandScript }, {
        ...environment,
        pathExt: ".CMD",
      }).errorCode,
      "plugin_command_not_executable",
    );
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

test("bundled Cua Driver setup carries the canonical locked-control projection", () => {
  const lockedControl = {
    schemaVersion: 1,
    capability: "disabled_by_build",
    phase: "off",
    reason: "locked_control_disabled_by_build",
  };
  const setup = buildCuaDriverSetupView({
    store: {},
    now: "2026-07-31T00:00:00.000Z",
    platform: "darwin",
    projection: {
      schemaVersion: 2,
      distribution: "bundled_embedded",
      providerState: "included",
      requestedEnabled: false,
      effectiveEnabled: false,
      lockedControl,
    },
  });
  assert.deepEqual(setup.lockedControl, lockedControl);
  assert.equal(setup.distribution, "bundled_embedded");
});

test("Cua Driver detection includes system and user macOS app bundles", () => {
  assert.deepEqual(defaultCuaDriverCommandCandidates("/Users/test").slice(-4), [
    "/Applications/CuaDriver.app/Contents/MacOS/cua-driver",
    "/Applications/Cua Driver.app/Contents/MacOS/cua-driver",
    "/Users/test/Applications/CuaDriver.app/Contents/MacOS/cua-driver",
    "/Users/test/Applications/Cua Driver.app/Contents/MacOS/cua-driver",
  ]);
});
